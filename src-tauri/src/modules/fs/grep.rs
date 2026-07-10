use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher as _;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::to_canon;
use crate::modules::remote;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;

/// Supersession counter for interactive content search. Each new interactive
/// query bumps the generation; in-flight walks observe the change and quit,
/// so fast typing stops superseded searches server-side instead of letting
/// them run to completion.
#[derive(Default)]
pub struct ContentSearchState {
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
pub struct GrepHit {
    pub path: String,
    pub rel: String,
    pub line: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct GrepResponse {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("bad glob {p:?}: {e}"))?;
        b.add(g);
    }
    let set = b.build().map_err(|e| format!("globset build: {e}"))?;
    Ok(Some(set))
}

fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn search_tree(
    root_path: &Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
    matcher: &RegexMatcher,
    globs: &Option<GlobSet>,
    cap: usize,
    cancel: &(dyn Fn() -> bool + Sync),
) -> GrepResponse {
    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build_parallel();

    let hits: Arc<Mutex<Vec<GrepHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    walker.run(|| {
        let matcher = matcher.clone();
        let globs = globs.clone();
        let hits = hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.to_path_buf();
        let root_display = root_display.to_string();
        let workspace = workspace.clone();

        Box::new(move |dent_res| {
            if truncated.load(Ordering::Relaxed) || cancel() {
                return WalkState::Quit;
            }
            let dent = match dent_res {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => return WalkState::Continue,
            };
            if let Some(set) = globs.as_ref() {
                if !set.is_match(&rel) {
                    return WalkState::Continue;
                }
            }
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }

            scanned.fetch_add(1, Ordering::Relaxed);

            let abs = display_path(path, &root_path, &root_display, &workspace);
            let rel_clone = rel.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();

            let _ = searcher.search_path(
                &matcher,
                path,
                UTF8(|line_num, text| {
                    let line_text = text.trim_end_matches('\n').to_string();
                    let mut guard = hits.lock().unwrap();
                    if guard.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    guard.push(GrepHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        text: line_text,
                    });
                    Ok(true)
                }),
            );

            WalkState::Continue
        })
    });

    let final_hits = Arc::try_unwrap(hits)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    GrepResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub async fn fs_grep(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let cap = max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, HARD_MAX_RESULTS);
        let globs_input = glob.as_deref().unwrap_or(&[]);
        if let Some(response) = search_remote_rg(
            profile_id,
            &root,
            &pattern,
            globs_input,
            case_insensitive.unwrap_or(false),
            false,
            cap,
        )
        .await?
        {
            return Ok(response);
        }
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(case_insensitive.unwrap_or(false))
            .line_terminator(Some(b'\n'))
            .build(&pattern)
            .map_err(|e| format!("bad regex: {e}"))?;
        let globs = build_globset(globs_input)?;
        return search_remote_sftp(profile_id, &root, &matcher, &globs, cap, &|| false).await;
    }
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let globs = build_globset(glob.as_deref().unwrap_or(&[]))?;

    Ok(search_tree(
        &root_path,
        &root,
        &workspace,
        &matcher,
        &globs,
        cap,
        &|| false,
    ))
}

