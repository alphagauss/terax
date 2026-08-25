//! 工作区文件内容搜索与路径 glob 匹配。
//!
//! 内容搜索由用户侧边栏和 AI grep 共享，统一处理匹配语义、ignore、结果上限与远端回退；
//! 交互式调用可取消上一轮扫描，但不会取消并发的 AI 搜索。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher as _;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::to_canon;
use crate::modules::remote;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;

/// 搜索面板交互请求的取消状态。
///
/// 每次新查询推进 generation，正在扫描的旧查询观察到变化后尽快退出；AI 查询不使用此状态。
#[derive(Default)]
pub struct ContentSearchState {
    generation: Arc<AtomicU64>,
    active_remote: Mutex<Option<(u64, CancellationToken)>>,
}

impl ContentSearchState {
    /// 安装当前交互式搜索 token，并立即取消上一条远端命令。
    fn replace_remote_cancellation(&self, generation: u64) -> CancellationToken {
        let cancellation = CancellationToken::new();
        let mut active = self
            .active_remote
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, previous)) = active.replace((generation, cancellation.clone())) {
            previous.cancel();
        }
        cancellation
    }

    /// 仅清理仍属于指定 generation 的远端 token。
    fn finish_remote_cancellation(&self, generation: u64) {
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

/// 内容搜索的查询语法。
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentSearchSyntax {
    /// 将查询作为普通文本处理。
    Literal,
    /// 将查询作为 Rust ripgrep 正则处理。
    Regex,
}

/// 内容搜索的大小写模式。
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentSearchCaseMode {
    /// 区分大小写。
    Sensitive,
    /// 忽略大小写。
    Insensitive,
}

/// 用户搜索面板与 AI grep 共用的内容搜索请求。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchRequest {
    /// 搜索根目录。
    pub root: String,
    /// 查询文本或正则表达式。
    pub pattern: String,
    /// 查询语法。
    pub syntax: ContentSearchSyntax,
    /// 大小写模式。
    pub case_mode: ContentSearchCaseMode,
    /// 是否只接受完整单词匹配。
    pub whole_word: bool,
    /// 相对根目录的包含 glob。
    #[serde(default)]
    pub includes: Vec<String>,
    /// 相对根目录的排除 glob。
    #[serde(default)]
    pub excludes: Vec<String>,
    /// 返回结果上限，后端仍会约束到硬上限。
    pub max_results: Option<usize>,
    /// 是否取消上一轮搜索面板请求。
    #[serde(default)]
    pub cancel_previous: bool,
    /// 进程启动时固定的工作区环境。
    pub workspace: Option<WorkspaceEnv>,
}

/// 匹配文本在结果行中的 UTF-16 半开区间。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    /// 起始 UTF-16 偏移。
    pub start: usize,
    /// 结束 UTF-16 偏移。
    pub end: usize,
}

/// 单个文件行的内容搜索结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchHit {
    /// 工作区环境内的绝对路径。
    pub path: String,
    /// 相对于搜索根目录的规范路径。
    pub rel: String,
    /// 从一开始计数的行号。
    pub line: u64,
    /// 匹配所在的完整文本行。
    pub text: String,
    /// 该行内所有非重叠匹配区间。
    pub ranges: Vec<MatchRange>,
}

/// 一次内容搜索的有界响应。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResponse {
    /// 按路径和行号排序的匹配结果。
    pub hits: Vec<ContentSearchHit>,
    /// 是否因结果或传输上限截断。
    pub truncated: bool,
    /// 实际读取并检查的文件数量。
    pub files_scanned: usize,
}

fn empty_content_search_response() -> ContentSearchResponse {
    ContentSearchResponse {
        hits: Vec::new(),
        truncated: false,
        files_scanned: 0,
    }
}

/// 预编译的包含与排除路径规则。
#[derive(Clone)]
struct PathFilters {
    includes: Option<GlobSet>,
    excludes: Option<GlobSet>,
}

