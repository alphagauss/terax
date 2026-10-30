//! AI Agent 文件工具的统一原生后端。
//! 共享服务接收普通状态引用，Tauri command 仅转换桌面注入的上下文。
//!
//! 本模块负责会话工作目录、权限模式、敏感路径、读取版本、修改快照和文件树操作，
//! 并复用现有文件服务将同一契约路由到 Local、WSL 与 SSH。请求批准模式限制在
//! 会话根内，完全访问模式允许系统用户可访问的路径；多文件提交不承诺跨文件系统事务。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use globset::{Glob, GlobMatcher};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::file::{CheckedWriteResult, FileVersion, ReadResult, WriteCondition};
use super::grep::{self, ContentSearchCaseMode, ContentSearchRequest, ContentSearchSyntax};
use super::to_canon;
use super::tree::{DirEntry, EntryKind};
#[cfg(feature = "workspace-runtime")]
use crate::modules::remote;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_OWNERS: usize = 128;
const MAX_OWNER_READS: usize = 512;
const MAX_PREPARED_MUTATIONS: usize = 64;
const MAX_PREPARED_PER_OWNER: usize = 8;
const MAX_PATCH_FILES: usize = 20;
const MAX_EDITS_PER_FILE: usize = 100;
const MAX_MUTATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_COPY_BYTES: u64 = 10 * 1024 * 1024;
const MAX_READ_LINES: usize = 10_000;
const DEFAULT_READ_LINES: usize = 2_000;
const MAX_READ_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_FIND_LIMIT: usize = 2_000;
const DEFAULT_FIND_LIMIT: usize = 200;
const MAX_FIND_SCAN: usize = 50_000;
const MAX_GREP_LIMIT: usize = 500;
const DEFAULT_GREP_LIMIT: usize = 30;
const MAX_GREP_CONTEXT: usize = 20;
const MAX_GREP_CONTEXT_FILES: usize = 50;

/// AI 文件后端的进程内状态。
#[derive(Default)]
pub struct AgentFileState {
    reads: Mutex<HashMap<String, HashMap<String, ReadState>>>,
    scopes: Mutex<HashMap<String, AgentScope>>,
    prepared: tokio::sync::Mutex<HashMap<String, PreparedMutation>>,
}

#[derive(Clone)]
struct AgentScope {
    root_canonical: String,
    workspace: WorkspaceEnv,
}

#[derive(Clone)]
struct ReadState {
    version: FileVersion,
    // 写入提交保留后续编辑的版本基线，但不能代表正文已经返回给模型。
    read_window: Option<(usize, usize)>,
    read_call_id: Option<String>,
}

#[derive(Clone)]
struct PreparedWrite {
    path: String,
    io_path: String,
    canonical: String,
    before: String,
    after: String,
    condition: WriteCondition,
    is_new_file: bool,
    replacements: usize,
}

#[derive(Clone)]
struct PreparedMutation {
    owner_session_id: String,
    root: String,
    permission_mode: AgentPermissionMode,
    workspace: WorkspaceEnv,
    writes: Vec<PreparedWrite>,
}

