//! Workspace 窗口登记与跨进程一次性消息交换。
//!
//! 所有进程通过同一个短生命周期文件登记窗口并投递定向消息。文件修改由独占锁和
//! 原子替换保护，窗口存活状态以既有 Workspace OS 锁为准，不建立心跳或进程间 RPC。

use crate::modules::storage::{write_atomic, FileLock};
use crate::modules::workspace_process::{
    self, WindowGeometry, WorkspaceProcessState, WorkspaceWindowMode,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const RUNTIME_FILENAME: &str = "terax-workspace-runtime.json";
const RUNTIME_LOCK_FILENAME: &str = "terax-workspace-runtime.lock";
const RUNTIME_CHANGED_EVENT: &str = "terax://workspace-runtime-changed";
const MAX_RUNTIME_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REGISTERED_WINDOWS: usize = 128;
const MAX_PENDING_MESSAGES: usize = 32;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_OPEN_FILES: usize = 64;
const MESSAGE_TTL_MILLIS: u64 = 10 * 60 * 1000;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_TITLE_BYTES: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeDocument {
    schema_version: u32,
    windows: BTreeMap<String, RuntimeWindow>,
    messages: Vec<RuntimeMessageRecord>,
}

impl Default for RuntimeDocument {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            windows: BTreeMap::new(),
            messages: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeWindow {
    environment: String,
    primary: bool,
    lock_filename: String,
    opened_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeMessageRecord {
    id: String,
    target_window_id: String,
    environment: String,
    created_at: u64,
    payload: WorkspaceRuntimeMessage,
}

/// 可在独立 Workspace 进程中重新创建的工作页描述。
///
/// 描述只包含稳定定位信息，不携带页面 ID、Space、未保存正文或进程内运行时资源。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspacePage {
    Terminal {
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        blocks: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        custom_title: Option<String>,
    },
    Editor {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        explorer_root: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        override_language: Option<String>,
    },
    Markdown {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        explorer_root: Option<String>,
    },
    WebPreview {
        url: String,
    },
}

/// 目标 Workspace 进程一次性消费的运行时消息。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkspaceRuntimeMessage {
    Activate,
    OpenFiles { files: Vec<String> },
    CopyPage { page: WorkspacePage },
}

/// 同环境内可接收工作页的临时 Workspace 窗口。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryWorkspaceWindow {
    id: String,
    opened_at: u64,
}