/// Interactive content search for the command palette. Treats the query as a
/// literal (smart-case), and self-cancels when a newer query arrives.
#[tauri::command]
pub async fn fs_grep_interactive(
    state: tauri::State<'_, ContentSearchState>,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    if pattern.trim().is_empty() {
        return Err("empty pattern".into());
    }
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let cap = max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, HARD_MAX_RESULTS);
        if let Some(response) =
            search_remote_rg(profile_id, &root, &pattern, &[], false, true, cap).await?
        {
            if state.generation.load(Ordering::SeqCst) != my_gen {
                return Ok(GrepResponse {
                    hits: Vec::new(),
                    truncated: false,
                    files_scanned: 0,
                });
            }
            return Ok(response);
        }
        let matcher = RegexMatcherBuilder::new()
            .case_smart(true)
            .line_terminator(Some(b'\n'))
            .build(&escape_literal(&pattern))
            .map_err(|e| format!("bad pattern: {e}"))?;
        let cancel = || state.generation.load(Ordering::SeqCst) != my_gen;
        return search_remote_sftp(profile_id, &root, &matcher, &None, cap, &cancel).await;
    }
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let matcher = RegexMatcherBuilder::new()
        .case_smart(true)
        .line_terminator(Some(b'\n'))
        .build(&escape_literal(&pattern))
        .map_err(|e| format!("bad pattern: {e}"))?;

    let cancel = || state.generation.load(Ordering::SeqCst) != my_gen;
    Ok(search_tree(
        &root_path, &root, &workspace, &matcher, &None, cap, &cancel,
    ))
}

#[derive(Serialize)]
pub struct GlobHit {
    pub path: String,
    pub rel: String,
}

#[derive(Serialize)]
pub struct GlobResponse {
    pub hits: Vec<GlobHit>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn fs_glob(
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GlobResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let cap = max_results.unwrap_or(500).clamp(1, HARD_MAX_RESULTS);
        if let Some(response) = glob_remote_rg(profile_id, &root, &pattern, cap).await? {
            return Ok(response);
        }
        let glob = Glob::new(&pattern).map_err(|e| format!("bad glob: {e}"))?;
        let mut builder = GlobSetBuilder::new();
        builder.add(glob);
        let set = builder.build().map_err(|e| format!("globset build: {e}"))?;
        let manager = remote::manager::global_manager()?;
        let workspace = manager.workspace(profile_id).await?;
        let (entries, mut truncated) =
            remote::sftp::walk(&workspace, &root, false, 16, 50_000).await?;
        let mut hits = Vec::new();
        for entry in entries {
            if entry.kind != remote::sftp::RemoteEntryKind::File || !set.is_match(&entry.rel) {
                continue;
            }
            if hits.len() >= cap {
                truncated = true;
                break;
            }
            hits.push(GlobHit {
                path: entry.path,
                rel: entry.rel,
            });
        }
        return Ok(GlobResponse { hits, truncated });
    }
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results.unwrap_or(500).clamp(1, HARD_MAX_RESULTS);

    let glob = Glob::new(&pattern).map_err(|e| format!("bad glob: {e}"))?;
    let mut gb = GlobSetBuilder::new();
    gb.add(glob);
    let set = gb.build().map_err(|e| format!("globset build: {e}"))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut hits: Vec<GlobHit> = Vec::new();
    let mut truncated = false;
    for dent in walker.flatten() {
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if !set.is_match(&rel) {
            continue;
        }
        hits.push(GlobHit {
            path: display_path(path, &root_path, &root, &workspace),
            rel,
        });
    }

    Ok(GlobResponse { hits, truncated })
}

async fn search_remote_sftp(
    profile_id: &str,
    root: &str,
    matcher: &RegexMatcher,
    globs: &Option<GlobSet>,
    cap: usize,
    cancel: &(dyn Fn() -> bool + Sync),
) -> Result<GrepResponse, String> {
    let manager = remote::manager::global_manager()?;
    let workspace = manager.workspace(profile_id).await?;
    let (entries, mut truncated) = remote::sftp::walk(&workspace, root, false, 16, 50_000).await?;
    let mut hits = Vec::new();
    let mut files_scanned = 0usize;
    for entry in entries {
        if cancel() {
            break;
        }
        if entry.kind != remote::sftp::RemoteEntryKind::File || entry.size > FILE_SIZE_CAP {
            continue;
        }
        if globs.as_ref().is_some_and(|set| !set.is_match(&entry.rel)) {
            continue;
        }
        let bytes = match remote::sftp::read_file(&workspace, &entry.path, FILE_SIZE_CAP).await {
            Ok(bytes) if !bytes.iter().take(8192).any(|byte| *byte == 0) => bytes,
            _ => continue,
        };
        files_scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            if matcher.is_match(line.as_bytes()).unwrap_or(false) {
                if hits.len() >= cap {
                    truncated = true;
                    break;
                }
                hits.push(GrepHit {
                    path: entry.path.clone(),
                    rel: entry.rel.clone(),
                    line: index as u64 + 1,
                    text: line.to_string(),
                });
            }
        }
        if hits.len() >= cap {
            break;
        }
    }
    Ok(GrepResponse {
        hits,
        truncated,
        files_scanned,
    })
}