/// AI 工具当前采用的路径授权模式。
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPermissionMode {
    Ask,
    FullAccess,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadRequest {
    owner_session_id: String,
    root: String,
    permission_mode: AgentPermissionMode,
    path: String,
    tool_call_id: String,
    visible_read_ids: Vec<String>,
    start_line: Option<usize>,
    line_count: Option<usize>,
    force: Option<bool>,
    workspace: Option<WorkspaceEnv>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadResponse {
    path: String,
    content: String,
    size: u64,
    start_line: usize,
    end_line: usize,
    total_lines: usize,
    next_line: Option<usize>,
    truncated: bool,
    line_truncated: bool,
    unchanged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFindRequest {
    owner_session_id: String,
    root: String,
    permission_mode: AgentPermissionMode,
    path: Option<String>,
    glob: Option<String>,
    recursive: Option<bool>,
    include_directories: Option<bool>,
    include_hidden: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentPathKind {
    File,
    Directory,
    Symlink,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFindEntry {
    path: String,
    rel: String,
    kind: AgentPathKind,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFindResponse {
    root: String,
    entries: Vec<AgentFindEntry>,
    next_offset: Option<usize>,
    truncated: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentGrepOutput {
    Content,
    Files,
    Count,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrepRequest {
    owner_session_id: String,
    root: String,
    permission_mode: AgentPermissionMode,
    path: Option<String>,
    pattern: String,
    syntax: Option<ContentSearchSyntax>,
    case_insensitive: Option<bool>,
    include: Option<Vec<String>>,
    output: Option<AgentGrepOutput>,
    context_lines: Option<usize>,
    offset: Option<usize>,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextLine {
    line: u64,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrepContentHit {
    path: String,
    rel: String,
    line: u64,
    text: String,
    before: Vec<AgentContextLine>,
    after: Vec<AgentContextLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrepCount {
    path: String,
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrepResponse {
    root: String,
    output: AgentGrepOutput,
    hits: Vec<AgentGrepContentHit>,
    files: Vec<String>,
    counts: Vec<AgentGrepCount>,
    files_scanned: usize,
    next_offset: Option<usize>,
    truncated: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentWriteMode {
    Create,
    Rewrite,
}

#[derive(Clone, Deserialize)]
pub struct AgentTextEdit {
    old_text: String,
    new_text: String,
    #[serde(default)]
    replace_all: bool,
    expected_replacements: Option<usize>,
}

#[derive(Clone, Deserialize)]
pub struct AgentPatchFile {
    path: String,
    edits: Vec<AgentTextEdit>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentMutationInput {
    Write {
        path: String,
        content: String,
        mode: AgentWriteMode,
    },
    Patch {
        files: Vec<AgentPatchFile>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrepareMutationRequest {
    owner_session_id: String,
    tool_call_id: String,
    root: String,
    permission_mode: AgentPermissionMode,
    mutation: AgentMutationInput,
    workspace: Option<WorkspaceEnv>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFilePreview {
    path: String,
    identity: String,
    before: String,
    after: String,
    is_new_file: bool,
    replacements: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMutationPreview {
    files: Vec<AgentFilePreview>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMutationKeyRequest {
    owner_session_id: String,
    tool_call_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMutationResult {
    files: Vec<AgentMutationFileResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    uncertain_paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMutationFileResult {
    path: String,
    bytes_written: usize,
    replacements: usize,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFileOperation {
    Move,
    Copy,
    Delete,
    CreateDirectory,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileOperationRequest {
    owner_session_id: String,
    root: String,
    permission_mode: AgentPermissionMode,
    operation: AgentFileOperation,
    path: String,
    destination: Option<String>,
    recursive: Option<bool>,
    workspace: Option<WorkspaceEnv>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileOperationResponse {
    operation: AgentFileOperation,
    path: String,
    destination: Option<String>,
    ok: bool,
}

#[derive(Clone)]
struct AuthorizedPath {
    actual: String,
    io_path: String,
    canonical: String,
    root_canonical: String,
}

#[derive(Clone, Copy)]
struct AgentPathContext<'a> {
    root: &'a str,
    workspace: &'a WorkspaceEnv,
    permission_mode: AgentPermissionMode,
}

/// 原生文件传输复用 owner、cwd、权限模式和普通文件校验，取得大小有界的字节快照。
#[allow(clippy::too_many_arguments)]
pub async fn agent_file_snapshot(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    owner: &str,
    root: &str,
    path: &str,
    permission_mode: AgentPermissionMode,
    max_bytes: usize,
) -> Result<(String, Vec<u8>), String> {
    use tokio::io::AsyncReadExt;
    validate_owner(owner)?;
    let workspace = WorkspaceEnv::Local;
    let authorized =
        authorize_path(registry, root, path, &workspace, permission_mode, true).await?;
    state.bind_scope(owner, &authorized, &workspace)?;
    ensure_regular_file(&authorized.io_path, &workspace).await?;
    let file = tokio::fs::File::open(&authorized.io_path)
        .await
        .map_err(|e| e.to_string())?;
    let before = file.metadata().await.map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > max_bytes as u64 {
        return Err("file exceeds size limits".into());
    }
    let mut reader = file.take(max_bytes as u64 + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    let after = reader
        .get_ref()
        .metadata()
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() > max_bytes
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || bytes.len() as u64 != after.len()
    {
        return Err("file changed while reading or exceeds size limits".into());
    }
    let name = Path::new(&authorized.io_path)
        .file_name()
        .ok_or("missing file name")?
        .to_string_lossy()
        .into_owned();
    Ok((name, bytes))
}

/// 读取当前工作区内的普通 UTF-8 文件，并记录聊天级文件版本。
pub async fn agent_file_read(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    request: AgentReadRequest,
) -> Result<AgentReadResponse, String> {
    validate_owner(&request.owner_session_id)?;
    validate_tool_call_id(&request.tool_call_id)?;
    let workspace = WorkspaceEnv::from_option(request.workspace);
    let authorized = authorize_path(
        registry,
        &request.root,
        &request.path,
        &workspace,
        request.permission_mode,
        true,
    )
    .await?;
    state.bind_scope(&request.owner_session_id, &authorized, &workspace)?;
    ensure_regular_file(&authorized.io_path, &workspace).await?;
    let start_line = request.start_line.unwrap_or(1);
    let line_count = request
        .line_count
        .unwrap_or(DEFAULT_READ_LINES)
        .clamp(1, MAX_READ_LINES);
    if start_line == 0 {
        return Err("startLine must be at least 1".into());
    }
    let result =
        super::file::fs_read_file(authorized.io_path.clone(), Some(workspace), Some(false)).await?;
    let ReadResult::Text {
        content,
        size,
        mtime,
        revision,
    } = result
    else {
        return Err(match result {
            ReadResult::Binary { .. } => "binary file refused".into(),
            ReadResult::TooLarge { size, limit, .. } => {
                format!("file too large ({size} bytes, limit {limit})")
            }
            ReadResult::Text { .. } => unreachable!(),
        });
    };
    let version = FileVersion {
        revision,
        size,
        mtime,
    };
    let unchanged = !request.force.unwrap_or(false)
        && state.read_matches(
            &request.owner_session_id,
            &authorized.canonical,
            &version,
            start_line,
            line_count,
            &request.visible_read_ids,
        );
    if unchanged {
        return Ok(AgentReadResponse {
            path: authorized.actual,
            content: String::new(),
            size,
            start_line,
            end_line: start_line.saturating_sub(1),
            total_lines: content.lines().count(),
            next_line: None,
            truncated: false,
            line_truncated: false,
            unchanged: true,
        });
    }
    let response = format_read_response(authorized.actual, content, size, start_line, line_count)?;
    state.record_version(
        &request.owner_session_id,
        authorized.canonical,
        version,
        Some((start_line, line_count)),
        Some(request.tool_call_id),
    );
    Ok(response)
}

/// 统一执行直接目录列举和递归 glob 路径发现。
pub async fn agent_file_find(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    request: AgentFindRequest,
) -> Result<AgentFindResponse, String> {
    validate_owner(&request.owner_session_id)?;
    let workspace = WorkspaceEnv::from_option(request.workspace);
    let requested_path = request.path.as_deref().unwrap_or(".");
    let authorized = authorize_path(
        registry,
        &request.root,
        requested_path,
        &workspace,
        request.permission_mode,
        true,
    )
    .await?;
    state.bind_scope(&request.owner_session_id, &authorized, &workspace)?;
    let matcher = request
        .glob
        .as_deref()
        .map(|pattern| Glob::new(pattern).map(|glob| glob.compile_matcher()))
        .transpose()
        .map_err(|error| format!("bad glob: {error}"))?;
    let recursive = request.recursive.unwrap_or(false);
    let include_directories = request.include_directories.unwrap_or(!recursive);
    let include_hidden = request.include_hidden.unwrap_or(false);
    let (mut entries, scan_truncated) = if recursive {
        find_recursive(
            &authorized.io_path,
            &workspace,
            matcher.as_ref(),
            include_directories,
            include_hidden,
        )
        .await?
    } else {
        find_immediate(
            &authorized.io_path,
            &workspace,
            matcher.as_ref(),
            include_directories,
            include_hidden,
        )
        .await?
    };
    if request.permission_mode == AgentPermissionMode::Ask {
        entries.retain(|entry| ensure_safe_path(&entry.path).is_ok());
    }
    entries.sort_by_key(|entry| entry.rel.to_lowercase());
    let offset = request.offset.unwrap_or(0);
    let limit = request
        .limit
        .unwrap_or(DEFAULT_FIND_LIMIT)
        .clamp(1, MAX_FIND_LIMIT);
    let total = entries.len();
    let entries = entries.into_iter().skip(offset).take(limit).collect();
    let next = offset.saturating_add(limit);
    Ok(AgentFindResponse {
        root: authorized.actual,
        entries,
        next_offset: (next < total).then_some(next),
        truncated: scan_truncated || next < total,
    })
}

/// 使用共享搜索引擎执行 Agent 正文搜索，并在安全过滤后分页和聚合。
pub async fn agent_file_grep(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    request: AgentGrepRequest,
) -> Result<AgentGrepResponse, String> {
    validate_owner(&request.owner_session_id)?;
    let workspace = WorkspaceEnv::from_option(request.workspace);
    let requested_path = request.path.as_deref().unwrap_or(".");
    let authorized = authorize_path(
        registry,
        &request.root,
        requested_path,
        &workspace,
        request.permission_mode,
        true,
    )
    .await?;
    state.bind_scope(&request.owner_session_id, &authorized, &workspace)?;
    let output = request.output.unwrap_or(AgentGrepOutput::Content);
    let offset = request.offset.unwrap_or(0);
    let limit = request
        .limit
        .unwrap_or(DEFAULT_GREP_LIMIT)
        .clamp(1, MAX_GREP_LIMIT);
    let context_lines = request.context_lines.unwrap_or(0).min(MAX_GREP_CONTEXT);
    let mut includes = request.include.unwrap_or_default();
    let mut explicit_file = None;
    let search_root = if path_targets_directory(&authorized.io_path, &workspace).await? {
        authorized.io_path.clone()
    } else {
        ensure_regular_file(&authorized.io_path, &workspace).await?;
        let (parent, name) = split_parent_and_name(&authorized.io_path, &workspace)?;
        if !includes_match_file(&includes, &name)? {
            return Ok(AgentGrepResponse {
                root: authorized.actual,
                output,
                hits: Vec::new(),
                files: Vec::new(),
                counts: Vec::new(),
                files_scanned: 0,
                next_offset: None,
                truncated: false,
            });
        }
        includes = vec![exact_file_glob(&name)];
        explicit_file = Some(authorized.io_path.clone());
        parent
    };
    let response = grep::search_content(ContentSearchRequest {
        root: search_root,
        pattern: request.pattern,
        syntax: request.syntax.unwrap_or(ContentSearchSyntax::Regex),
        case_mode: if request.case_insensitive.unwrap_or(false) {
            ContentSearchCaseMode::Insensitive
        } else {
            ContentSearchCaseMode::Sensitive
        },
        whole_word: false,
        includes,
        excludes: Vec::new(),
        max_results: Some(2_000),
        cancel_previous: false,
        workspace: Some(workspace.clone()),
    })
    .await?;
    let safe_hits: Vec<_> = response
        .hits
        .into_iter()
        .filter(|hit| {
            (request.permission_mode == AgentPermissionMode::FullAccess
                || ensure_safe_path(&hit.path).is_ok())
                && explicit_file
                    .as_deref()
                    .is_none_or(|path| paths_equal(&hit.path, path, &workspace))
        })
        .collect();
    let (hits, files, counts, available) = match output {
        AgentGrepOutput::Content => {
            let selected: Vec<_> = safe_hits.iter().skip(offset).take(limit).collect();
            let mut hits = Vec::with_capacity(selected.len());
            let mut context_files: HashMap<String, Vec<String>> = HashMap::new();
            for hit in selected {
                let (before, after) = if context_lines == 0 {
                    (Vec::new(), Vec::new())
                } else {
                    if !context_files.contains_key(&hit.path) {
                        if context_files.len() >= MAX_GREP_CONTEXT_FILES {
                            return Err(
                                "grep context spans too many files; narrow the search".into()
                            );
                        }
                        let lines = read_context_file(&workspace, &hit.path)
                            .await
                            .unwrap_or_default();
                        context_files.insert(hit.path.clone(), lines);
                    }
                    context_for_hit(
                        context_files
                            .get(&hit.path)
                            .expect("context file was inserted"),
                        hit.line,
                        context_lines,
                    )
                };
                hits.push(AgentGrepContentHit {
                    path: hit.path.clone(),
                    rel: hit.rel.clone(),
                    line: hit.line,
                    text: clip_text(&hit.text, 320),
                    before,
                    after,
                });
            }
            (hits, Vec::new(), Vec::new(), safe_hits.len())
        }
        AgentGrepOutput::Files => {
            let mut seen = HashSet::new();
            let mut all = Vec::new();
            for hit in &safe_hits {
                if seen.insert(hit.path.clone()) {
                    all.push(hit.path.clone());
                }
            }
            let available = all.len();
            (
                Vec::new(),
                all.into_iter().skip(offset).take(limit).collect(),
                Vec::new(),
                available,
            )
        }
        AgentGrepOutput::Count => {
            let mut by_path: HashMap<String, usize> = HashMap::new();
            for hit in &safe_hits {
                *by_path.entry(hit.path.clone()).or_default() += 1;
            }
            let mut all: Vec<_> = by_path
                .into_iter()
                .map(|(path, count)| AgentGrepCount { path, count })
                .collect();
            all.sort_by(|left, right| left.path.cmp(&right.path));
            let available = all.len();
            (
                Vec::new(),
                Vec::new(),
                all.into_iter().skip(offset).take(limit).collect(),
                available,
            )
        }
    };
    let next = offset.saturating_add(limit);
    Ok(AgentGrepResponse {
        root: authorized.actual,
        output,
        hits,
        files,
        counts,
        files_scanned: response.files_scanned,
        next_offset: (next < available).then_some(next),
        truncated: response.truncated || next < available,
    })
}

/// 准备全文写入或多文件精确补丁，并缓存审批所见内容。
pub async fn agent_file_prepare_mutation(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    request: AgentPrepareMutationRequest,
) -> Result<AgentMutationPreview, String> {
    validate_owner(&request.owner_session_id)?;
    validate_tool_call_id(&request.tool_call_id)?;
    let key = mutation_key(&request.owner_session_id, &request.tool_call_id);
    let mut prepared = state.prepared.lock().await;
    if let Some(existing) = prepared.get(&key) {
        return Ok(preview_for(existing));
    }
    if prepared.len() >= MAX_PREPARED_MUTATIONS {
        return Err("too many prepared file mutations".into());
    }
    if prepared
        .values()
        .filter(|mutation| mutation.owner_session_id == request.owner_session_id)
        .count()
        >= MAX_PREPARED_PER_OWNER
    {
        return Err("too many prepared file mutations for this chat".into());
    }
    let workspace = WorkspaceEnv::from_option(request.workspace);
    let writes = prepare_writes(
        state,
        registry,
        &request.owner_session_id,
        AgentPathContext {
            root: &request.root,
            workspace: &workspace,
            permission_mode: request.permission_mode,
        },
        request.mutation,
    )
    .await?;
    let mutation = PreparedMutation {
        owner_session_id: request.owner_session_id,
        root: request.root,
        permission_mode: request.permission_mode,
        workspace,
        writes,
    };
    let preview = preview_for(&mutation);
    prepared.insert(key, mutation);
    Ok(preview)
}

/// 提交已准备的修改；任何基线冲突都会在写入前拒绝。
pub async fn agent_file_commit_mutation(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    app: &dyn crate::modules::fs::file::FileEvents,
    request: AgentMutationKeyRequest,
) -> Result<AgentMutationResult, String> {
    validate_owner(&request.owner_session_id)?;
    validate_tool_call_id(&request.tool_call_id)?;
    let key = mutation_key(&request.owner_session_id, &request.tool_call_id);
    let mut prepared = state.prepared.lock().await;
    let mutation = prepared
        .get(&key)
        .cloned()
        .ok_or_else(|| "file mutation was not prepared".to_string())?;
    validate_prepared(registry, &mutation).await?;
    let mut results = Vec::with_capacity(mutation.writes.len());
    let mut committed = Vec::new();
    for write in &mutation.writes {
        if let Err(error) = ensure_parent(&write.io_path, &mutation.workspace).await {
            let failures = rollback_writes(app, &mutation.workspace, &committed).await;
            return mutation_failure(error, failures);
        }
        let result = match super::file::fs_write_file_checked(
            write.io_path.clone(),
            write.after.clone(),
            write.condition.clone(),
            Some(mutation.workspace.clone()),
            Some("ai".into()),
            app,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let failures = rollback_writes(app, &mutation.workspace, &committed).await;
                return mutation_failure(error, failures);
            }
        };
        let CheckedWriteResult::Written {
            revision,
            size,
            mtime,
        } = result
        else {
            let failures = rollback_writes(app, &mutation.workspace, &committed).await;
            return mutation_failure(
                "file changed after approval; review the updated files again".into(),
                failures,
            );
        };
        let new_version = FileVersion {
            revision,
            size,
            mtime,
        };
        committed.push((write.clone(), new_version.clone()));
        if !paths_equal(&write.path, &write.io_path, &mutation.workspace) {
            super::file::emit_file_written(app, &write.path, Some("ai".into()));
        }
        results.push(AgentMutationFileResult {
            path: write.path.clone(),
            bytes_written: write.after.len(),
            replacements: write.replacements,
        });
    }
    for (write, version) in &committed {
        state.record_version(
            &mutation.owner_session_id,
            write.canonical.clone(),
            version.clone(),
            None,
            None,
        );
    }
    prepared.remove(&key);
    Ok(AgentMutationResult {
        files: results,
        error: None,
        uncertain_paths: Vec::new(),
    })
}

/// 丢弃单个预备快照。
pub async fn agent_file_clear_mutation(
    state: &AgentFileState,
    request: AgentMutationKeyRequest,
) -> Result<(), String> {
    validate_owner(&request.owner_session_id)?;
    validate_tool_call_id(&request.tool_call_id)?;
    state.prepared.lock().await.remove(&mutation_key(
        &request.owner_session_id,
        &request.tool_call_id,
    ));
    Ok(())
}

/// 清理聊天拥有的读取版本和预备快照。
pub async fn agent_file_clear_owner(
    state: &AgentFileState,
    owner_session_id: String,
) -> Result<(), String> {
    validate_owner(&owner_session_id)?;
    state
        .reads
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&owner_session_id);
    state
        .scopes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&owner_session_id);
    state
        .prepared
        .lock()
        .await
        .retain(|_, mutation| mutation.owner_session_id != owner_session_id);
    Ok(())
}

/// 执行经过审批的结构化路径操作。
pub async fn agent_file_operation(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    app: &dyn crate::modules::fs::file::FileEvents,
    request: AgentFileOperationRequest,
) -> Result<AgentFileOperationResponse, String> {
    validate_owner(&request.owner_session_id)?;
    let workspace = WorkspaceEnv::from_option(request.workspace);
    if request.recursive.is_some() && !matches!(request.operation, AgentFileOperation::Delete) {
        return Err("recursive is only valid for delete".into());
    }
    let source_must_exist = !matches!(request.operation, AgentFileOperation::CreateDirectory);
    let source = authorize_path(
        registry,
        &request.root,
        &request.path,
        &workspace,
        request.permission_mode,
        source_must_exist,
    )
    .await?;
    state.bind_scope(&request.owner_session_id, &source, &workspace)?;
    if is_filesystem_root(&source.actual, &source.io_path, &workspace) {
        return Err("refusing to operate on the filesystem root".into());
    }
    if request.permission_mode == AgentPermissionMode::Ask
        && paths_equal(&source.canonical, &source.root_canonical, &workspace)
    {
        return Err("refusing to operate on the workspace root".into());
    }
    let destination = match request.operation {
        AgentFileOperation::Move | AgentFileOperation::Copy => {
            let raw = request
                .destination
                .as_deref()
                .ok_or_else(|| "destination is required".to_string())?;
            let target = authorize_path(
                registry,
                &request.root,
                raw,
                &workspace,
                request.permission_mode,
                false,
            )
            .await?;
            if path_exists(&target.io_path, &workspace).await? {
                return Err(format!("destination already exists: {}", target.actual));
            }
            Some(target)
        }
        AgentFileOperation::Delete | AgentFileOperation::CreateDirectory => {
            if request.destination.is_some() {
                return Err("destination is only valid for move or copy".into());
            }
            None
        }
    };
    let source_io: &str =
        if source_must_exist && !path_is_symlink(&source.actual, &workspace).await? {
            &source.io_path
        } else {
            &source.actual
        };
    match request.operation {
        AgentFileOperation::Move => {
            let target = destination.as_ref().expect("validated destination");
            ensure_parent(&target.io_path, &workspace).await?;
            super::mutate::fs_rename(
                source_io.to_string(),
                target.io_path.clone(),
                Some(workspace.clone()),
            )
            .await?;
        }
        AgentFileOperation::Copy => {
            let target = destination.as_ref().expect("validated destination");
            ensure_parent(&target.io_path, &workspace).await?;
            copy_file(&source.io_path, &target.io_path, &workspace).await?;
        }
        AgentFileOperation::Delete => {
            let is_directory = path_is_directory(source_io, &workspace).await?;
            if is_directory && !request.recursive.unwrap_or(false) {
                return Err("recursive=true is required to delete a directory".into());
            }
            super::mutate::fs_delete(source_io.to_string(), Some(workspace.clone())).await?;
        }
        AgentFileOperation::CreateDirectory => {
            super::mutate::fs_create_dir(source.io_path.clone(), Some(workspace.clone())).await?;
        }
    }
    super::file::emit_file_written(app, &source.actual, Some("ai".into()));
    if let Some(target) = &destination {
        super::file::emit_file_written(app, &target.actual, Some("ai".into()));
    }
    Ok(AgentFileOperationResponse {
        operation: request.operation,
        path: source.actual,
        destination: destination.map(|path| path.actual),
        ok: true,
    })
}

impl AgentFileState {
    fn bind_scope(
        &self,
        owner: &str,
        path: &AuthorizedPath,
        workspace: &WorkspaceEnv,
    ) -> Result<(), String> {
        let mut scopes = self
            .scopes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(scope) = scopes.get(owner) {
            if scope.workspace != *workspace
                || !paths_equal(&scope.root_canonical, &path.root_canonical, workspace)
            {
                return Err("file tool session scope cannot change".into());
            }
            return Ok(());
        }
        if scopes.len() >= MAX_OWNERS {
            return Err("too many active file tool sessions".into());
        }
        scopes.insert(
            owner.to_string(),
            AgentScope {
                root_canonical: path.root_canonical.clone(),
                workspace: workspace.clone(),
            },
        );
        Ok(())
    }

    fn read_matches(
        &self,
        owner: &str,
        path: &str,
        version: &FileVersion,
        start_line: usize,
        line_count: usize,
        visible_read_ids: &[String],
    ) -> bool {
        self.reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(owner)
            .and_then(|reads| reads.get(path))
            .is_some_and(|read| {
                versions_equal(&read.version, version)
                    && read.read_window == Some((start_line, line_count))
                    && read
                        .read_call_id
                        .as_ref()
                        .is_some_and(|id| visible_read_ids.contains(id))
            })
    }

    fn record_version(
        &self,
        owner: &str,
        path: String,
        version: FileVersion,
        read_window: Option<(usize, usize)>,
        read_call_id: Option<String>,
    ) {
        let mut owners = self
            .reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let reads = owners.entry(owner.to_string()).or_default();
        if reads.len() >= MAX_OWNER_READS && !reads.contains_key(&path) {
            reads.clear();
        }
        reads.insert(
            path,
            ReadState {
                version,
                read_window,
                read_call_id,
            },
        );
    }

    fn read_version(&self, owner: &str, path: &str) -> Option<FileVersion> {
        self.reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(owner)
            .and_then(|reads| reads.get(path))
            .map(|read| read.version.clone())
    }
}

fn validate_owner(value: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "ownerSessionId must be a UUID".into())
}

fn validate_tool_call_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        Err("invalid toolCallId".into())
    } else {
        Ok(())
    }
}

fn mutation_key(owner: &str, tool_call_id: &str) -> String {
    format!("{owner}:{tool_call_id}")
}

fn versions_equal(left: &FileVersion, right: &FileVersion) -> bool {
    left.revision == right.revision && left.size == right.size
}

fn paths_equal(left: &str, right: &str, workspace: &WorkspaceEnv) -> bool {
    if cfg!(windows) && matches!(workspace, WorkspaceEnv::Local) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn is_filesystem_root(actual: &str, io_path: &str, workspace: &WorkspaceEnv) -> bool {
    if workspace.is_ssh() || workspace.is_wsl() {
        actual.trim_matches('/').is_empty()
    } else {
        Path::new(io_path).parent().is_none()
    }
}

fn validate_path_input(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return Err("invalid file path".into());
    }
    Ok(())
}

fn ensure_safe_path(path: &str) -> Result<(), String> {
    validate_path_input(path)?;
    let normalized = path.replace('\\', "/").to_lowercase();
    let components: Vec<String> = normalized
        .split('/')
        .filter(|component| !component.is_empty())
        .map(|component| {
            component
                .split(':')
                .next()
                .unwrap_or_default()
                .trim_end_matches(['.', ' '])
                .to_string()
        })
        .collect();
    const PROTECTED: &[&str] = &[
        ".git",
        ".ssh",
        ".gnupg",
        ".aws",
        ".azure",
        ".kube",
        ".docker",
        ".terraform.d",
    ];
    let root_index = usize::from(normalized.as_bytes().get(1) == Some(&b':'));
    let root_component = components
        .get(root_index)
        .map(String::as_str)
        .unwrap_or_default();
    if components
        .iter()
        .any(|component| PROTECTED.contains(&component.as_str()))
        || components.windows(2).any(|pair| {
            pair[0] == ".config" && ["gh", "git", "gcloud", "op"].contains(&pair[1].as_str())
        })
        || protected_component_sequence(&components, root_index)
        || [
            "etc",
            "proc",
            "sys",
            "windows",
            "program files",
            "program files (x86)",
            "programdata",
        ]
        .contains(&root_component)
    {
        return Err("path is inside a protected directory".into());
    }
    let basename = components.last().map(String::as_str).unwrap_or_default();
    let sensitive_extension = [
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".asc",
        ".gpg",
        ".keystore",
        ".jks",
    ]
    .iter()
    .any(|extension| sensitive_extension_name(basename, extension));
    if sensitive_boundary_name(basename, ".env")
        || sensitive_boundary_name(basename, "credentials")
        || sensitive_boundary_name(basename, ".netrc")
        || sensitive_boundary_name(basename, "_netrc")
        || sensitive_boundary_name(basename, ".pgpass")
        || sensitive_boundary_name(basename, ".npmrc")
        || sensitive_boundary_name(basename, ".pypirc")
        || sensitive_boundary_name(basename, "known_hosts")
        || sensitive_boundary_name(basename, "authorized_keys")
        || sensitive_boundary_name(basename, "htpasswd")
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
            .iter()
            .any(|prefix| sensitive_key_name(basename, prefix))
        || sensitive_extension
        || ((basename.starts_with("secret")
            || basename.starts_with("service-account")
            || basename.starts_with("service_account"))
            && [".json", ".yaml", ".yml", ".toml", ".env"]
                .iter()
                .any(|extension| sensitive_extension_name(basename, extension)))
    {
        return Err("path matches a sensitive-file pattern".into());
    }
    Ok(())
}

fn sensitive_key_name(name: &str, prefix: &str) -> bool {
    name == prefix
        || name
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with(['.', '_', '-']))
}

fn sensitive_boundary_name(name: &str, prefix: &str) -> bool {
    name == prefix
        || name
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn sensitive_extension_name(name: &str, extension: &str) -> bool {
    name.ends_with(extension) || name.contains(&format!("{extension}."))
}

fn protected_component_sequence(components: &[String], root_index: usize) -> bool {
    const ROOT_SEQUENCES: &[&[&str]] = &[
        &["var", "db"],
        &["var", "root"],
        &["private", "etc"],
        &["private", "var", "db"],
        &["private", "var", "root"],
    ];
    const CREDENTIAL_SEQUENCES: &[&[&str]] = &[
        &["library", "keychains"],
        &["library", "cookies"],
        &["appdata", "roaming", "microsoft", "credentials"],
        &["appdata", "local", "microsoft", "credentials"],
        &["appdata", "roaming", "gcloud"],
    ];
    ROOT_SEQUENCES.iter().any(|sequence| {
        components
            .get(root_index..root_index.saturating_add(sequence.len()))
            .is_some_and(|window| {
                window
                    .iter()
                    .map(String::as_str)
                    .eq(sequence.iter().copied())
            })
    }) || CREDENTIAL_SEQUENCES.iter().any(|sequence| {
        components.windows(sequence.len()).any(|window| {
            window
                .iter()
                .map(String::as_str)
                .eq(sequence.iter().copied())
        })
    })
}

/// 拒绝 Windows DOS 设备名和 NTFS alternate data stream，避免普通文件工具进入特殊命名空间。
#[cfg_attr(
    not(any(windows, test)),
    expect(dead_code, reason = "仅 Windows Local 路径使用")
)]
fn ensure_safe_windows_path(path: &str) -> Result<(), String> {
    for (index, component) in path.replace('\\', "/").split('/').enumerate() {
        if component.is_empty() || (index == 0 && component.ends_with(':')) {
            continue;
        }
        if component.contains(':') {
            return Err("NTFS alternate data streams are not allowed".into());
        }
        let normalized = component.trim_end_matches(['.', ' ']).to_ascii_lowercase();
        let stem = normalized.split('.').next().unwrap_or_default();
        let reserved = matches!(stem, "con" | "prn" | "aux" | "nul" | "clock$")
            || stem
                .strip_prefix("com")
                .or_else(|| stem.strip_prefix("lpt"))
                .is_some_and(|number| {
                    number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9')
                });
        if reserved {
            return Err("Windows device paths are not allowed".into());
        }
    }
    Ok(())
}

fn format_read_response(
    path: String,
    content: String,
    size: u64,
    start_line: usize,
    line_count: usize,
) -> Result<AgentReadResponse, String> {
    let lines: Vec<_> = content.lines().collect();
    let total_lines = lines.len();
    if start_line > total_lines.max(1) {
        return Err(format!(
            "startLine {start_line} is beyond end of file ({total_lines} lines)"
        ));
    }
    let start = start_line.saturating_sub(1).min(total_lines);
    let requested_end = start.saturating_add(line_count).min(total_lines);
    let mut output = String::new();
    let mut end_line = start;
    let mut line_truncated = false;
    for (index, line) in lines[start..requested_end].iter().enumerate() {
        let number = start + index + 1;
        let prefix = format!("{number}| ");
        let separator = usize::from(!output.is_empty());
        if output.len() + separator + prefix.len() + line.len() > MAX_READ_OUTPUT_BYTES {
            if output.is_empty() {
                output.push_str(&prefix);
                let budget = MAX_READ_OUTPUT_BYTES.saturating_sub(output.len());
                output.push_str(truncate_utf8(line, budget));
                end_line = number;
                line_truncated = true;
            }
            break;
        }
        if separator == 1 {
            output.push('\n');
        }
        output.push_str(&prefix);
        output.push_str(line.trim_end_matches('\r'));
        end_line = number;
    }
    let truncated = line_truncated || end_line < total_lines;
    Ok(AgentReadResponse {
        path,
        content: output,
        size,
        start_line,
        end_line,
        total_lines,
        next_line: (end_line < total_lines).then_some(end_line + 1),
        truncated,
        line_truncated,
        unchanged: false,
    })
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn clip_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let clipped: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{clipped}...[truncated]")
    } else {
        clipped
    }
}

/// 按当前权限模式解析并校验模型提供的路径。
///
/// 请求批准模式将会话 cwd 作为路径上界并拒绝敏感路径；完全访问模式仍以 cwd
/// 解析相对路径，但绝对目标只受系统权限和后续文件类型、大小与写入条件约束。
async fn authorize_path(
    registry: &WorkspaceRegistry,
    root: &str,
    path: &str,
    workspace: &WorkspaceEnv,
    permission_mode: AgentPermissionMode,
    must_exist: bool,
) -> Result<AuthorizedPath, String> {
    validate_path_input(root)?;
    validate_path_input(path)?;
    let actual = join_workspace_path(root, path, workspace);
    if permission_mode == AgentPermissionMode::Ask {
        ensure_safe_path(&actual)?;
    }
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let root_canonical = remote::sftp::canonicalize(&remote_workspace, root).await?;
            let canonical = canonicalize_remote_nearest(&remote_workspace, &actual).await?;
            if permission_mode == AgentPermissionMode::Ask {
                ensure_safe_path(&canonical)?;
                ensure_within_remote(&root_canonical, &canonical)?;
            }
            if must_exist {
                remote::sftp::stat(&remote_workspace, &actual).await?;
            }
            return Ok(AuthorizedPath {
                actual,
                io_path: canonical.clone(),
                canonical,
                root_canonical,
            });
        }
    }
    let root_host = resolve_path(root, workspace);
    let root_canonical = std::fs::canonicalize(&root_host).map_err(|error| {
        format!(
            "workspace root is not accessible ({}): {error}",
            root_host.display()
        )
    })?;
    if permission_mode == AgentPermissionMode::Ask && !registry.is_authorized_root(&root_canonical)
    {
        return Err("root is not an authorized workspace".into());
    }
    let target_host = resolve_path(&actual, workspace);
    let canonical = canonicalize_local_nearest(&target_host)?;
    if permission_mode == AgentPermissionMode::Ask {
        ensure_safe_path(&canonical.to_string_lossy())?;
        if !canonical.starts_with(&root_canonical) {
            return Err("path is outside the session workspace".into());
        }
    }
    if must_exist && std::fs::symlink_metadata(&target_host).is_err() {
        return Err(format!("path not found: {actual}"));
    }
    #[cfg(windows)]
    if matches!(workspace, WorkspaceEnv::Local) {
        ensure_safe_windows_path(&actual)?;
    }
    let (io_root, io_root_canonical) =
        if permission_mode == AgentPermissionMode::FullAccess && workspace.is_wsl() {
            (
                "/",
                std::fs::canonicalize(resolve_path("/", workspace))
                    .map_err(|error| format!("WSL filesystem root is not accessible: {error}"))?,
            )
        } else {
            (root, root_canonical.clone())
        };
    let io_path = stable_io_path(io_root, &io_root_canonical, &canonical, workspace)?;
    Ok(AuthorizedPath {
        actual,
        io_path,
        canonical: to_canon(&canonical),
        root_canonical: to_canon(&root_canonical),
    })
}

fn stable_io_path(
    root: &str,
    root_canonical: &Path,
    target_canonical: &Path,
    workspace: &WorkspaceEnv,
) -> Result<String, String> {
    if !workspace.is_wsl() {
        return Ok(to_canon(target_canonical));
    }
    let relative = target_canonical
        .strip_prefix(root_canonical)
        .map_err(|_| "path is outside the session workspace".to_string())?;
    let relative = to_canon(relative);
    if relative.is_empty() {
        Ok(root.to_string())
    } else {
        Ok(normalize_posix_path(&format!(
            "{}/{relative}",
            root.trim_end_matches('/')
        )))
    }
}

/// 以会话 cwd 为基准解析模型路径，但不在此决定是否允许越界。
fn join_workspace_path(root: &str, path: &str, workspace: &WorkspaceEnv) -> String {
    if workspace.is_ssh() || workspace.is_wsl() {
        let path = path.replace('\\', "/");
        let joined = if path.starts_with('/') {
            path
        } else {
            format!("{}/{}", root.trim_end_matches('/'), path)
        };
        return normalize_posix_path(&joined);
    }
    let requested = PathBuf::from(path);
    let joined = if requested.is_absolute() {
        requested
    } else {
        Path::new(root).join(requested)
    };
    normalize_local_path(&joined).to_string_lossy().into_owned()
}

/// 对 SSH 和 WSL 路径执行不访问文件系统的词法归一化。
fn normalize_posix_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    let normalized = parts.join("/");
    if absolute {
        format!("/{normalized}")
    } else {
        normalized
    }
}

/// 按当前平台路径语义解析 `.` 和 `..`，后续再执行 canonical 授权。
fn normalize_local_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            value => normalized.push(value.as_os_str()),
        }
    }
    normalized
}

fn canonicalize_local_nearest(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&current) {
            Ok(mut canonical) => {
                for part in suffix.iter().rev() {
                    canonical.push(part);
                }
                return Ok(canonical);
            }
            Err(_) => {
                let name = current
                    .file_name()
                    .ok_or_else(|| "no accessible ancestor for path".to_string())?
                    .to_os_string();
                suffix.push(name);
                current = current
                    .parent()
                    .ok_or_else(|| "no accessible ancestor for path".to_string())?
                    .to_path_buf();
            }
        }
    }
}

#[cfg(feature = "workspace-runtime")]
async fn canonicalize_remote_nearest(
    workspace: &std::sync::Arc<remote::session::RemoteWorkspace>,
    path: &str,
) -> Result<String, String> {
    let mut current = path.trim_end_matches('/').to_string();
    let mut suffix: Vec<String> = Vec::new();
    loop {
        if let Ok(mut canonical) = remote::sftp::canonicalize(workspace, &current).await {
            for part in suffix.iter().rev() {
                canonical.push('/');
                canonical.push_str(part);
            }
            return Ok(canonical);
        }
        let (parent, name) = current
            .rsplit_once('/')
            .ok_or_else(|| "no accessible ancestor for remote path".to_string())?;
        if name.is_empty() {
            return Err("no accessible ancestor for remote path".into());
        }
        suffix.push(name.to_string());
        current = if parent.is_empty() {
            "/".into()
        } else {
            parent.into()
        };
    }
}

#[cfg(feature = "workspace-runtime")]
fn ensure_within_remote(root: &str, target: &str) -> Result<(), String> {
    let root = root.trim_end_matches('/');
    if target == root || target.starts_with(&format!("{root}/")) {
        Ok(())
    } else {
        Err("path is outside the session workspace".into())
    }
}

async fn ensure_regular_file(path: &str, workspace: &WorkspaceEnv) -> Result<(), String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let canonical = remote::sftp::canonicalize(&remote_workspace, path).await?;
            let stat = remote::sftp::stat(&remote_workspace, &canonical).await?;
            return if stat.kind == remote::sftp::RemoteEntryKind::File {
                Ok(())
            } else {
                Err("path is not a regular file".into())
            };
        }
    }
    let metadata =
        std::fs::metadata(resolve_path(path, workspace)).map_err(|error| error.to_string())?;
    if metadata.is_file() {
        Ok(())
    } else {
        Err("path is not a regular file".into())
    }
}

async fn path_exists(path: &str, workspace: &WorkspaceEnv) -> Result<bool, String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            Err("SSH requires a desktop workspace in this build".into())
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            remote::sftp::exists(&remote_workspace, path).await
        }
    } else {
        resolve_path(path, workspace)
            .try_exists()
            .map_err(|error| error.to_string())
    }
}

async fn path_targets_directory(path: &str, workspace: &WorkspaceEnv) -> Result<bool, String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let canonical = remote::sftp::canonicalize(&remote_workspace, path).await?;
            return Ok(remote::sftp::stat(&remote_workspace, &canonical)
                .await?
                .kind
                == remote::sftp::RemoteEntryKind::Dir);
        }
    }
    Ok(std::fs::metadata(resolve_path(path, workspace))
        .map_err(|error| error.to_string())?
        .is_dir())
}

