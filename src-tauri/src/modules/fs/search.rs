//! 工作区路径枚举与模糊搜索。
//!
//! Explorer 搜索保持跨环境路径语义；SSH 递归枚举统一进入远端树服务，交互式模糊
//! 搜索会取消上一条本地遍历或远端 exec。

use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::to_canon;
use crate::modules::remote;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

#[derive(Serialize, Clone)]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// True if the scan stopped early (entry budget or hit cap reached).
    pub truncated: bool,
}

/// Hard cap on entries the walker is allowed to visit before bailing. Protects
/// against pathological roots like $HOME where there's no .gitignore and the
/// tree is effectively unbounded.
const MAX_SCANNED: usize = 50_000;

/// Directory names pruned unconditionally — they're rarely useful in a
/// file-explorer search and they dominate scan time when present.
const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

/// Explorer 唯一路径搜索面的取消状态。
#[derive(Default)]
pub struct PathSearchState {
    generation: AtomicU64,
    active_remote: Mutex<Option<(u64, CancellationToken)>>,
}

impl PathSearchState {
    fn begin(&self) -> (u64, CancellationToken) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let cancellation = CancellationToken::new();
        let mut active = self
            .active_remote
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, previous)) = active.replace((generation, cancellation.clone())) {
            previous.cancel();
        }
        (generation, cancellation)
    }

    fn finish(&self, generation: u64) {
        let mut active = self
            .active_remote
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
        {
            *active = None;
        }
    }
}

/// 执行 Explorer 交互式路径搜索，并取消上一条尚未完成的请求。
#[tauri::command]
pub async fn fs_search(
    state: tauri::State<'_, PathSearchState>,
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    let (generation, cancellation) = state.begin();
    let result = search_paths_with_cancel(
        root,
        query,
        limit,
        workspace,
        show_hidden,
        Some(&cancellation),
    )
    .await;
    state.finish(generation);
    if cancellation.is_cancelled() {
        Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        })
    } else {
        result
    }
}

/// 执行不参与交互式取消的路径搜索，供测试和内部调用复用。
pub async fn search_paths(
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    search_paths_with_cancel(root, query, limit, workspace, show_hidden, None).await
}

async fn search_paths_with_cancel(
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
    cancellation: Option<&CancellationToken>,
) -> Result<SearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let cap = limit.unwrap_or(200).min(1000);
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let (entries, truncated) = remote_walk(
            profile_id,
            &root,
            show_hidden,
            16,
            MAX_SCANNED,
            cancellation,
        )
        .await?;
        let candidates = entries
            .into_iter()
            .map(|entry| SearchHit {
                path: entry.path,
                rel: entry.rel,
                name: entry.name,
                is_dir: entry.kind == remote::sftp::RemoteEntryKind::Dir,
            })
            .collect();
        return Ok(SearchResult {
            hits: rank_fuzzy(candidates, q, cap),
            truncated,
        });
    }
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let mut cands: Vec<SearchHit> = Vec::new();
    let mut scanned: usize = 0;
    let mut truncated = false;

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .filter_entry(|dent| {
            // Prune known-heavy dirs even when no .gitignore is present (e.g.
            // searching from $HOME).
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    for dent in walker.flatten() {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(crate::modules::remote::session::EXEC_CANCELLED_ERROR.into());
        }
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        cands.push(SearchHit {
            path: display_path(path, &root_path, &root, &workspace),
            rel,
            name,
            is_dir,
        });
    }

    let hits = rank_fuzzy(cands, q, cap);
    Ok(SearchResult { hits, truncated })
}

/// Fuzzy-rank candidates against the query (path-aware, smart-case), keeping
/// the top `cap`. Ties break toward shorter relative paths.
fn rank_fuzzy(cands: Vec<SearchHit>, query: &str, cap: usize) -> Vec<SearchHit> {
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();

    let mut scored = Vec::with_capacity(cands.len());
    for (i, c) in cands.iter().enumerate() {
        if let Some(s) = pattern.score(Utf32Str::new(&c.rel, &mut buf), &mut matcher) {
            scored.push((s, i));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| cands[a.1].rel.len().cmp(&cands[b.1].rel.len()))
    });
    scored
        .into_iter()
        .take(cap)
        .map(|(_, i)| cands[i].clone())
        .collect()
}

async fn remote_walk(
    profile_id: &str,
    root: &str,
    show_hidden: bool,
    depth: usize,
    cap: usize,
    cancellation: Option<&CancellationToken>,
) -> Result<(Vec<remote::sftp::RemoteWalkEntry>, bool), String> {
    let manager = remote::manager::global_manager()?;
    let workspace = manager.workspace(profile_id).await?;
    remote::tree_service::walk_cancellable(&workspace, root, show_hidden, depth, cap, cancellation)
        .await
}

fn display_path(
    path: &std::path::Path,
    root_path: &std::path::Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
) -> String {
    if workspace.is_wsl() {
        if let Ok(rel) = path.strip_prefix(root_path) {
            let rel = to_canon(rel);
            return if rel.is_empty() {
                root_display.to_string()
            } else if root_display.ends_with('/') {
                format!("{root_display}{rel}")
            } else {
                format!("{root_display}/{rel}")
            };
        }
    }
    to_canon(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(rel: &str) -> SearchHit {
        SearchHit {
            path: rel.to_string(),
            rel: rel.to_string(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            is_dir: false,
        }
    }

    #[test]
    fn rank_fuzzy_prefers_name_and_shorter_path() {
        let cands = vec![
            hit("src/deeply/nested/config.rs"),
            hit("config.rs"),
            hit("src/main.rs"),
        ];
        let out = rank_fuzzy(cands, "config", 10);
        assert_eq!(out[0].rel, "config.rs");
        assert!(!out.iter().any(|h| h.rel == "src/main.rs"));
    }

    #[test]
    fn rank_fuzzy_matches_subsequence() {
        let cands = vec![hit("CommandPalette.tsx"), hit("readme.md")];
        let out = rank_fuzzy(cands, "cmdp", 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel, "CommandPalette.tsx");
    }

    #[test]
    fn newer_path_search_cancels_the_previous_token() {
        let state = PathSearchState::default();
        let (first_generation, first) = state.begin();
        let (second_generation, second) = state.begin();

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        state.finish(first_generation);
        assert!(state
            .active_remote
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(generation, _)| *generation == second_generation));
        state.finish(second_generation);
        assert!(state.active_remote.lock().unwrap().is_none());
    }
}