impl PathFilters {
    fn matches(&self, path: &str) -> bool {
        self.includes.as_ref().is_none_or(|set| set.is_match(path))
            && !self.excludes.as_ref().is_some_and(|set| set.is_match(path))
    }
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

/// 将包含与排除 glob 分别编译，保证排除规则始终优先。
fn build_path_filters(includes: &[String], excludes: &[String]) -> Result<PathFilters, String> {
    Ok(PathFilters {
        includes: build_globset(includes)?,
        excludes: build_globset(excludes)?,
    })
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

/// 按统一请求构造本地与 SFTP 回退共用的 ripgrep matcher。
fn build_matcher(request: &ContentSearchRequest) -> Result<RegexMatcher, String> {
    let pattern = match request.syntax {
        ContentSearchSyntax::Literal => escape_literal(&request.pattern),
        ContentSearchSyntax::Regex => request.pattern.clone(),
    };
    let mut builder = RegexMatcherBuilder::new();
    builder
        .case_insensitive(matches!(
            request.case_mode,
            ContentSearchCaseMode::Insensitive
        ))
        .word(request.whole_word)
        .line_terminator(Some(b'\n'));
    builder
        .build(&pattern)
        .map_err(|error| format!("invalid regular expression: {error}"))
}

/// 将 UTF-8 字节偏移转换为前端字符串使用的 UTF-16 偏移。
fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    text.get(..byte_offset)
        .map(|prefix| prefix.encode_utf16().count())
        .unwrap_or_default()
}

/// 收集单行内所有非重叠匹配，供搜索结果高亮使用。
fn match_ranges(matcher: &RegexMatcher, text: &str) -> Vec<MatchRange> {
    let mut ranges = Vec::new();
    let _ = matcher.find_iter(text.as_bytes(), |matched| {
        ranges.push(MatchRange {
            start: utf16_offset(text, matched.start()),
            end: utf16_offset(text, matched.end()),
        });
        true
    });
    ranges
}

#[allow(clippy::too_many_arguments)]
/// 并行扫描本地或 WSL 文件树，并在命中上限或取消时尽快停止。
fn search_tree(
    root_path: &Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
    matcher: &RegexMatcher,
    filters: &PathFilters,
    cap: usize,
    cancel: &(dyn Fn() -> bool + Sync),
) -> ContentSearchResponse {
    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build_parallel();

    let hits: Arc<Mutex<Vec<ContentSearchHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    walker.run(|| {
        let matcher = matcher.clone();
        let filters = filters.clone();
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
            if !filters.matches(&rel) {
                return WalkState::Continue;
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
                    let line_text = text.trim_end_matches(['\r', '\n']).to_string();
                    let ranges = match_ranges(&matcher, &line_text);
                    let mut guard = hits.lock().unwrap();
                    if guard.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    guard.push(ContentSearchHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        ranges,
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

    let mut final_hits = final_hits;
    final_hits.sort_by(|left, right| {
        left.rel
            .cmp(&right.rel)
            .then_with(|| left.line.cmp(&right.line))
    });

    ContentSearchResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    }
}

/// 使用统一请求执行一次内容搜索，不启用交互式取消。
///
/// 测试和非 Tauri 调用使用此入口；UI 与 AI 的 IPC 统一经过 `fs_content_search`。
pub async fn search_content(
    request: ContentSearchRequest,
) -> Result<ContentSearchResponse, String> {
    search_content_with_cancel(request, &|| false, None).await
}

/// 执行统一搜索流程，并把调用方取消信号传入本地或远端回退扫描。
async fn search_content_with_cancel(
    request: ContentSearchRequest,
    cancel: &(dyn Fn() -> bool + Sync),
    remote_cancellation: Option<&CancellationToken>,
) -> Result<ContentSearchResponse, String> {
    if request.pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let workspace = WorkspaceEnv::from_option(request.workspace.clone());
    let cap = request
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);
    let matcher = build_matcher(&request)?;
    let filters = build_path_filters(&request.includes, &request.excludes)?;
    if let Some(profile_id) = workspace.ssh_profile_id() {
        if let Some(response) = search_remote_rg(
            profile_id,
            &request.root,
            &request,
            cap,
            remote_cancellation,
        )
        .await?
        {
            return if cancel() {
                Ok(empty_content_search_response())
            } else {
                Ok(response)
            };
        }
        return search_remote_sftp(profile_id, &request.root, &matcher, &filters, cap, cancel)
            .await;
    }
    let root_path = resolve_path(&request.root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {}", request.root));
    }

    Ok(search_tree(
        &root_path,
        &request.root,
        &workspace,
        &matcher,
        &filters,
        cap,
        cancel,
    ))
}

/// 执行 UI 与 AI 共用的工作区内容搜索。
///
/// `cancelPrevious` 只供唯一的搜索面板使用；AI 并发查询不会推进 generation，
/// 因而不会互相取消或被用户输入取消。
#[tauri::command]
pub async fn fs_content_search(
    state: tauri::State<'_, ContentSearchState>,
    request: ContentSearchRequest,
) -> Result<ContentSearchResponse, String> {
    if !request.cancel_previous {
        return search_content(request).await;
    }
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let cancellation = state.replace_remote_cancellation(my_gen);
    if request.pattern.is_empty() {
        state.finish_remote_cancellation(my_gen);
        return Ok(empty_content_search_response());
    }
    let cancel =
        || cancellation.is_cancelled() || state.generation.load(Ordering::SeqCst) != my_gen;
    let result = search_content_with_cancel(request, &cancel, Some(&cancellation)).await;
    state.finish_remote_cancellation(my_gen);
    if cancellation.is_cancelled() {
        Ok(empty_content_search_response())
    } else {
        result
    }
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
        let manager = remote::manager::global_manager()?;
        let workspace = manager.workspace(profile_id).await?;
        let (entries, truncated) =
            remote::tree_service::list_files(&workspace, &root, Some(&pattern), false, 16, cap)
                .await?;
        let hits = entries
            .into_iter()
            .map(|entry| GlobHit {
                path: entry.path,
                rel: entry.rel,
            })
            .collect();
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
    filters: &PathFilters,
    cap: usize,
    cancel: &(dyn Fn() -> bool + Sync),
) -> Result<ContentSearchResponse, String> {
    let manager = remote::manager::global_manager()?;
    let workspace = manager.workspace(profile_id).await?;
    let (entries, mut truncated) =
        remote::tree_service::walk(&workspace, root, false, 16, 50_000).await?;
    let mut hits = Vec::new();
    let mut files_scanned = 0usize;
    for entry in entries {
        if cancel() {
            break;
        }
        if entry.kind != remote::sftp::RemoteEntryKind::File || entry.size > FILE_SIZE_CAP {
            continue;
        }
        if !filters.matches(&entry.rel) {
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
                hits.push(ContentSearchHit {
                    path: entry.path.clone(),
                    rel: entry.rel.clone(),
                    line: index as u64 + 1,
                    ranges: match_ranges(matcher, line),
                    text: line.to_string(),
                });
            }
        }
        if hits.len() >= cap {
            break;
        }
    }
    hits.sort_by(|left, right| {
        left.rel
            .cmp(&right.rel)
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(ContentSearchResponse {
        hits,
        truncated,
        files_scanned,
    })
}

/// 使用当前 SSH epoch 的集中式 ripgrep 任务执行内容搜索。
async fn search_remote_rg(
    profile_id: &str,
    root: &str,
    request: &ContentSearchRequest,
    cap: usize,
    cancellation: Option<&CancellationToken>,
) -> Result<Option<ContentSearchResponse>, String> {
    const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
    let args = remote_content_search_args(root, request);
    let command = remote::tasks::ripgrep_command(&args);
    let manager = remote::manager::global_manager()?;
    let workspace = manager.workspace(profile_id).await?;
    let task = remote::tasks::TaskKind::Ripgrep;
    if !workspace.tasks.should_attempt(task) {
        return Ok(None);
    }
    let output = match cancellation {
        Some(cancellation) => {
            workspace
                .tasks
                .run_cancellable(
                    &workspace,
                    task,
                    &command,
                    std::time::Duration::from_secs(30),
                    OUTPUT_LIMIT,
                    cancellation,
                )
                .await?
        }
        None => {
            workspace
                .tasks
                .run(
                    &workspace,
                    task,
                    &command,
                    None,
                    std::time::Duration::from_secs(30),
                    OUTPUT_LIMIT,
                )
                .await?
        }
    };
    if output.timed_out {
        return Err("remote ripgrep search timed out".into());
    }
    match output.exit_code {
        Some(127) => {
            workspace
                .tasks
                .mark_unavailable(task, "ripgrep unavailable");
            return Ok(None);
        }
        Some(0 | 1) => workspace.tasks.mark_available(task),
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

/// 构造远端 ripgrep 参数，保持本地 matcher 与 SSH 快速路径的选项一致。
fn remote_content_search_args(root: &str, request: &ContentSearchRequest) -> Vec<String> {
    let mut args = vec![
        "rg".to_string(),
        "--json".to_string(),
        "--no-messages".to_string(),
        "--max-filesize".to_string(),
        FILE_SIZE_CAP.to_string(),
    ];
    if matches!(request.case_mode, ContentSearchCaseMode::Insensitive) {
        args.push("--ignore-case".into());
    }
    if matches!(request.syntax, ContentSearchSyntax::Literal) {
        args.push("--fixed-strings".into());
    }
    if request.whole_word {
        args.push("--word-regexp".into());
    }
    for glob in &request.includes {
        args.push("--glob".into());
        args.push(glob.clone());
    }
    for glob in &request.excludes {
        args.push("--glob".into());
        args.push(format!("!{glob}"));
    }
    args.push("--".into());
    args.push(request.pattern.clone());
    args.push(root.to_string());
    args
}

fn parse_remote_rg(
    stdout: &[u8],
    root: &str,
    cap: usize,
    output_truncated: bool,
) -> Result<ContentSearchResponse, String> {
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
                let ranges = data["submatches"]
                    .as_array()
                    .map(|matches| {
                        matches
                            .iter()
                            .filter_map(|matched| {
                                let start = matched["start"].as_u64()? as usize;
                                let end = matched["end"].as_u64()? as usize;
                                Some(MatchRange {
                                    start: utf16_offset(line_text, start),
                                    end: utf16_offset(line_text, end),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                hits.push(ContentSearchHit {
                    rel: remote_relative(root, &absolute),
                    path: absolute,
                    line: line_number,
                    ranges,
                    text: line_text.trim_end_matches(['\r', '\n']).to_string(),
                });
            }
            _ => {}
        }
    }
    hits.sort_by(|left, right| {
        left.rel
            .cmp(&right.rel)
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(ContentSearchResponse {
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
    fn remote_content_search_args_preserve_shared_options() {
        let request = ContentSearchRequest {
            root: "/repo".into(),
            pattern: "needle".into(),
            syntax: ContentSearchSyntax::Literal,
            case_mode: ContentSearchCaseMode::Insensitive,
            whole_word: true,
            includes: vec!["src/**".into()],
            excludes: vec!["generated/**".into()],
            max_results: Some(50),
            cancel_previous: false,
            workspace: None,
        };
        let args = remote_content_search_args("/repo", &request);

        assert!(args.contains(&"--fixed-strings".to_string()));
        assert!(args.contains(&"--ignore-case".to_string()));
        assert!(args.contains(&"--word-regexp".to_string()));
        assert!(args.windows(2).any(|pair| pair == ["--glob", "src/**"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--glob", "!generated/**"]));
    }

    #[test]
    fn search_tree_respects_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello\nfind me here\n").unwrap();
        let matcher = RegexMatcherBuilder::new().build("find").unwrap();
        let ws = WorkspaceEnv::from_option(None);
        let root_display = dir.path().to_string_lossy().to_string();
        let filters = build_path_filters(&[], &[]).unwrap();

        let live = search_tree(
            dir.path(),
            &root_display,
            &ws,
            &matcher,
            &filters,
            100,
            &|| false,
        );
        assert_eq!(live.hits.len(), 1, "uncancelled search finds the match");

        let stopped = search_tree(
            dir.path(),
            &root_display,
            &ws,
            &matcher,
            &filters,
            100,
            &|| true,
        );
        assert!(stopped.hits.is_empty(), "cancelled search yields nothing");
    }

    #[test]
    fn newer_remote_search_cancels_and_owns_the_active_token() {
        let state = ContentSearchState::default();
        let first = state.replace_remote_cancellation(1);
        let second = state.replace_remote_cancellation(2);

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        state.finish_remote_cancellation(1);
        assert!(state
            .active_remote
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(generation, _)| *generation == 2));
        state.finish_remote_cancellation(2);
        assert!(state.active_remote.lock().unwrap().is_none());
    }
}