async fn path_is_symlink(path: &str, workspace: &WorkspaceEnv) -> Result<bool, String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            return Ok(remote::sftp::stat(&remote_workspace, path).await?.kind
                == remote::sftp::RemoteEntryKind::Symlink);
        }
    }
    Ok(std::fs::symlink_metadata(resolve_path(path, workspace))
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink())
}

async fn path_is_directory(path: &str, workspace: &WorkspaceEnv) -> Result<bool, String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            return Ok(remote::sftp::stat(&remote_workspace, path).await?.kind
                == remote::sftp::RemoteEntryKind::Dir);
        }
    }
    Ok(std::fs::symlink_metadata(resolve_path(path, workspace))
        .map_err(|error| error.to_string())?
        .is_dir())
}

fn entry_matches(matcher: Option<&GlobMatcher>, rel: &str, name: &str) -> bool {
    matcher.is_none_or(|matcher| matcher.is_match(rel) || matcher.is_match(name))
}

fn split_parent_and_name(path: &str, workspace: &WorkspaceEnv) -> Result<(String, String), String> {
    if workspace.is_ssh() || workspace.is_wsl() {
        let (parent, name) = path
            .rsplit_once('/')
            .ok_or_else(|| "file path has no parent".to_string())?;
        return Ok((
            if parent.is_empty() { "/" } else { parent }.to_string(),
            name.to_string(),
        ));
    }
    let path = Path::new(path);
    let parent = path
        .parent()
        .ok_or_else(|| "file path has no parent".to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "file name is not valid UTF-8".to_string())?;
    Ok((to_canon(parent), name.to_string()))
}