/// 持有运行时交换文件的目录监听器。
pub struct WorkspaceRuntimeState {
    _watcher: Mutex<RecommendedWatcher>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn now_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn runtime_root() -> Result<PathBuf, String> {
    crate::modules::app_data::directory(crate::modules::app_data::Directory::Workspaces)
}

fn runtime_path(root: &Path) -> PathBuf {
    root.join(RUNTIME_FILENAME)
}

fn runtime_lock_path(root: &Path) -> PathBuf {
    root.join(RUNTIME_LOCK_FILENAME)
}

fn read_document(path: &Path) -> Result<(RuntimeDocument, Option<Vec<u8>>), String> {
    if !path.exists() {
        return Ok((RuntimeDocument::default(), None));
    }
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_RUNTIME_BYTES {
        return Err("Workspace runtime exchange file is too large".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let document: RuntimeDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid Workspace runtime exchange file: {error}"))?;
    if document.schema_version != SCHEMA_VERSION {
        return Err("unsupported Workspace runtime exchange schema".to_string());
    }
    validate_document(&document)?;
    Ok((document, Some(bytes)))
}

/// 在运行时文件锁内读取最新内容，仅在内容发生变化时原子替换文件。
///
/// 运行时交换数据没有恢复价值，损坏或未知版本会直接重建为空文档，避免阻止应用启动。
fn mutate_document<T>(
    root: &Path,
    mutation: impl FnOnce(&mut RuntimeDocument) -> Result<T, String>,
) -> Result<T, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let _lock = FileLock::acquire(&runtime_lock_path(root), Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Workspace runtime exchange is busy".to_string())?;
    let path = runtime_path(root);
    let (mut document, original) = match read_document(&path) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("resetting disposable Workspace runtime exchange: {error}");
            (RuntimeDocument::default(), None)
        }
    };
    let result = mutation(&mut document)?;
    validate_document(&document)?;
    let bytes = serde_json::to_vec(&document).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RUNTIME_BYTES {
        return Err("Workspace runtime exchange file is too large".to_string());
    }
    if original.as_deref() != Some(bytes.as_slice()) {
        write_atomic(&path, &bytes).map_err(|error| error.to_string())?;
    }
    Ok(result)
}

fn validate_document(document: &RuntimeDocument) -> Result<(), String> {
    if document.windows.len() > MAX_REGISTERED_WINDOWS
        || document.messages.len() > MAX_PENDING_MESSAGES
    {
        return Err("Workspace runtime exchange exceeds its entry limit".to_string());
    }
    for (id, window) in &document.windows {
        Uuid::parse_str(id).map_err(|_| "invalid registered Workspace id".to_string())?;
        validate_environment(&window.environment)?;
        validate_lock_filename(&window.lock_filename)?;
    }
    for message in &document.messages {
        Uuid::parse_str(&message.id).map_err(|_| "invalid Workspace message id".to_string())?;
        Uuid::parse_str(&message.target_window_id)
            .map_err(|_| "invalid target Workspace id".to_string())?;
        validate_environment(&message.environment)?;
        validate_message(&message.payload)?;
    }
    Ok(())
}

fn validate_environment(environment: &str) -> Result<(), String> {
    validate_text(environment, MAX_PATH_BYTES, false, "Workspace environment")
}

fn validate_lock_filename(filename: &str) -> Result<(), String> {
    let path = Path::new(filename);
    if path.file_name().and_then(|value| value.to_str()) != Some(filename)
        || !filename.starts_with("terax-workspace.")
        || !filename.ends_with(".lock")
    {
        return Err("invalid Workspace lock filename".to_string());
    }
    Ok(())
}

fn validate_text(
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
    label: &str,
) -> Result<(), String> {
    if (!allow_empty && value.is_empty()) || value.len() > max_bytes || value.contains('\0') {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn validate_page(page: &WorkspacePage) -> Result<(), String> {
    match page {
        WorkspacePage::Terminal {
            cwd, custom_title, ..
        } => {
            if let Some(cwd) = cwd {
                validate_text(cwd, MAX_PATH_BYTES, false, "terminal cwd")?;
            }
            if let Some(title) = custom_title {
                validate_text(title, MAX_TITLE_BYTES, false, "terminal title")?;
                if title.chars().any(char::is_control) {
                    return Err("invalid terminal title".to_string());
                }
            }
        }
        WorkspacePage::Editor {
            path,
            explorer_root,
            override_language,
        } => {
            validate_text(path, MAX_PATH_BYTES, false, "editor path")?;
            if let Some(root) = explorer_root {
                validate_text(root, MAX_PATH_BYTES, false, "Explorer root")?;
            }
            if let Some(language) = override_language {
                validate_text(language, MAX_TITLE_BYTES, false, "editor language")?;
                if language.chars().any(char::is_control) {
                    return Err("invalid editor language".to_string());
                }
            }
        }
        WorkspacePage::Markdown {
            path,
            explorer_root,
        } => {
            validate_text(path, MAX_PATH_BYTES, false, "Markdown path")?;
            if let Some(root) = explorer_root {
                validate_text(root, MAX_PATH_BYTES, false, "Explorer root")?;
            }
        }
        WorkspacePage::WebPreview { url } => {
            validate_text(url, MAX_URL_BYTES, true, "Web Preview URL")?;
        }
    }
    Ok(())
}

fn validate_message(message: &WorkspaceRuntimeMessage) -> Result<(), String> {
    match message {
        WorkspaceRuntimeMessage::Activate => Ok(()),
        WorkspaceRuntimeMessage::OpenFiles { files } => {
            if files.is_empty() || files.len() > MAX_OPEN_FILES {
                return Err("invalid Workspace file-open request".to_string());
            }
            for file in files {
                validate_text(file, MAX_PATH_BYTES, false, "Workspace file path")?;
            }
            Ok(())
        }
        WorkspaceRuntimeMessage::CopyPage { page } => validate_page(page),
    }?;
    let size = serde_json::to_vec(message)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_MESSAGE_BYTES {
        return Err("Workspace runtime message is too large".to_string());
    }
    Ok(())
}

fn window_is_live(root: &Path, window: &RuntimeWindow) -> Result<bool, String> {
    validate_lock_filename(&window.lock_filename)?;
    let path = root.join(&window.lock_filename);
    let acquired = FileLock::try_acquire(&path).map_err(|error| error.to_string())?;
    Ok(acquired.is_none())
}

/// 清除已经释放 Workspace 锁的窗口及过期消息。
fn prune(document: &mut RuntimeDocument, root: &Path, now: u64) -> Result<(), String> {
    let mut stale = HashSet::new();
    for (id, window) in &document.windows {
        if !window_is_live(root, window)? {
            stale.insert(id.clone());
        }
    }
    document.windows.retain(|id, _| !stale.contains(id));
    document.messages.retain(|message| {
        now.saturating_sub(message.created_at) <= MESSAGE_TTL_MILLIS
            && !stale.contains(&message.target_window_id)
    });
    Ok(())
}

fn append_message(
    document: &mut RuntimeDocument,
    target_window_id: &str,
    environment: &str,
    payload: WorkspaceRuntimeMessage,
    now: u64,
) -> Result<String, String> {
    Uuid::parse_str(target_window_id).map_err(|_| "invalid target Workspace id".to_string())?;
    validate_environment(environment)?;
    validate_message(&payload)?;
    if document.messages.len() >= MAX_PENDING_MESSAGES {
        return Err("Workspace runtime message queue is full".to_string());
    }
    let id = Uuid::new_v4().to_string();
    document.messages.push(RuntimeMessageRecord {
        id: id.clone(),
        target_window_id: target_window_id.to_string(),
        environment: environment.to_string(),
        created_at: now,
        payload,
    });
    Ok(id)
}

fn register_window_at(
    root: &Path,
    id: &str,
    environment: &str,
    primary: bool,
    lock_filename: &str,
    opened_at: u64,
) -> Result<(), String> {
    Uuid::parse_str(id).map_err(|_| "invalid Workspace id".to_string())?;
    validate_environment(environment)?;
    validate_lock_filename(lock_filename)?;
    mutate_document(root, |document| {
        prune(document, root, opened_at)?;
        upsert_window(document, id, environment, primary, lock_filename, opened_at);
        Ok(())
    })
}

fn upsert_window(
    document: &mut RuntimeDocument,
    id: &str,
    environment: &str,
    primary: bool,
    lock_filename: &str,
    opened_at: u64,
) {
    let previous_opened_at = document
        .windows
        .get(id)
        .map(|window| window.opened_at)
        .unwrap_or(opened_at);
    document.windows.insert(
        id.to_string(),
        RuntimeWindow {
            environment: environment.to_string(),
            primary,
            lock_filename: lock_filename.to_string(),
            opened_at: previous_opened_at,
        },
    );
}

fn upsert_current_window(
    document: &mut RuntimeDocument,
    state: &WorkspaceProcessState,
    opened_at: u64,
) {
    upsert_window(
        document,
        &state.bootstrap().id,
        &state.bootstrap().environment_key,
        state.bootstrap().is_primary,
        state.lock_filename(),
        opened_at,
    );
}

/// 登记当前 Workspace 进程，供同环境主窗口发现临时窗口。
pub fn register_window(state: &WorkspaceProcessState) -> Result<(), String> {
    register_window_at(
        &runtime_root()?,
        &state.bootstrap().id,
        &state.bootstrap().environment_key,
        state.bootstrap().is_primary,
        state.lock_filename(),
        now_millis(),
    )
}

/// 删除当前窗口登记及其尚未消费的定向消息。
pub fn unregister_window(state: &WorkspaceProcessState) -> Result<(), String> {
    let root = runtime_root()?;
    mutate_document(&root, |document| {
        document.windows.remove(&state.bootstrap().id);
        document
            .messages
            .retain(|message| message.target_window_id != state.bootstrap().id);
        Ok(())
    })
}

fn request_message(
    environment: &str,
    target_window_id: &str,
    payload: WorkspaceRuntimeMessage,
) -> Result<(), String> {
    let root = runtime_root()?;
    let now = now_millis();
    mutate_document(&root, |document| {
        prune(document, &root, now)?;
        append_message(document, target_window_id, environment, payload, now)?;
        Ok(())
    })
}

/// 请求已经运行的主窗口显示并获得焦点。
pub(crate) fn request_workspace_activation(
    environment: &str,
    workspace_id: &str,
) -> Result<(), String> {
    request_message(environment, workspace_id, WorkspaceRuntimeMessage::Activate)
}

/// 向已经运行的主窗口投递一组待打开文件。
pub(crate) fn request_workspace_file_open(
    environment: &str,
    workspace_id: &str,
    files: &[String],
) -> Result<(), String> {
    request_message(
        environment,
        workspace_id,
        WorkspaceRuntimeMessage::OpenFiles {
            files: files.to_vec(),
        },
    )
}

fn validate_page_sender(primary: bool, mode: WorkspaceWindowMode) -> Result<(), String> {
    if !primary {
        return Err("only the primary Workspace can copy pages to another window".to_string());
    }
    if mode != WorkspaceWindowMode::Multiple {
        return Err("multiple Workspace windows are disabled".to_string());
    }
    Ok(())
}

fn ensure_page_sender(state: &WorkspaceProcessState) -> Result<(), String> {
    validate_page_sender(
        state.bootstrap().is_primary,
        workspace_process::window_mode(),
    )
}

fn take_messages(
    document: &mut RuntimeDocument,
    target_window_id: &str,
    environment: &str,
) -> Vec<WorkspaceRuntimeMessage> {
    let mut received = Vec::new();
    document.messages.retain(|message| {
        let matches =
            message.target_window_id == target_window_id && message.environment == environment;
        if matches {
            received.push(message.payload.clone());
        }
        !matches
    });
    received
}

fn temporary_windows(
    document: &RuntimeDocument,
    current_window_id: &str,
    environment: &str,
) -> Vec<TemporaryWorkspaceWindow> {
    let mut windows = document
        .windows
        .iter()
        .filter(|(id, window)| {
            !window.primary && window.environment == environment && *id != current_window_id
        })
        .map(|(id, window)| TemporaryWorkspaceWindow {
            id: id.clone(),
            opened_at: window.opened_at,
        })
        .collect::<Vec<_>>();
    windows.sort_by_key(|window| window.opened_at);
    windows
}

/// 返回当前环境中仍持有 Workspace 锁的临时窗口。
#[tauri::command]
pub fn workspace_runtime_list_temporary_windows(
    state: tauri::State<'_, WorkspaceProcessState>,
) -> Result<Vec<TemporaryWorkspaceWindow>, String> {
    ensure_page_sender(&state)?;
    let root = runtime_root()?;
    let now = now_millis();
    mutate_document(&root, |document| {
        upsert_current_window(document, &state, now);
        prune(document, &root, now)?;
        Ok(temporary_windows(
            document,
            &state.bootstrap().id,
            &state.bootstrap().environment_key,
        ))
    })
}

/// 将工作页描述投递给一个已经运行的同环境临时窗口。
#[tauri::command]
pub fn workspace_runtime_send_page(
    state: tauri::State<'_, WorkspaceProcessState>,
    target_window_id: String,
    page: WorkspacePage,
) -> Result<(), String> {
    ensure_page_sender(&state)?;
    let root = runtime_root()?;
    let now = now_millis();
    mutate_document(&root, |document| {
        upsert_current_window(document, &state, now);
        prune(document, &root, now)?;
        let target = document
            .windows
            .get(&target_window_id)
            .ok_or_else(|| "target Workspace window is no longer available".to_string())?;
        if target.primary || target.environment != state.bootstrap().environment_key {
            return Err("target must be a temporary Workspace in the same environment".to_string());
        }
        append_message(
            document,
            &target_window_id,
            &state.bootstrap().environment_key,
            WorkspaceRuntimeMessage::CopyPage { page },
            now,
        )?;
        Ok(())
    })
}

/// 投递工作页并使用指定 UUID 启动新的临时 Workspace 进程。
///
/// 写入和创建系统进程无法组成同一原子事务；立即启动失败时会按消息 ID 精确回滚，
/// 进程稍后异常退出时则由消息过期清理收敛，源页面始终保持不变。
#[tauri::command]
pub fn workspace_runtime_spawn_with_page(
    state: tauri::State<'_, WorkspaceProcessState>,
    page: WorkspacePage,
    window_geometry: Option<WindowGeometry>,
) -> Result<String, String> {
    ensure_page_sender(&state)?;
    let root = runtime_root()?;
    let now = now_millis();
    let target_id = Uuid::new_v4();
    let message_id = mutate_document(&root, |document| {
        upsert_current_window(document, &state, now);
        prune(document, &root, now)?;
        append_message(
            document,
            &target_id.to_string(),
            &state.bootstrap().environment_key,
            WorkspaceRuntimeMessage::CopyPage { page },
            now,
        )
    })?;

    if let Err(error) =
        workspace_process::spawn_temporary_workspace_process(&state, target_id, window_geometry)
    {
        let _ = mutate_document(&root, |document| {
            document.messages.retain(|message| message.id != message_id);
            Ok(())
        });
        return Err(error);
    }
    Ok(target_id.to_string())
}

/// 原子取走当前 Workspace 的全部定向消息；重复调用不会再次返回同一条消息。
#[tauri::command]
pub fn workspace_runtime_take_messages(
    state: tauri::State<'_, WorkspaceProcessState>,
) -> Result<Vec<WorkspaceRuntimeMessage>, String> {
    let root = runtime_root()?;
    let now = now_millis();
    mutate_document(&root, |document| {
        upsert_current_window(document, &state, now);
        prune(document, &root, now)?;
        Ok(take_messages(
            document,
            &state.bootstrap().id,
            &state.bootstrap().environment_key,
        ))
    })
}

fn emit_changed(app: &AppHandle) -> Result<(), String> {
    app.emit(RUNTIME_CHANGED_EVENT, ())
        .map_err(|error| error.to_string())
}

impl WorkspaceRuntimeState {
    /// 监听运行时交换文件的原子替换，并通知当前进程内的 Workspace WebView。
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let root = runtime_root()?;
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let handle = app.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else {
                    return;
                };
                if event.paths.iter().any(|path| {
                    path.file_name().and_then(|value| value.to_str()) == Some(RUNTIME_FILENAME)
                }) {
                    let _ = emit_changed(&handle);
                }
            })
            .map_err(|error| error.to_string())?;
        watcher
            .watch(&root, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            _watcher: Mutex::new(watcher),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register_locked_window(
        root: &Path,
        id: Uuid,
        environment: &str,
        primary: bool,
        opened_at: u64,
    ) -> FileLock {
        let filename = format!("terax-workspace.test-{id}.lock");
        let lock = FileLock::try_acquire(&root.join(&filename))
            .unwrap()
            .unwrap();
        register_window_at(
            root,
            &id.to_string(),
            environment,
            primary,
            &filename,
            opened_at,
        )
        .unwrap();
        lock
    }

    fn terminal_page() -> WorkspacePage {
        WorkspacePage::Terminal {
            cwd: Some("C:/repo".to_string()),
            blocks: false,
            custom_title: None,
        }
    }

    #[test]
    fn page_validation_rejects_empty_paths_and_control_titles() {
        assert!(validate_page(&WorkspacePage::Editor {
            path: String::new(),
            explorer_root: None,
            override_language: None,
        })
        .is_err());
        assert!(validate_page(&WorkspacePage::Terminal {
            cwd: None,
            blocks: false,
            custom_title: Some("bad\ntitle".to_string()),
        })
        .is_err());
    }

    #[test]
    fn message_validation_enforces_a_total_size_limit() {
        let message = WorkspaceRuntimeMessage::CopyPage {
            page: WorkspacePage::Editor {
                path: "a".repeat(MAX_PATH_BYTES),
                explorer_root: Some("b".repeat(MAX_PATH_BYTES)),
                override_language: None,
            },
        };
        assert!(validate_message(&message).is_err());
    }

    #[test]
    fn page_protocol_uses_camel_case_fields_and_rejects_unknown_data() {
        let page: WorkspacePage = serde_json::from_value(serde_json::json!({
            "kind": "editor",
            "path": "C:/repo/main.ts",
            "explorerRoot": "C:/repo",
            "overrideLanguage": "tsx"
        }))
        .unwrap();
        assert!(matches!(
            page,
            WorkspacePage::Editor {
                explorer_root: Some(_),
                override_language: Some(_),
                ..
            }
        ));
        assert!(serde_json::from_value::<WorkspacePage>(serde_json::json!({
            "kind": "web-preview",
            "url": "https://example.com",
            "unexpected": true
        }))
        .is_err());
    }

    #[test]
    fn only_primary_multiple_window_workspaces_can_send_pages() {
        assert!(validate_page_sender(true, WorkspaceWindowMode::Multiple).is_ok());
        assert!(validate_page_sender(false, WorkspaceWindowMode::Multiple).is_err());
        assert!(validate_page_sender(true, WorkspaceWindowMode::Single).is_err());
    }

    #[test]
    fn lists_only_live_temporary_windows_in_the_same_environment() {
        let root = tempfile::tempdir().unwrap();
        let live = Uuid::new_v4();
        let stale = Uuid::new_v4();
        let primary = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let _live_lock = register_locked_window(root.path(), live, "local", false, 20);
        let stale_lock = register_locked_window(root.path(), stale, "local", false, 10);
        let _primary_lock = register_locked_window(root.path(), primary, "local", true, 5);
        let _foreign_lock = register_locked_window(root.path(), foreign, "ssh:other", false, 15);
        drop(stale_lock);

        let windows = mutate_document(root.path(), |document| {
            prune(document, root.path(), 30)?;
            Ok(temporary_windows(document, &primary.to_string(), "local"))
        })
        .unwrap();

        assert_eq!(
            windows,
            vec![TemporaryWorkspaceWindow {
                id: live.to_string(),
                opened_at: 20,
            }]
        );
    }

    #[test]
    fn messages_are_queued_by_target_and_consumed_once() {
        let root = tempfile::tempdir().unwrap();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        mutate_document(root.path(), |document| {
            append_message(
                document,
                &first,
                "local",
                WorkspaceRuntimeMessage::CopyPage {
                    page: terminal_page(),
                },
                10,
            )?;
            append_message(
                document,
                &second,
                "local",
                WorkspaceRuntimeMessage::Activate,
                11,
            )?;
            Ok(())
        })
        .unwrap();

        let take = |target: &str, environment: &str| {
            mutate_document(root.path(), |document| {
                Ok(take_messages(document, target, environment))
            })
            .unwrap()
        };

        assert!(take(&first, "ssh:other").is_empty());
        assert_eq!(take(&first, "local").len(), 1);
        assert!(take(&first, "local").is_empty());
        assert_eq!(
            take(&second, "local"),
            vec![WorkspaceRuntimeMessage::Activate]
        );
    }

    #[test]
    fn future_target_message_survives_pruning_until_it_expires() {
        let root = tempfile::tempdir().unwrap();
        let target = Uuid::new_v4().to_string();
        mutate_document(root.path(), |document| {
            append_message(
                document,
                &target,
                "local",
                WorkspaceRuntimeMessage::CopyPage {
                    page: terminal_page(),
                },
                10,
            )?;
            Ok(())
        })
        .unwrap();

        let pending = mutate_document(root.path(), |document| {
            prune(document, root.path(), 20)?;
            Ok(document.messages.len())
        })
        .unwrap();
        assert_eq!(pending, 1);

        let expired = mutate_document(root.path(), |document| {
            prune(document, root.path(), 10 + MESSAGE_TTL_MILLIS + 1)?;
            Ok(document.messages.len())
        })
        .unwrap();
        assert_eq!(expired, 0);
    }

    #[test]
    fn concurrent_writers_keep_both_messages() {
        let root = tempfile::tempdir().unwrap();
        let target = Uuid::new_v4().to_string();
        let writers = (0..2)
            .map(|_| {
                let root = root.path().to_path_buf();
                let target = target.clone();
                std::thread::spawn(move || {
                    mutate_document(&root, |document| {
                        append_message(
                            document,
                            &target,
                            "local",
                            WorkspaceRuntimeMessage::CopyPage {
                                page: terminal_page(),
                            },
                            10,
                        )?;
                        Ok(())
                    })
                })
            })
            .collect::<Vec<_>>();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }

        let (document, _) = read_document(&runtime_path(root.path())).unwrap();
        assert_eq!(document.messages.len(), 2);
    }
}