#[allow(clippy::too_many_arguments)]
async fn search_remote_rg(
    profile_id: &str,
    root: &str,
    pattern: &str,
    globs: &[String],
    case_insensitive: bool,
    fixed_smart_case: bool,
    cap: usize,
) -> Result<Option<GrepResponse>, String> {
    let mut args = vec![
        "rg".to_string(),
        "--json".to_string(),
        "--no-messages".to_string(),
        "--max-filesize".to_string(),
        FILE_SIZE_CAP.to_string(),
    ];
    if case_insensitive {
        args.push("--ignore-case".into());
    }
    if fixed_smart_case {
        args.push("--fixed-strings".into());
        args.push("--smart-case".into());
    }
    for glob in globs {
        args.push("--glob".into());
        args.push(glob.clone());
    }
    args.push("--".into());
    args.push(pattern.to_string());
    args.push(root.to_string());
    let command = remote_rg_command(&args);
    let manager = remote::manager::global_manager()?;
    let output = manager
        .exec(
            profile_id,
            &command,
            None,
            std::time::Duration::from_secs(30),
        )
        .await?;
    if output.timed_out {
        return Err("remote ripgrep search timed out".into());
    }
    match output.exit_code {
        Some(127) => return Ok(None),
        Some(0 | 1) => {}
        Some(code) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("remote ripgrep failed with exit code {code}")
            } else {
                format!("remote ripgrep failed: {detail}")
            });
        }
        None => return Err("remote ripgrep closed without an exit status".into()),
    }
    parse_remote_rg(&output.stdout, root, cap, output.truncated).map(Some)
}

async fn glob_remote_rg(
    profile_id: &str,
    root: &str,
    pattern: &str,
    cap: usize,
) -> Result<Option<GlobResponse>, String> {
    let args = vec![
        "rg".to_string(),
        "--files".to_string(),
        "--null".to_string(),
        "--no-messages".to_string(),
        "--glob".to_string(),
        pattern.to_string(),
        "--".to_string(),
        root.to_string(),
    ];
    let manager = remote::manager::global_manager()?;
    let output = manager
        .exec(
            profile_id,
            &remote_rg_command(&args),
            None,
            std::time::Duration::from_secs(30),
        )
        .await?;
    if output.timed_out {
        return Err("remote ripgrep file listing timed out".into());
    }
    match output.exit_code {
        Some(127) => return Ok(None),
        Some(0 | 1) => {}
        Some(code) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("remote ripgrep file listing failed with exit code {code}")
            } else {
                format!("remote ripgrep file listing failed: {detail}")
            });
        }
        None => return Err("remote ripgrep file listing closed without an exit status".into()),
    }
    let mut hits = Vec::new();
    let mut truncated = output.truncated;
    let chunks: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    for (index, bytes) in chunks.iter().enumerate() {
        if bytes.is_empty() {
            continue;
        }
        if output.truncated && index + 1 == chunks.len() && !output.stdout.ends_with(&[0]) {
            truncated = true;
            break;
        }
        if hits.len() >= cap {
            truncated = true;
            break;
        }
        let path = String::from_utf8_lossy(bytes).to_string();
        let absolute = remote_absolute(root, &path);
        hits.push(GlobHit {
            rel: remote_relative(root, &absolute),
            path: absolute,
        });
    }
    Ok(Some(GlobResponse { hits, truncated }))
}