fn includes_match_file(patterns: &[String], name: &str) -> Result<bool, String> {
    if patterns.is_empty() {
        return Ok(true);
    }
    for pattern in patterns {
        let matcher = Glob::new(pattern)
            .map_err(|error| format!("bad glob: {error}"))?
            .compile_matcher();
        if matcher.is_match(name) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn exact_file_glob(name: &str) -> String {
    let escaped = globset::escape(name);
    escaped
        .strip_prefix('!')
        .map_or(escaped.clone(), |rest| format!("?{rest}"))
}

async fn find_immediate(
    root: &str,
    workspace: &WorkspaceEnv,
    matcher: Option<&GlobMatcher>,
    include_directories: bool,
    include_hidden: bool,
) -> Result<(Vec<AgentFindEntry>, bool), String> {
    let entries = super::tree::fs_read_dir(
        root.to_string(),
        include_hidden,
        Some(false),
        Some(workspace.clone()),
    )
    .await?;
    let truncated = entries.len() > MAX_FIND_SCAN;
    Ok((
        entries
            .into_iter()
            .take(MAX_FIND_SCAN)
            .filter_map(|entry| convert_dir_entry(root, entry, matcher, include_directories))
            .collect(),
        truncated,
    ))
}

fn convert_dir_entry(
    root: &str,
    entry: DirEntry,
    matcher: Option<&GlobMatcher>,
    include_directories: bool,
) -> Option<AgentFindEntry> {
    let kind = match entry.kind {
        EntryKind::File => AgentPathKind::File,
        EntryKind::Dir if include_directories => AgentPathKind::Directory,
        EntryKind::Dir => return None,
        EntryKind::Symlink => AgentPathKind::Symlink,
    };
    if !entry_matches(matcher, &entry.name, &entry.name) {
        return None;
    }
    Some(AgentFindEntry {
        path: format!("{}/{}", root.trim_end_matches('/'), entry.name),
        rel: entry.name,
        kind,
        size: entry.size,
    })
}

async fn find_recursive(
    root: &str,
    workspace: &WorkspaceEnv,
    matcher: Option<&GlobMatcher>,
    include_directories: bool,
    include_hidden: bool,
) -> Result<(Vec<AgentFindEntry>, bool), String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let (entries, truncated) = remote::tree_service::walk(
                &remote_workspace,
                root,
                include_hidden,
                16,
                MAX_FIND_SCAN,
            )
            .await?;
            return Ok((
                entries
                    .into_iter()
                    .filter_map(|entry| {
                        let kind = match entry.kind {
                            remote::sftp::RemoteEntryKind::File => AgentPathKind::File,
                            remote::sftp::RemoteEntryKind::Dir if include_directories => {
                                AgentPathKind::Directory
                            }
                            remote::sftp::RemoteEntryKind::Dir => return None,
                            remote::sftp::RemoteEntryKind::Symlink => AgentPathKind::Symlink,
                        };
                        entry_matches(matcher, &entry.rel, &entry.name).then_some(AgentFindEntry {
                            path: entry.path,
                            rel: entry.rel,
                            kind,
                            size: entry.size,
                        })
                    })
                    .collect(),
                truncated,
            ));
        }
    }
    let host_root = resolve_path(root, workspace);
    if !host_root.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let walker = WalkBuilder::new(&host_root)
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(16))
        .build();
    let mut entries = Vec::new();
    let mut truncated = false;
    for (index, item) in walker.flatten().skip(1).enumerate() {
        if index >= MAX_FIND_SCAN {
            truncated = true;
            break;
        }
        let rel = match item.path().strip_prefix(&host_root) {
            Ok(value) => to_canon(value),
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy();
        if !entry_matches(matcher, &rel, &name) {
            continue;
        }
        let file_type = item.file_type();
        let kind = if file_type.is_some_and(|kind| kind.is_file()) {
            AgentPathKind::File
        } else if file_type.is_some_and(|kind| kind.is_dir()) {
            if !include_directories {
                continue;
            }
            AgentPathKind::Directory
        } else {
            AgentPathKind::Symlink
        };
        let size = item.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        entries.push(AgentFindEntry {
            path: format!("{}/{}", root.trim_end_matches('/'), rel),
            rel,
            kind,
            size,
        });
    }
    Ok((entries, truncated))
}

async fn read_context_file(workspace: &WorkspaceEnv, path: &str) -> Result<Vec<String>, String> {
    let result =
        super::file::fs_read_file(path.to_string(), Some(workspace.clone()), Some(false)).await?;
    let ReadResult::Text { content, .. } = result else {
        return Ok(Vec::new());
    };
    Ok(content.lines().map(str::to_string).collect())
}

fn context_for_hit(
    lines: &[String],
    line: u64,
    context: usize,
) -> (Vec<AgentContextLine>, Vec<AgentContextLine>) {
    let index = line.saturating_sub(1) as usize;
    if index >= lines.len() {
        return (Vec::new(), Vec::new());
    }
    let before_start = index.saturating_sub(context);
    let before = lines[before_start..index.min(lines.len())]
        .iter()
        .enumerate()
        .map(|(offset, text)| AgentContextLine {
            line: (before_start + offset + 1) as u64,
            text: clip_text(text.trim_end_matches('\r'), 320),
        })
        .collect();
    let after_start = index.saturating_add(1).min(lines.len());
    let after_end = after_start.saturating_add(context).min(lines.len());
    let after = lines[after_start..after_end]
        .iter()
        .enumerate()
        .map(|(offset, text)| AgentContextLine {
            line: (after_start + offset + 1) as u64,
            text: clip_text(text.trim_end_matches('\r'), 320),
        })
        .collect();
    (before, after)
}

async fn prepare_writes(
    state: &AgentFileState,
    registry: &WorkspaceRegistry,
    owner: &str,
    path_context: AgentPathContext<'_>,
    input: AgentMutationInput,
) -> Result<Vec<PreparedWrite>, String> {
    let AgentPathContext {
        root,
        workspace,
        permission_mode,
    } = path_context;
    match input {
        AgentMutationInput::Write {
            path,
            content,
            mode,
        } => {
            if content.len() > MAX_MUTATION_BYTES {
                return Err("file content exceeds mutation limit".into());
            }
            let authorized =
                authorize_path(registry, root, &path, workspace, permission_mode, false).await?;
            state.bind_scope(owner, &authorized, workspace)?;
            match mode {
                AgentWriteMode::Create => {
                    if path_exists(&authorized.io_path, workspace).await? {
                        return Err(format!("file already exists: {}. Use mode=\"rewrite\" only after reading or successfully writing the complete current content; use apply_patch for partial edits. No files were written.", authorized.actual));
                    }
                    Ok(vec![PreparedWrite {
                        path: authorized.actual,
                        io_path: authorized.io_path,
                        canonical: authorized.canonical,
                        before: String::new(),
                        after: content,
                        condition: WriteCondition::Missing,
                        is_new_file: true,
                        replacements: 0,
                    }])
                }
                AgentWriteMode::Rewrite => {
                    let snapshot = read_text_snapshot(&authorized.io_path, workspace).await?;
                    if snapshot.content.len().saturating_add(content.len()) > MAX_PREVIEW_BYTES {
                        return Err("file preview exceeds mutation limit".into());
                    }
                    require_read_version(state, owner, &authorized.canonical, &snapshot.version)?;
                    Ok(vec![PreparedWrite {
                        path: authorized.actual,
                        io_path: authorized.io_path,
                        canonical: authorized.canonical,
                        before: snapshot.content,
                        after: content,
                        condition: WriteCondition::Match {
                            version: snapshot.version,
                        },
                        is_new_file: false,
                        replacements: 0,
                    }])
                }
            }
        }
        AgentMutationInput::Patch { files } => {
            if files.is_empty() || files.len() > MAX_PATCH_FILES {
                return Err(format!("patch must contain 1 to {MAX_PATCH_FILES} files"));
            }
            let mut seen = HashSet::new();
            let mut authorized_files = Vec::with_capacity(files.len());
            let mut missing_reads = Vec::new();
            for file in files {
                if file.edits.is_empty() || file.edits.len() > MAX_EDITS_PER_FILE {
                    return Err(format!(
                        "each patch file must contain 1 to {MAX_EDITS_PER_FILE} edits"
                    ));
                }
                let authorized =
                    authorize_path(registry, root, &file.path, workspace, permission_mode, true)
                        .await?;
                state.bind_scope(owner, &authorized, workspace)?;
                if !seen.insert(authorized.canonical.clone()) {
                    return Err(format!("duplicate patch path: {}", authorized.actual));
                }
                if state.read_version(owner, &authorized.canonical).is_none() {
                    missing_reads.push(authorized.actual.clone());
                }
                authorized_files.push((file, authorized));
            }
            if !missing_reads.is_empty() {
                return Err(format!(
                    "must call read_file on these paths first:\n{}\nNo files were written.",
                    missing_reads.join("\n")
                ));
            }
            let mut total_bytes: usize = 0;
            let mut writes = Vec::with_capacity(authorized_files.len());
            for (file, authorized) in authorized_files {
                let snapshot = read_text_snapshot(&authorized.io_path, workspace).await?;
                require_read_version(state, owner, &authorized.canonical, &snapshot.version)?;
                let (after, replacements) = apply_edits(snapshot.content.clone(), &file.edits)
                    .map_err(|error| {
                        format!("{}: {error}. No files were written.", authorized.actual)
                    })?;
                total_bytes = total_bytes
                    .saturating_add(snapshot.content.len())
                    .saturating_add(after.len());
                if total_bytes > MAX_PREVIEW_BYTES {
                    return Err("patch preview exceeds mutation limit".into());
                }
                writes.push(PreparedWrite {
                    path: authorized.actual,
                    io_path: authorized.io_path,
                    canonical: authorized.canonical,
                    before: snapshot.content,
                    after,
                    condition: WriteCondition::Match {
                        version: snapshot.version,
                    },
                    is_new_file: false,
                    replacements,
                });
            }
            Ok(writes)
        }
    }
}

struct TextSnapshot {
    content: String,
    version: FileVersion,
}

async fn read_text_snapshot(path: &str, workspace: &WorkspaceEnv) -> Result<TextSnapshot, String> {
    ensure_regular_file(path, workspace).await?;
    match super::file::fs_read_file(path.to_string(), Some(workspace.clone()), Some(false)).await? {
        ReadResult::Text {
            content,
            size,
            mtime,
            revision,
        } => Ok(TextSnapshot {
            content,
            version: FileVersion {
                revision,
                size,
                mtime,
            },
        }),
        ReadResult::Binary { .. } => Err("binary file refused".into()),
        ReadResult::TooLarge { size, limit, .. } => {
            Err(format!("file too large ({size} bytes, limit {limit})"))
        }
    }
}

fn require_read_version(
    state: &AgentFileState,
    owner: &str,
    path: &str,
    current: &FileVersion,
) -> Result<(), String> {
    let read = state
        .read_version(owner, path)
        .ok_or_else(|| format!("must call read_file on this path first: {path}"))?;
    if versions_equal(&read, current) {
        Ok(())
    } else {
        Err(format!("file changed since read_file: {path}"))
    }
}