fn remote_rg_command(args: &[String]) -> String {
    let command = args
        .iter()
        .map(|argument| remote::session::shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    format!("command -v rg >/dev/null 2>&1 || exit 127; exec {command}")
}

fn parse_remote_rg(
    stdout: &[u8],
    root: &str,
    cap: usize,
    output_truncated: bool,
) -> Result<GrepResponse, String> {
    let text = String::from_utf8_lossy(stdout);
    let lines: Vec<&str> = text.lines().collect();
    let mut hits = Vec::new();
    let mut total_matches = 0usize;
    let mut files_scanned = 0usize;
    for (index, line) in lines.iter().enumerate() {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) if output_truncated && index + 1 == lines.len() => break,
            Err(error) => return Err(format!("parse remote ripgrep JSON: {error}")),
        };
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("end") => files_scanned += 1,
            Some("match") => {
                total_matches += 1;
                if hits.len() >= cap {
                    continue;
                }
                let data = &value["data"];
                let Some(path) = data["path"]["text"].as_str() else {
                    continue;
                };
                let Some(line_number) = data["line_number"].as_u64() else {
                    continue;
                };
                let Some(line_text) = data["lines"]["text"].as_str() else {
                    continue;
                };
                let absolute = remote_absolute(root, path);
                hits.push(GrepHit {
                    rel: remote_relative(root, &absolute),
                    path: absolute,
                    line: line_number,
                    text: line_text.trim_end_matches(['\r', '\n']).to_string(),
                });
            }
            _ => {}
        }
    }
    Ok(GrepResponse {
        truncated: output_truncated || total_matches > cap,
        hits,
        files_scanned,
    })
}

fn remote_absolute(root: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        remote::session::join_remote(root, path)
    }
}

fn remote_relative(root: &str, path: &str) -> String {
    let root = root.trim_end_matches('/');
    if path == root {
        return String::new();
    }
    path.strip_prefix(root)
        .and_then(|relative| relative.strip_prefix('/'))
        .unwrap_or(path)
        .to_string()
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

    #[test]
    fn escape_literal_escapes_regex_meta() {
        assert_eq!(escape_literal("a.b(c)"), "a\\.b\\(c\\)");
        assert_eq!(escape_literal("plain text"), "plain text");
    }

    #[test]
    fn parses_remote_ripgrep_json_with_limits() {
        let output = concat!(
            "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"/home/me/a.txt\"},\"lines\":{\"text\":\"first\\n\"},\"line_number\":2}}\n",
            "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"/home/me/b.txt\"},\"lines\":{\"text\":\"second\\n\"},\"line_number\":4}}\n",
            "{\"type\":\"end\",\"data\":{}}\n"
        );
        let parsed = parse_remote_rg(output.as_bytes(), "/home/me", 1, false).unwrap();
        assert_eq!(parsed.hits.len(), 1);
        assert_eq!(parsed.hits[0].rel, "a.txt");
        assert_eq!(parsed.hits[0].text, "first");
        assert!(parsed.truncated);
        assert_eq!(parsed.files_scanned, 1);
    }

    #[test]
    fn search_tree_respects_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello\nfind me here\n").unwrap();
        let matcher = RegexMatcherBuilder::new().build("find").unwrap();
        let ws = WorkspaceEnv::from_option(None);
        let root_display = dir.path().to_string_lossy().to_string();

        let live = search_tree(
            dir.path(),
            &root_display,
            &ws,
            &matcher,
            &None,
            100,
            &|| false,
        );
        assert_eq!(live.hits.len(), 1, "uncancelled search finds the match");

        let stopped = search_tree(
            dir.path(),
            &root_display,
            &ws,
            &matcher,
            &None,
            100,
            &|| true,
        );
        assert!(stopped.hits.is_empty(), "cancelled search yields nothing");
    }
}