fn apply_edits(mut content: String, edits: &[AgentTextEdit]) -> Result<(String, usize), String> {
    let uses_crlf = content.contains("\r\n");
    if uses_crlf {
        content = content.replace("\r\n", "\n");
    }
    let mut replacements = 0;
    for (index, edit) in edits.iter().enumerate() {
        let fail = |message: String| {
            format!(
                "file edit {} (1-based within this path): {message}",
                index + 1
            )
        };
        let old_text = edit.old_text.replace("\r\n", "\n");
        let new_text = edit.new_text.replace("\r\n", "\n");
        if old_text.is_empty() {
            return Err(fail("old_text cannot be empty".into()));
        }
        if old_text == new_text {
            return Err(fail("old_text and new_text are identical".into()));
        }
        let count = content.matches(&old_text).count();
        if count == 0 {
            let diagnostic = near_match_diagnostic(&content, &old_text);
            return Err(fail(format!(
                "old_text not found: {:?}{diagnostic}",
                clip_text(&old_text, 120),
            )));
        }
        if !edit.replace_all && count != 1 {
            let lines = occurrence_lines(&content, &old_text, 3)
                .into_iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(fail(format!(
                "old_text appears {count} times at line(s) {lines}; provide more context or set replace_all=true"
            )));
        }
        if let Some(expected) = edit.expected_replacements {
            if expected == 0 || count != expected {
                return Err(fail(format!("expected {expected} replacements but found {count}; reread the target and revise expected_replacements or old_text")));
            }
        }
        if edit.replace_all {
            content = content.replace(&old_text, &new_text);
            replacements += count;
        } else if let Some(index) = content.find(&old_text) {
            content.replace_range(index..index + old_text.len(), &new_text);
            replacements += 1;
        }
    }
    if uses_crlf {
        content = content.replace('\n', "\r\n");
    }
    Ok((content, replacements))
}

fn occurrence_lines(content: &str, needle: &str, limit: usize) -> Vec<usize> {
    content
        .match_indices(needle)
        .take(limit)
        .map(|(index, _)| {
            content[..index]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count()
                + 1
        })
        .collect()
}

/// 相近文本只用于有界诊断，不放宽实际匹配，也不修改模型提交的替换内容。
fn near_match_diagnostic(content: &str, expected: &str) -> String {
    let Some((line, _)) = closest_line(content, expected) else {
        return "; no similar text found; reread the target range".into();
    };
    let leading_empty = expected
        .lines()
        .take_while(|line| line.trim().is_empty())
        .count();
    let start = line.saturating_sub(1 + leading_empty);
    let wanted: Vec<_> = expected.lines().collect();
    let actual: Vec<_> = content.lines().skip(start).take(wanted.len()).collect();
    // 围绕首个差异选窗口，避免长补丁仅展示相同的开头；实际匹配仍然严格。
    let first_difference = wanted
        .iter()
        .enumerate()
        .position(|(index, before)| actual.get(index) != Some(before))
        .unwrap_or_else(|| wanted.len().saturating_sub(1));
    let window_start = first_difference.saturating_sub(2);
    let window_end = (window_start + 6).min(wanted.len());
    let omitted_after = window_end < wanted.len();
    let wanted = &wanted[window_start..window_end];
    let actual = &actual[window_start.min(actual.len())..window_end.min(actual.len())];
    let wanted_text = wanted.join("\n");
    let actual_text = actual.join("\n");
    let whitespace = |text: &str| {
        text.lines()
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let quotes = |text: &str| {
        text.chars()
            .map(|ch| match ch {
                '‘' | '’' => '\'',
                '“' | '”' => '"',
                ch => ch,
            })
            .collect::<String>()
    };
    let mut causes = Vec::new();
    if wanted_text != actual_text {
        if whitespace(&wanted_text) == whitespace(&actual_text) {
            causes.push("whitespace or indentation differs");
        }
        if wanted_text.to_lowercase() == actual_text.to_lowercase() {
            causes.push("letter case differs");
        }
        if quotes(&wanted_text) == quotes(&actual_text) {
            causes.push("quote style differs");
        }
    }
    if expected.ends_with('\n')
        && !content.ends_with('\n')
        && content.ends_with(expected.trim_end_matches('\n'))
    {
        causes.push("trailing newline differs");
    }
    let mut diagnostic = format!("; closest line {}", start + 1);
    if !causes.is_empty() {
        diagnostic.push_str(&format!("; possible cause: {}", causes.join(", ")));
    }
    diagnostic.push_str(&format!(
        "\n@@ line {} (provided - / actual +) @@",
        start + window_start + 1
    ));
    if window_start > 0 {
        diagnostic.push_str("\n... earlier lines omitted ...");
    }
    for index in 0..wanted.len().max(actual.len()) {
        match (wanted.get(index), actual.get(index)) {
            (Some(before), Some(after)) if before == after => {
                diagnostic.push_str(&format!("\n {}", clip_text(before, 160)))
            }
            (before, after) => {
                if let Some(before) = before {
                    diagnostic.push_str(&format!("\n-{}", clip_text(before, 160)));
                }
                if let Some(after) = after {
                    diagnostic.push_str(&format!("\n+{}", clip_text(after, 160)));
                }
            }
        }
    }
    if omitted_after {
        diagnostic.push_str("\n... later lines omitted ...");
    }
    clip_text(&diagnostic, 2000)
}

fn closest_line<'a>(content: &'a str, expected: &str) -> Option<(usize, &'a str)> {
    let reference = expected
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let reference = reference.to_lowercase();
    let tokens: Vec<_> = reference
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| token.len() >= 3)
        .collect();
    content
        .lines()
        .enumerate()
        .map(|(index, line)| {
            let trimmed = line.trim().to_lowercase();
            let token_score = tokens
                .iter()
                .filter(|token| trimmed.contains(**token))
                .count();
            let prefix_score = reference
                .chars()
                .zip(trimmed.chars())
                .take_while(|(left, right)| left == right)
                .count();
            (
                token_score.saturating_mul(32) + prefix_score,
                index + 1,
                line,
            )
        })
        .filter(|(score, _, _)| *score > 0)
        .max_by_key(|(score, _, _)| *score)
        .map(|(_, line, text)| (line, text))
}

fn preview_for(mutation: &PreparedMutation) -> AgentMutationPreview {
    AgentMutationPreview {
        files: mutation
            .writes
            .iter()
            .map(|write| AgentFilePreview {
                path: write.path.clone(),
                identity: if cfg!(windows) && matches!(mutation.workspace, WorkspaceEnv::Local) {
                    write.canonical.to_ascii_lowercase()
                } else {
                    write.canonical.clone()
                },
                before: write.before.clone(),
                after: write.after.clone(),
                is_new_file: write.is_new_file,
                replacements: write.replacements,
            })
            .collect(),
    }
}

async fn validate_prepared(
    registry: &WorkspaceRegistry,
    mutation: &PreparedMutation,
) -> Result<(), String> {
    for write in &mutation.writes {
        let authorized = authorize_path(
            registry,
            &mutation.root,
            &write.path,
            &mutation.workspace,
            mutation.permission_mode,
            false,
        )
        .await?;
        if !paths_equal(&authorized.canonical, &write.canonical, &mutation.workspace) {
            return Err(format!("file path changed after approval: {}", write.path));
        }
        if !paths_equal(&authorized.io_path, &write.io_path, &mutation.workspace) {
            return Err(format!(
                "file target changed after approval: {}",
                write.path
            ));
        }
        match &write.condition {
            WriteCondition::Missing => {
                if path_exists(&write.io_path, &mutation.workspace).await? {
                    return Err(format!("file was created after approval: {}", write.path));
                }
            }
            WriteCondition::Match { version } => {
                let current = read_text_snapshot(&write.io_path, &mutation.workspace).await?;
                if !versions_equal(version, &current.version) {
                    return Err(format!("file changed after approval: {}", write.path));
                }
            }
            WriteCondition::Overwrite => {
                return Err("unconditional Agent writes are not allowed".into())
            }
        }
    }
    Ok(())
}

async fn ensure_parent(path: &str, workspace: &WorkspaceEnv) -> Result<(), String> {
    let parent = if workspace.is_ssh() || workspace.is_wsl() {
        path.rsplit_once('/').map(|(parent, _)| parent)
    } else {
        Path::new(path).parent().and_then(Path::to_str)
    }
    .filter(|parent| !parent.is_empty())
    .ok_or_else(|| "file path has no parent".to_string())?;
    if path_exists(parent, workspace).await? {
        return Ok(());
    }
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            return remote::mutation_service::create_directory(&remote_workspace, parent).await;
        }
    }
    std::fs::create_dir_all(resolve_path(parent, workspace)).map_err(|error| error.to_string())
}

async fn rollback_writes(
    app: &dyn super::file::FileEvents,
    workspace: &WorkspaceEnv,
    committed: &[(PreparedWrite, FileVersion)],
) -> Vec<String> {
    let mut failures = Vec::new();
    for (write, current) in committed.iter().rev() {
        if write.is_new_file {
            let unchanged = read_text_snapshot(&write.io_path, workspace)
                .await
                .is_ok_and(|snapshot| versions_equal(&snapshot.version, current));
            if !unchanged
                || super::mutate::fs_delete(write.io_path.clone(), Some(workspace.clone()))
                    .await
                    .is_err()
            {
                failures.push(write.path.clone());
            }
            continue;
        }
        let result = super::file::fs_write_file_checked(
            write.io_path.clone(),
            write.before.clone(),
            WriteCondition::Match {
                version: current.clone(),
            },
            Some(workspace.clone()),
            Some("ai-rollback".into()),
            app,
        )
        .await;
        if !matches!(result, Ok(CheckedWriteResult::Written { .. })) {
            failures.push(write.path.clone());
        }
    }
    failures
}

/// 回滚失败时保留不确定路径，展示层不能把未确认的磁盘状态记为零改动。
fn mutation_failure(error: String, failures: Vec<String>) -> Result<AgentMutationResult, String> {
    if failures.is_empty() {
        Err(error)
    } else {
        Ok(AgentMutationResult {
            files: Vec::new(),
            error: Some(format!(
                "{error}; rollback could not restore: {}",
                failures.join(", ")
            )),
            uncertain_paths: failures,
        })
    }
}

async fn copy_file(
    source: &str,
    destination: &str,
    workspace: &WorkspaceEnv,
) -> Result<(), String> {
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "workspace-runtime"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "workspace-runtime")]
        {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let bytes = remote::sftp::read_file(&remote_workspace, source, MAX_COPY_BYTES).await?;
            return match remote::sftp::write_file_missing(&remote_workspace, destination, &bytes)
                .await?
            {
                remote::file_service::RemoteCheckedWrite::Written { .. } => Ok(()),
                remote::file_service::RemoteCheckedWrite::Conflict { .. } => {
                    Err(format!("destination already exists: {destination}"))
                }
            };
        }
    }
    let source = resolve_path(source, workspace);
    let destination = resolve_path(destination, workspace);
    let mut source_file = std::fs::File::open(&source).map_err(|error| error.to_string())?;
    let metadata = source_file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("copy currently supports files only".into());
    }
    let size = metadata.len();
    if size > MAX_COPY_BYTES {
        return Err(format!(
            "file too large to copy ({size} bytes, limit {MAX_COPY_BYTES})"
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "destination has no parent".to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let copied = std::io::copy(
        &mut std::io::Read::take(&mut source_file, MAX_COPY_BYTES + 1),
        staged.as_file_mut(),
    )
    .map_err(|error| error.to_string())?;
    if copied > MAX_COPY_BYTES {
        return Err(format!(
            "file grew beyond copy limit ({MAX_COPY_BYTES} bytes)"
        ));
    }
    staged
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| error.to_string())?;
    staged.persist_noclobber(&destination).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("destination already exists: {}", destination.display())
        } else {
            error.error.to_string()
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn patch_diagnostic_shows_late_difference_and_omissions() {
        let actual =
            "unique_anchor\none\ntwo\nthree\nfour\nfive\nactual_value\nseven\neight\nnine\nten\n";
        let expected = actual.replace("actual_value", "wrong_value");
        let diagnostic = super::near_match_diagnostic(actual, &expected);
        assert!(diagnostic.contains("-wrong_value"), "{diagnostic}");
        assert!(diagnostic.contains("+actual_value"), "{diagnostic}");
        assert!(diagnostic.contains("earlier lines omitted"));
        assert!(diagnostic.contains("later lines omitted"));
        assert!(diagnostic.chars().count() <= 2014);
        let missing = super::near_match_diagnostic("anchor\n", "anchor\nmissing\n");
        assert!(missing.contains("-missing"));
    }
    use super::*;

    #[tokio::test]
    async fn batch_patch_reports_all_missing_reads_without_writing_and_can_retry() {
        let directory = tempfile::tempdir().unwrap();
        let root = to_canon(directory.path());
        let state = AgentFileState::default();
        let registry = WorkspaceRegistry::default();
        registry.authorize(directory.path()).unwrap();
        let owner = Uuid::new_v4().to_string();
        let names = ["read.txt", "unread-a.txt", "unread-b.txt"];
        for name in names {
            std::fs::write(directory.path().join(name), "before\r\n").unwrap();
        }
        let read = |path| {
            agent_file_read(
                &state,
                &registry,
                serde_json::from_value(serde_json::json!({
                    "ownerSessionId": owner, "toolCallId": "read-call", "visibleReadIds": ["read-call"], "root": root, "permissionMode": "ask", "path": path
                }))
                .unwrap(),
            )
        };
        let prepare = || {
            agent_file_prepare_mutation(&state, &registry, serde_json::from_value(serde_json::json!({
                "ownerSessionId": owner, "toolCallId": "edit", "root": root, "permissionMode": "ask",
                "mutation": { "kind": "patch", "files": names.map(|path| serde_json::json!({
                    "path": path, "edits": [{ "old_text": "before", "new_text": "after" }]
                })) }
            })).unwrap())
        };
        read(names[0]).await.unwrap();
        let error = prepare().await.err().unwrap();
        assert!(error.contains("unread-a.txt"), "{error}");
        assert!(error.contains("unread-b.txt"), "{error}");
        assert!(!error.contains("/read.txt"), "{error}");
        assert!(error.contains("No files were written"), "{error}");
        assert!(state.prepared.lock().await.is_empty());
        for name in names {
            assert_eq!(
                std::fs::read_to_string(directory.path().join(name)).unwrap(),
                "before\r\n"
            );
        }
        for name in &names[1..] {
            read(*name).await.unwrap();
        }
        assert_eq!(prepare().await.unwrap().files.len(), names.len());
        let result = agent_file_commit_mutation(
            &state,
            &registry,
            &(),
            AgentMutationKeyRequest {
                owner_session_id: owner.clone(),
                tool_call_id: "edit".into(),
            },
        )
        .await
        .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        for name in names {
            assert_eq!(
                std::fs::read_to_string(directory.path().join(name)).unwrap(),
                "after\r\n"
            );
        }
    }

    #[tokio::test]
    async fn committed_mutations_keep_edit_versions_without_marking_content_as_read() {
        let directory = tempfile::tempdir().unwrap();
        let root = to_canon(directory.path());
        let state = AgentFileState::default();
        let registry = WorkspaceRegistry::default();
        registry.authorize(directory.path()).unwrap();
        let owner = Uuid::new_v4().to_string();
        let read = |start_line| {
            agent_file_read(&state, &registry, serde_json::from_value(serde_json::json!({
            "ownerSessionId": owner, "toolCallId": "read-call", "visibleReadIds": ["read-call"], "root": root, "permissionMode": "full-access", "path": "a.txt", "startLine": start_line
        })).unwrap())
        };
        for (index, (mutation, expected, reread)) in [
            (serde_json::json!({ "kind": "write", "path": "a.txt", "content": "first\n", "mode": "create" }), "first", false),
            (serde_json::json!({ "kind": "patch", "files": [{ "path": "a.txt", "edits": [{ "old_text": "first", "new_text": "authored" }] }] }), "authored", true),
            (serde_json::json!({ "kind": "write", "path": "a.txt", "content": "second\n", "mode": "rewrite" }), "second", true),
            (serde_json::json!({ "kind": "patch", "files": [{ "path": "a.txt", "edits": [{ "old_text": "second", "new_text": "third!" }] }] }), "third!", false),
            (serde_json::json!({ "kind": "patch", "files": [{ "path": "a.txt", "edits": [{ "old_text": "third!", "new_text": "fourth" }] }] }), "fourth", true),
        ].into_iter().enumerate() {
            let tool_call_id = format!("edit-{index}");
            agent_file_prepare_mutation(&state, &registry, serde_json::from_value(serde_json::json!({
                "ownerSessionId": owner, "toolCallId": tool_call_id, "root": root,
                "permissionMode": "full-access", "mutation": mutation
            })).unwrap()).await.unwrap();
            let result = agent_file_commit_mutation(&state, &registry, &(), AgentMutationKeyRequest {
                owner_session_id: owner.clone(), tool_call_id,
            }).await.unwrap();
            assert!(result.error.is_none(), "{:?}", result.error);
            if reread {
                let response = read(1).await.unwrap();
                assert!(!response.unchanged, "mutation {index} was not read yet");
                assert!(response.content.contains(expected));
                assert_eq!(response.size, (expected.len() + 1) as u64);
                let cached = read(1).await.unwrap();
                assert!(cached.unchanged);
                assert!(cached.content.is_empty());
            }
        }
        // 超出文件末尾的失败读取不应登记范围，也不能使下次失败请求变成 unchanged。
        for _ in 0..2 {
            assert!(read(2).await.is_err());
        }
        assert!(read(1).await.unwrap().unchanged);
        let after_compaction = agent_file_read(
            &state,
            &registry,
            serde_json::from_value(serde_json::json!({
                "ownerSessionId": owner, "toolCallId": "after-compaction", "visibleReadIds": [],
                "root": root, "permissionMode": "full-access", "path": "a.txt"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert!(!after_compaction.unchanged);
        assert!(after_compaction.content.contains("fourth"));
    }

    #[tokio::test]
    async fn batch_patch_count_and_match_diagnostics_never_publish_partial_writes() {
        let directory = tempfile::tempdir().unwrap();
        let root = to_canon(directory.path());
        let state = AgentFileState::default();
        let registry = WorkspaceRegistry::default();
        registry.authorize(directory.path()).unwrap();
        let owner = Uuid::new_v4().to_string();
        for name in ["a.txt", "b.py"] {
            std::fs::write(
                directory.path().join(name),
                "    value = 1\r\n    return value\r\n",
            )
            .unwrap();
            agent_file_read(
                &state,
                &registry,
                serde_json::from_value(serde_json::json!({
                    "ownerSessionId": owner, "toolCallId": name, "visibleReadIds": [], "root": root,
                    "permissionMode": "ask", "path": name
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        }
        for (edit, detail) in [
            (
                serde_json::json!({"old_text": "value", "new_text": "result", "replace_all": true, "expected_replacements": 3}),
                "expected 3 replacements but found 2",
            ),
            (
                serde_json::json!({"old_text": "value = 1\nreturn value", "new_text": "value = 2\nreturn value"}),
                "whitespace or indentation differs",
            ),
        ] {
            let error = agent_file_prepare_mutation(&state, &registry, serde_json::from_value(serde_json::json!({
                "ownerSessionId": owner, "toolCallId": "invalid", "root": root, "permissionMode": "ask",
                "mutation": {"kind": "patch", "files": [
                    {"path": "a.txt", "edits": [{"old_text": "value", "new_text": "first", "replace_all": true}]},
                    {"path": "b.py", "edits": [edit]}
                ]}
            })).unwrap()).await.err().unwrap();
            assert!(
                error.contains("b.py: file edit 1 (1-based within this path):"),
                "{error}"
            );
            assert!(error.contains(detail), "{error}");
            assert!(error.contains("No files were written"), "{error}");
            assert!(state.prepared.lock().await.is_empty());
            for name in ["a.txt", "b.py"] {
                assert_eq!(
                    std::fs::read(directory.path().join(name)).unwrap(),
                    b"    value = 1\r\n    return value\r\n"
                );
            }
        }
    }

    #[tokio::test]
    async fn failed_batch_reports_uncertain_paths_only_when_rollback_cannot_restore() {
        struct ConcurrentWrite {
            first: PathBuf,
            second: PathBuf,
            overwrite_first: bool,
        }
        impl super::super::file::FileEvents for ConcurrentWrite {
            fn file_written(&self, path: &str, source: Option<String>) {
                if source.as_deref() == Some("ai")
                    && Path::new(path).file_name().unwrap() == "a.txt"
                {
                    // 在第一份文件发布后制造第二份基线冲突，并可选地阻止第一份回滚。
                    std::fs::write(&self.second, "external b").unwrap();
                    if self.overwrite_first {
                        std::fs::write(&self.first, "external a").unwrap();
                    }
                }
            }
        }
        for overwrite_first in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = to_canon(directory.path());
            let state = AgentFileState::default();
            let registry = WorkspaceRegistry::default();
            registry.authorize(directory.path()).unwrap();
            let owner = Uuid::new_v4().to_string();
            for name in ["a.txt", "b.txt"] {
                std::fs::write(directory.path().join(name), "before\r\n").unwrap();
                agent_file_read(&state, &registry, serde_json::from_value(serde_json::json!({
                    "ownerSessionId": owner, "toolCallId": "read-call", "visibleReadIds": ["read-call"], "root": root, "permissionMode": "full-access", "path": name
                })).unwrap()).await.unwrap();
            }
            let preview = agent_file_prepare_mutation(&state, &registry, serde_json::from_value(serde_json::json!({
                "ownerSessionId": owner, "toolCallId": "edit", "root": root, "permissionMode": "full-access",
                "mutation": { "kind": "patch", "files": [
                    { "path": "a.txt", "edits": [{ "old_text": "before", "new_text": "after" }] },
                    { "path": "b.txt", "edits": [{ "old_text": "before", "new_text": "after" }] }
                ] }
            })).unwrap()).await.unwrap();
            assert_eq!(preview.files[0].before, "before\r\n");
            assert_eq!(preview.files[0].after, "after\r\n");
            assert!(!preview.files[0].identity.is_empty());
            let events = ConcurrentWrite {
                first: directory.path().join("a.txt"),
                second: directory.path().join("b.txt"),
                overwrite_first,
            };
            let result = agent_file_commit_mutation(
                &state,
                &registry,
                &events,
                AgentMutationKeyRequest {
                    owner_session_id: owner,
                    tool_call_id: "edit".into(),
                },
            )
            .await;
            if overwrite_first {
                let result = result.unwrap();
                assert!(result.error.is_some());
                assert!(result.files.is_empty());
                assert_eq!(result.uncertain_paths, vec![preview.files[0].path.clone()]);
                assert_eq!(
                    std::fs::read_to_string(&events.first).unwrap(),
                    "external a"
                );
            } else {
                assert!(result.is_err());
                assert_eq!(
                    std::fs::read_to_string(&events.first).unwrap(),
                    "before\r\n"
                );
            }
            assert_eq!(
                std::fs::read_to_string(&events.second).unwrap(),
                "external b"
            );
        }
    }

    #[test]
    fn read_window_uses_one_based_lines_and_utf8_boundaries() {
        let response =
            format_read_response("/work/a.txt".into(), "一\ntwo\nthree\n".into(), 16, 2, 1)
                .unwrap();
        assert_eq!(response.content, "2| two");
        assert_eq!(response.end_line, 2);
        assert_eq!(response.next_line, Some(3));
        assert!(response.truncated);
        assert_eq!(truncate_utf8("中文", 4), "中");
    }

    #[test]
    fn path_normalization_resolves_parent_components() {
        assert_eq!(normalize_posix_path("/work/../secret"), "/secret");
        assert_eq!(
            normalize_local_path(&Path::new("work").join("..").join("secret")),
            PathBuf::from("secret")
        );
        assert_eq!(
            stable_io_path(
                "/workspace",
                Path::new("/host/root"),
                Path::new("/host/root/real/file.txt"),
                &WorkspaceEnv::Wsl {
                    distro: "Ubuntu".into(),
                },
            )
            .unwrap(),
            "/workspace/real/file.txt",
        );
    }

    #[test]
    fn sensitive_paths_are_rejected_without_hiding_normal_dotfiles() {
        for path in [
            "/work/.env",
            r"C:\work\.env::$DATA",
            r"C:\work\.env. ",
            "/work/.git/config",
            "/work/id_ed25519.pub",
            "/work/server.pem.bak",
            "/work/known_hosts.old",
            "/work/secrets.yaml.bak",
            "/work/service-account-prod.json",
            r"C:\Users\me\AppData\Roaming\Microsoft\Credentials\item",
            "/proc/self/environ",
        ] {
            assert!(ensure_safe_path(path).is_err(), "accepted {path}");
        }
        assert!(ensure_safe_path("/work/.github/workflows/ci.yml").is_ok());
        assert!(ensure_safe_path("/work/.editorconfig").is_ok());
        assert!(ensure_safe_path("/work/etc/config.toml").is_ok());
        assert!(ensure_safe_path("/work/var/db/schema.sql").is_ok());
        assert!(ensure_safe_path("/work/id_rsaxyz.txt").is_ok());
        assert!(ensure_safe_path(r"C:\work\windows\mod.rs").is_ok());
        assert!(ensure_safe_path(r"C:\Windows\System32\config").is_err());
        assert!(ensure_safe_windows_path(r"C:\work\normal.txt:stream").is_err());
        assert!(ensure_safe_windows_path(r"C:\work\NUL.txt").is_err());
        assert!(ensure_safe_windows_path(r"C:\work\normal.txt").is_ok());
    }

    #[test]
    fn exact_edits_apply_in_order_and_reject_ambiguity() {
        let edits = vec![
            AgentTextEdit {
                old_text: "alpha".into(),
                new_text: "gamma".into(),
                replace_all: false,
                expected_replacements: None,
            },
            AgentTextEdit {
                old_text: "gamma beta".into(),
                new_text: "done".into(),
                replace_all: false,
                expected_replacements: None,
            },
        ];
        assert_eq!(
            apply_edits("alpha beta".into(), &edits).unwrap(),
            ("done".into(), 2)
        );
        let ambiguity = apply_edits(
            "same same".into(),
            &[AgentTextEdit {
                old_text: "same".into(),
                new_text: "other".into(),
                replace_all: false,
                expected_replacements: None,
            }],
        )
        .unwrap_err();
        assert!(ambiguity.contains("line(s) 1, 1"));
        let missing = apply_edits(
            "const value = 1;\nreturn value;".into(),
            &[AgentTextEdit {
                old_text: "const value = 2;".into(),
                new_text: "const value = 3;".into(),
                replace_all: false,
                expected_replacements: None,
            }],
        )
        .unwrap_err();
        assert!(missing.contains("closest line 1"));

        let (crlf, replacements) = apply_edits(
            "first\r\nsecond\r\n".into(),
            &[AgentTextEdit {
                old_text: "first\nsecond".into(),
                new_text: "one\ntwo".into(),
                replace_all: false,
                expected_replacements: None,
            }],
        )
        .unwrap();
        assert_eq!(crlf, "one\r\ntwo\r\n");
        assert_eq!(replacements, 1);
    }

    #[test]
    fn explicit_file_globs_are_literal_and_include_filters_still_apply() {
        assert_eq!(exact_file_glob("a[1].rs"), "a[[]1[]].rs");
        assert!(includes_match_file(&["*.rs".into()], "a.rs").unwrap());
        assert!(includes_match_file(&["**/*.rs".into()], "a.rs").unwrap());
        assert!(!includes_match_file(&["*.ts".into()], "a.rs").unwrap());
        assert!(Glob::new(&exact_file_glob("!important.rs"))
            .unwrap()
            .compile_matcher()
            .is_match("!important.rs"));
        assert!(Glob::new(&exact_file_glob("!a,b.rs"))
            .unwrap()
            .compile_matcher()
            .is_match("!a,b.rs"));
    }

    #[test]
    fn immediate_listing_can_include_directories_without_recursive_walk() {
        let directory = DirEntry {
            name: "src".into(),
            kind: EntryKind::Dir,
            size: 0,
            mtime: 0,
            gitignored: false,
        };
        assert!(convert_dir_entry("/work", directory, None, true).is_some());
        let directory = DirEntry {
            name: "src".into(),
            kind: EntryKind::Dir,
            size: 0,
            mtime: 0,
            gitignored: false,
        };
        assert!(convert_dir_entry("/work", directory, None, false).is_none());
    }

    #[test]
    fn grep_context_tolerates_a_file_changing_after_search() {
        let lines = vec!["one".into(), "two".into(), "three".into()];
        let (before, after) = context_for_hit(&lines, 2, 1);
        assert_eq!(before[0].line, 1);
        assert_eq!(after[0].line, 3);
        assert!(context_for_hit(&lines, 20, 2).0.is_empty());
    }

    #[test]
    fn nearest_existing_ancestor_resolves_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let nested = real.join("new/deep/file.txt");
        let resolved = canonicalize_local_nearest(&nested).unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(&real)
                .unwrap()
                .join("new/deep/file.txt")
        );
    }

    #[test]
    fn read_cache_is_scoped_by_version_and_requested_window() {
        let state = AgentFileState::default();
        let version = FileVersion {
            revision: "a".repeat(64),
            size: 4,
            mtime: 1,
        };
        state.record_version(
            "owner",
            "/work/a.txt".into(),
            version.clone(),
            Some((1, 20)),
            Some("read-call".into()),
        );
        assert!(state.read_matches(
            "owner",
            "/work/a.txt",
            &version,
            1,
            20,
            &["read-call".into()]
        ));
        assert!(!state.read_matches(
            "owner",
            "/work/a.txt",
            &version,
            21,
            20,
            &["read-call".into()]
        ));
        // 正文离开模型上下文后不可跳过读取，但不能撤销用于条件写入的版本基线。
        assert!(!state.read_matches("owner", "/work/a.txt", &version, 1, 20, &[]));
        assert_eq!(
            state.read_version("owner", "/work/a.txt").unwrap().revision,
            version.revision
        );
        let changed = FileVersion {
            revision: "b".repeat(64),
            ..version
        };
        assert!(!state.read_matches(
            "owner",
            "/work/a.txt",
            &changed,
            1,
            20,
            &["read-call".into()]
        ));
    }

    #[test]
    fn owner_scope_cannot_switch_root_or_workspace() {
        let state = AgentFileState::default();
        let first = AuthorizedPath {
            actual: "/work/a".into(),
            io_path: "/work/a".into(),
            canonical: "/work/a".into(),
            root_canonical: "/work".into(),
        };
        state
            .bind_scope("owner", &first, &WorkspaceEnv::Local)
            .unwrap();
        let other = AuthorizedPath {
            actual: "/other/a".into(),
            io_path: "/other/a".into(),
            canonical: "/other/a".into(),
            root_canonical: "/other".into(),
        };
        assert!(state
            .bind_scope("owner", &other, &WorkspaceEnv::Local)
            .is_err());
        assert!(state
            .bind_scope(
                "owner",
                &first,
                &WorkspaceEnv::Wsl {
                    distro: "Ubuntu".into(),
                },
            )
            .is_err());
    }

    #[test]
    fn owner_scope_is_bounded_and_remote_paths_remain_case_sensitive() {
        let state = AgentFileState::default();
        let path = AuthorizedPath {
            actual: "/work/a".into(),
            io_path: "/work/a".into(),
            canonical: "/work/a".into(),
            root_canonical: "/work".into(),
        };
        for index in 0..MAX_OWNERS {
            state
                .bind_scope(&format!("owner-{index}"), &path, &WorkspaceEnv::Local)
                .unwrap();
        }
        assert!(state
            .bind_scope("overflow", &path, &WorkspaceEnv::Local)
            .is_err());
        assert!(!paths_equal(
            "/home/User/file",
            "/home/user/file",
            &WorkspaceEnv::Ssh {
                profile_id: "profile".into(),
            },
        ));
        assert!(!paths_equal(
            "/home/User/file",
            "/home/user/file",
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
        ));
    }

    #[tokio::test]
    async fn local_copy_refuses_overwrite_and_preserves_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.txt");
        let destination = temp.path().join("destination.txt");
        std::fs::write(&source, b"source").unwrap();
        let copied = temp.path().join("copied.txt");
        copy_file(
            &source.to_string_lossy(),
            &copied.to_string_lossy(),
            &WorkspaceEnv::Local,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&copied).unwrap(), b"source");

        std::fs::write(&destination, b"keep").unwrap();

        let error = copy_file(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
            &WorkspaceEnv::Local,
        )
        .await
        .unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&destination).unwrap(), b"keep");
    }

    #[tokio::test]
    async fn local_authorization_applies_the_selected_permission_mode() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let sibling = temp.path().join("sibling.txt");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("inside.txt"), b"ok").unwrap();
        std::fs::write(root.join(".env"), b"SECRET=value").unwrap();
        std::fs::write(&sibling, b"no").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let root_text = root.to_string_lossy();

        assert!(authorize_path(
            &registry,
            &root_text,
            "inside.txt",
            &WorkspaceEnv::Local,
            AgentPermissionMode::Ask,
            true
        )
        .await
        .is_ok());
        assert!(authorize_path(
            &registry,
            &root_text,
            &sibling.to_string_lossy(),
            &WorkspaceEnv::Local,
            AgentPermissionMode::Ask,
            true,
        )
        .await
        .is_err());

        assert!(authorize_path(
            &registry,
            &root_text,
            &sibling.to_string_lossy(),
            &WorkspaceEnv::Local,
            AgentPermissionMode::FullAccess,
            true,
        )
        .await
        .is_ok());

        assert!(authorize_path(
            &registry,
            &root_text,
            "../sibling.txt",
            &WorkspaceEnv::Local,
            AgentPermissionMode::Ask,
            true,
        )
        .await
        .is_err());
        assert!(authorize_path(
            &registry,
            &root_text,
            "../sibling.txt",
            &WorkspaceEnv::Local,
            AgentPermissionMode::FullAccess,
            true,
        )
        .await
        .is_ok());

        assert!(authorize_path(
            &registry,
            &root_text,
            ".env",
            &WorkspaceEnv::Local,
            AgentPermissionMode::Ask,
            true,
        )
        .await
        .is_err());
        assert!(authorize_path(
            &registry,
            &root_text,
            ".env",
            &WorkspaceEnv::Local,
            AgentPermissionMode::FullAccess,
            true,
        )
        .await
        .is_ok());
    }
}
