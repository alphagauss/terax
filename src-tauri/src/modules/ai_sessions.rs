//! AI 会话 JSONL 文件、Agent 归属和跨进程运行锁管理。
//!
//! 每个会话使用一个文件，首行固定为 metadata，后续每行是一条 SDK 无关的消息记录。
//! Rust 校验外层环境归属和不可变 cwd，列表只投影摘要，内层业务 metadata 保持不透明。
//! 用户消息与终态记录分阶段原子追加，运行锁确保两个进程不能同时续写同一会话。
//! Custom Agent 删除在共享配置锁内级联其全部会话，运行中会话会阻止整个操作。
//! Channel 来源不可改绑，列表只投影入口 ID；绑定中的会话禁止从普通删除入口移除。

use crate::modules::shared_store;
use crate::modules::storage::{write_atomic, FileLock};
use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Lines};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
/// 在宿主固定环境中取得会话锁并恢复历史会话目录授权。
pub fn acquire(
    state: &AiSessionsState,
    registry: &WorkspaceRegistry,
    id: &str,
    environment_key: &str,
    environment: &WorkspaceEnv,
) -> Result<bool, String> {
    acquire_session_run(
        &sessions_dir()?,
        state,
        registry,
        strict_uuid(id)?,
        environment_key,
        environment,
    )
}

/// 释放当前宿主持有的会话锁；提交失败的运行必须先由调用者处理。
pub fn release(state: &AiSessionsState, id: &str) -> Result<(), String> {
    state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?
        .remove(&strict_uuid(id)?);
    Ok(())
}

#[cfg(test)]
use std::time::Duration;
use std::time::UNIX_EPOCH;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, State};
use uuid::Uuid;

const MAIN_AGENT_ID: &str = "builtin:main";
const MAIN_AGENT_NAME: &str = "Terax";
const MAIN_AGENT_ICON: &str = "coder";

/// 前端与 Rust 之间传递的会话文件内容。
///
/// 读取时 messages 是完整记录，提交时 messages 只包含本次新增记录。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFile {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub environment_key: String,
    pub cwd: String,
    pub metadata: Map<String, Value>,
    pub messages: Vec<Value>,
}

/// 会话列表轮询使用的显式摘要，不携带完整业务 metadata。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub environment_key: String,
    pub cwd: String,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_icon: String,
    /// 外部消息入口的固定归属，展示层据此禁用人工输入。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    pub modified_at: u64,
    pub size: u64,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct SessionFileHeader {
    #[serde(rename = "_type")]
    record_type: String,
    key: String,
    created_at: String,
    updated_at: String,
    environment_key: String,
    cwd: String,
    metadata: Map<String, Value>,
}

/// 保存当前进程持有的会话运行锁。
#[derive(Default)]
pub struct AiSessionsState {
    run_locks: Mutex<HashMap<Uuid, FileLock>>,
}

/// 校验会话 ID，禁止路径穿越和非规范 UUID 产生重复文件。
fn strict_uuid(id: &str) -> Result<Uuid, String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "session id must be a UUID".to_string())?;
    if parsed.to_string() != id {
        return Err("session id must use canonical lowercase UUID format".to_string());
    }
    Ok(parsed)
}

/// 返回 Terax 会话数据目录。
fn sessions_dir() -> Result<PathBuf, String> {
    crate::modules::app_data::directory(crate::modules::app_data::Directory::Sessions)
}

/// 根据规范 UUID 生成唯一的 JSONL 文件路径。
fn session_path(root: &Path, id: Uuid) -> PathBuf {
    root.join(format!("{id}.jsonl"))
}

/// 生成不进入会话正文的跨进程锁文件路径。
fn lock_path(root: &Path, id: Uuid) -> PathBuf {
    root.join(format!("{id}.lock"))
}

/// 校验会话文件的文件级字段和 JSONL 记录形状。
fn validate_session_file(session: &SessionFile) -> Result<Uuid, String> {
    let id = strict_uuid(&session.id)?;
    validate_timestamps(&session.created_at, &session.updated_at)?;
    if session.environment_key.is_empty() {
        return Err("session environmentKey must not be empty".to_string());
    }
    if session.cwd.trim().is_empty() {
        return Err("session cwd must not be empty".to_string());
    }
    validate_channel_metadata(&session.metadata)?;
    validate_agent_metadata(&session.metadata)?;
    validate_external_agent_metadata(&session.metadata)?;
    for (index, message) in session.messages.iter().enumerate() {
        if !message.is_object() {
            return Err(format!("message line {} must be a JSON object", index + 2));
        }
    }
    Ok(id)
}

/// 校验 metadata 的类型、版本、ID 和时间字段。
fn validate_header(header: &SessionFileHeader, expected_id: Uuid) -> Result<(), String> {
    if header.record_type != "metadata" {
        return Err("first JSONL line must have _type metadata".to_string());
    }
    let inner_id = strict_uuid(&header.key)?;
    if inner_id != expected_id {
        return Err("session key does not match filename".to_string());
    }
    if header.environment_key.is_empty() {
        return Err("session environmentKey must not be empty".to_string());
    }
    if header.cwd.trim().is_empty() {
        return Err("session cwd must not be empty".to_string());
    }
    validate_timestamps(&header.created_at, &header.updated_at)?;
    validate_channel_metadata(&header.metadata)?;
    validate_agent_metadata(&header.metadata)?;
    validate_external_agent_metadata(&header.metadata)
}

/// 校验会话的外部入口身份，不解释入口协议和运行策略。
fn validate_channel_metadata(metadata: &Map<String, Value>) -> Result<(), String> {
    if let Some(value) = metadata.get("channelId") {
        strict_uuid(value.as_str().ok_or("session channelId must be a UUID")?)?;
    }
    Ok(())
}

/// 校验可选 External Agent 绑定，避免损坏或超长 session ID 进入启动参数。
fn validate_external_agent_metadata(metadata: &Map<String, Value>) -> Result<(), String> {
    let Some(value) = metadata.get("externalAgent") else {
        return Ok(());
    };
    let binding = value
        .as_object()
        .ok_or_else(|| "session externalAgent must be an object".to_string())?;
    let agent_id = binding
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session externalAgent agentId must be a string".to_string())?;
    if !matches!(agent_id, "claude" | "codex") {
        return Err("session externalAgent agentId is unknown".into());
    }
    if let Some(session_id) = binding.get("sessionId") {
        if !session_id.is_null()
            && session_id.as_str().is_none_or(|value| {
                value.is_empty()
                    || value.len() > 512
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        {
            return Err("session externalAgent sessionId is invalid".into());
        }
    } else {
        return Err("session externalAgent sessionId is required".into());
    }
    Ok(())
}

/// 校验可选 Agent 快照，缺失字段仅用于兼容归入主 Agent 的旧会话。
fn validate_agent_metadata(metadata: &Map<String, Value>) -> Result<(), String> {
    let Some(value) = metadata.get("agent") else {
        return Ok(());
    };
    let agent = value
        .as_object()
        .ok_or_else(|| "session agent must be an object".to_string())?;
    for field in ["id", "name", "instructions", "icon"] {
        if !agent.get(field).is_some_and(Value::is_string) {
            return Err(format!("session agent {field} must be a string"));
        }
    }
    if agent
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || agent
            .get("name")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || agent
            .get("icon")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err("session agent identity must not be empty".to_string());
    }
    let tools = agent
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "session agent tools must be an array".to_string())?;
    if !tools.iter().all(Value::is_string) {
        return Err("session agent tools must contain strings".to_string());
    }
    Ok(())
}

/// 检查会话时间字段存在，具体时间格式由 IPC 适配层负责。
fn validate_timestamps(created_at: &str, updated_at: &str) -> Result<(), String> {
    if created_at.is_empty() || updated_at.is_empty() {
        return Err("session timestamps must not be empty".to_string());
    }
    Ok(())
}

/// 打开会话并解析首行，剩余迭代器由完整读取路径按需消费。
fn open_session(
    path: &Path,
    expected_id: Uuid,
) -> Result<(SessionFileHeader, Lines<BufReader<File>>), String> {
    let file = File::open(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut lines = BufReader::new(file).lines();
    let first = lines
        .next()
        .ok_or_else(|| format!("session file is empty: {}", path.display()))?
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let header: SessionFileHeader = serde_json::from_str(&first)
        .map_err(|error| format!("parse {} line 1: {error}", path.display()))?;
    validate_header(&header, expected_id)?;
    Ok((header, lines))
}

/// 只读取 JSONL 首行，供会话列表快速取得 metadata。
fn read_header(path: &Path, expected_id: Uuid) -> Result<SessionFileHeader, String> {
    open_session(path, expected_id).map(|(header, _)| header)
}

/// 读取首行 metadata 和其后的全部消息记录。
fn read_session(root: &Path, id: Uuid) -> Result<SessionFile, String> {
    let path = session_path(root, id);
    let (header, lines) = open_session(&path, id)?;
    let mut messages = Vec::new();
    for (index, line) in lines.enumerate() {
        let line_number = index + 2;
        let line = line.map_err(|error| format!("read {}: {error}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(&line)
            .map_err(|error| format!("parse {} line {line_number}: {error}", path.display()))?;
        if !message.is_object() {
            return Err(format!(
                "parse {} line {line_number}: message must be a JSON object",
                path.display()
            ));
        }
        messages.push(message);
    }

    Ok(SessionFile {
        id: header.key,
        created_at: header.created_at,
        updated_at: header.updated_at,
        environment_key: header.environment_key,
        cwd: header.cwd,
        metadata: header.metadata,
        messages,
    })
}

/// 将完整会话编码为一行 metadata 加多行消息，并原子替换目标文件。
fn write_session(root: &Path, session: &SessionFile) -> Result<(), String> {
    let id = validate_session_file(session)?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let header = SessionFileHeader {
        record_type: "metadata".to_string(),
        key: session.id.clone(),
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        environment_key: session.environment_key.clone(),
        cwd: session.cwd.clone(),
        metadata: session.metadata.clone(),
    };
    let mut bytes = Vec::new();
    serde_json::to_writer(&mut bytes, &header).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    for message in &session.messages {
        serde_json::to_writer(&mut bytes, message).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
    }
    write_atomic(&session_path(root, id), &bytes).map_err(|error| error.to_string())
}

/// 在锁内读取现有记录，追加本次新增记录后整体原子替换，并返回真实文件指纹。
fn commit_session(
    root: &Path,
    update: &SessionFile,
    environment_key: &str,
) -> Result<SessionMetadata, String> {
    let id = validate_session_file(update)?;
    if update.environment_key != environment_key {
        return Err("session belongs to another workspace environment".to_string());
    }
    let path = session_path(root, id);
    let mut messages = if path.exists() {
        let existing = read_session(root, id)?;
        if existing.environment_key != environment_key {
            return Err("session belongs to another workspace environment".to_string());
        }
        if existing.created_at != update.created_at {
            return Err("session createdAt does not match existing file".to_string());
        }
        if existing.cwd != update.cwd {
            return Err("session cwd must not change".to_string());
        }
        if existing.metadata.get("channelId") != update.metadata.get("channelId") {
            return Err("session channel ownership must not change".into());
        }
        if existing.metadata.get("agent") != update.metadata.get("agent") {
            return Err("session agent snapshot must not change".to_string());
        }
        match (
            existing.metadata.get("externalAgent"),
            update.metadata.get("externalAgent"),
        ) {
            (None, None) => {}
            (Some(before), Some(after)) => {
                let before = before.as_object().unwrap();
                let after = after.as_object().unwrap();
                if before.get("agentId") != after.get("agentId") {
                    return Err("session External Agent must not change".into());
                }
                let previous_session = before.get("sessionId").and_then(Value::as_str);
                let next_session = after.get("sessionId").and_then(Value::as_str);
                if previous_session.is_some() && previous_session != next_session {
                    return Err("session External Agent session id must not change".into());
                }
            }
            _ => return Err("session External Agent binding must not change".into()),
        }
        existing.messages
    } else {
        Vec::new()
    };
    messages.extend(update.messages.iter().cloned());
    write_session(
        root,
        &SessionFile {
            messages,
            ..update.clone()
        },
    )?;
    metadata(root, id)
}

/// 从不透明业务 metadata 中读取稳定的 Agent 归属，旧会话归入主 Agent。
fn session_agent_id(metadata: &Map<String, Value>) -> &str {
    metadata
        .get("agent")
        .and_then(Value::as_object)
        .and_then(|agent| agent.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(MAIN_AGENT_ID)
}

/// 将 Agent 快照投影为会话列表需要的轻量显示字段。
fn session_agent_summary(metadata: &Map<String, Value>) -> (String, String, String) {
    let Some(agent) = metadata.get("agent").and_then(Value::as_object) else {
        return (
            MAIN_AGENT_ID.to_string(),
            MAIN_AGENT_NAME.to_string(),
            MAIN_AGENT_ICON.to_string(),
        );
    };
    let id = agent
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(MAIN_AGENT_ID);
    if id == MAIN_AGENT_ID {
        return (
            MAIN_AGENT_ID.to_string(),
            MAIN_AGENT_NAME.to_string(),
            MAIN_AGENT_ICON.to_string(),
        );
    }
    let name = agent
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(MAIN_AGENT_NAME);
    let icon = agent
        .get("icon")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(MAIN_AGENT_ICON);
    (id.to_string(), name.to_string(), icon.to_string())
}

/// 从首行 metadata 和文件系统属性构造会话列表项。
fn metadata(root: &Path, id: Uuid) -> Result<SessionMetadata, String> {
    let path = session_path(root, id);
    let header = read_header(&path, id)?;
    let info = fs::metadata(&path).map_err(|error| error.to_string())?;
    let modified_at = info
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let size = info.len();
    let title = header
        .metadata
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("New chat")
        .to_string();
    let (agent_id, agent_name, agent_icon) = session_agent_summary(&header.metadata);
    Ok(SessionMetadata {
        channel_id: header
            .metadata
            .get("channelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        id: header.key,
        title,
        created_at: header.created_at,
        updated_at: header.updated_at,
        environment_key: header.environment_key,
        cwd: header.cwd,
        agent_id,
        agent_name,
        agent_icon,
        modified_at,
        size,
        fingerprint: format!("{modified_at}:{size}"),
    })
}

/// 扫描 JSONL 文件并按更新时间倒序返回有效会话。
fn list_sessions(root: &Path) -> Result<Vec<SessionMetadata>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(id) = strict_uuid(stem) else {
            log::warn!("ignoring invalid session filename: {}", path.display());
            continue;
        };
        match metadata(root, id) {
            Ok(value) => sessions.push(value),
            Err(error) => log::warn!("ignoring invalid session file: {error}"),
        }
    }
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(sessions)
}

/// 列出当前用户的全部有效 AI 会话。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn ai_sessions_list() -> Result<Vec<SessionMetadata>, String> {
    list_sessions(&sessions_dir()?)
}

/// 读取指定 AI 会话的 metadata 和全部消息记录。
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn ai_session_read(id: String) -> Result<SessionFile, String> {
    read_session(&sessions_dir()?, strict_uuid(&id)?)
}

/// 在持有进程内运行锁或临时取得文件锁后提交新增记录。
fn commit_with_run_lock(
    root: &Path,
    state: &AiSessionsState,
    id: Uuid,
    session: &SessionFile,
    environment_key: &str,
) -> Result<SessionMetadata, String> {
    let run_locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?;
    if run_locks.contains_key(&id) {
        return commit_session(root, session, environment_key);
    }
    drop(run_locks);
    let _lock = FileLock::try_acquire(&lock_path(root, id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session is running in another window".to_string())?;
    commit_session(root, session, environment_key)
}

/// 将新增记录提交到 AI 会话并返回最新摘要。
///
/// 新会话 cwd 来自已授权的 Explorer 根目录；历史会话仍由不可变校验防止换根。
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_session_commit(
    state: State<'_, AiSessionsState>,
    workspace_state: State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
    session: SessionFile,
) -> Result<SessionMetadata, String> {
    commit(
        state.inner(),
        &workspace_state.bootstrap().environment_key,
        session,
    )
}

/// 按宿主绑定的环境提交会话，保持固定 cwd、Agent 归属和跨进程运行锁。
pub fn commit(
    state: &AiSessionsState,
    environment_key: &str,
    mut session: SessionFile,
) -> Result<SessionMetadata, String> {
    let environment_key = environment_key.to_string();
    session.environment_key = environment_key.clone();
    let id = validate_session_file(&session)?;
    let root = sessions_dir()?;
    let path = session_path(&root, id);
    if path.exists() {
        let header = read_header(&path, id)?;
        if header.environment_key != environment_key {
            return Err("session belongs to another workspace environment".to_string());
        }
        if header.cwd != session.cwd {
            return Err("session cwd must not change".to_string());
        }
    }
    let agent_id = session_agent_id(&session.metadata).to_string();
    if agent_id == MAIN_AGENT_ID {
        return commit_with_run_lock(&root, state, id, &session, &environment_key);
    }
    shared_store::with_ai_agent(&agent_id, || {
        commit_with_run_lock(&root, state, id, &session, &environment_key)
    })
}

/// 删除指定会话文件，运行中的会话不可删除。
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_session_delete(state: State<'_, AiSessionsState>, id: String) -> Result<(), String> {
    let id = strict_uuid(&id)?;
    let root = sessions_dir()?;
    if state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?
        .contains_key(&id)
    {
        return Err("cannot delete a running session".to_string());
    }
    let _lock = FileLock::try_acquire(&lock_path(&root, id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session is running in another window".to_string())?;
    let path = session_path(&root, id);
    if path.exists() {
        let header = read_header(&path, id)?;
        if let Some(channel_id) = header.metadata.get("channelId").and_then(Value::as_str) {
            if shared_store::read_value::<Value>("channels", channel_id)?.is_some() {
                return Err("CHANNEL_SESSION_IS_BOUND".into());
            }
        }
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// 删除指定 Custom Agent 拥有的全部会话。
///
/// 调用方必须先持有共享 Agent 配置锁。函数会先取得全部会话锁再删除任何文件，
/// 检测到任一运行中会话时不产生部分删除。
#[cfg(any(feature = "desktop", test))]
fn delete_sessions_by_agent(
    root: &Path,
    state: &AiSessionsState,
    agent_id: &str,
) -> Result<Vec<String>, String> {
    let ids = list_sessions(root)?
        .into_iter()
        .filter(|session| session.agent_id == agent_id)
        .map(|session| strict_uuid(&session.id))
        .collect::<Result<Vec<_>, _>>()?;
    let run_locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?;
    if ids.iter().any(|id| run_locks.contains_key(id)) {
        return Err("CUSTOM_AGENT_SESSIONS_RUNNING".to_string());
    }
    drop(run_locks);

    let mut file_locks = Vec::with_capacity(ids.len());
    for id in &ids {
        let Some(lock) =
            FileLock::try_acquire(&lock_path(root, *id)).map_err(|error| error.to_string())?
        else {
            return Err("CUSTOM_AGENT_SESSIONS_RUNNING".to_string());
        };
        file_locks.push(lock);
    }

    for id in &ids {
        match fs::remove_file(session_path(root, *id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    drop(file_locks);
    Ok(ids.into_iter().map(|id| id.to_string()).collect())
}

/// 级联删除 Custom Agent 和其跨 Workspace 的全部会话。
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_agent_delete(
    app: AppHandle,
    state: State<'_, AiSessionsState>,
    agent_id: String,
) -> Result<Vec<String>, String> {
    let root = sessions_dir()?;
    shared_store::delete_ai_agent_with(&app, &agent_id, || {
        delete_sessions_by_agent(&root, state.inner(), &agent_id)
    })
}

/// 取得会话运行锁，并恢复历史会话固定 cwd 对应的 Workspace 授权。
///
/// 历史 cwd 只从已校验的会话首行读取并恢复授权，因此这里不接受前端额外传入路径。
fn acquire_session_run(
    root: &Path,
    state: &AiSessionsState,
    registry: &WorkspaceRegistry,
    id: Uuid,
    environment_key: &str,
    workspace: &WorkspaceEnv,
) -> Result<bool, String> {
    let mut locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?;
    if locks.contains_key(&id) {
        return Ok(true);
    }
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let Some(lock) =
        FileLock::try_acquire(&lock_path(root, id)).map_err(|error| error.to_string())?
    else {
        return Ok(false);
    };
    let path = session_path(root, id);
    if path.exists() {
        let header = read_header(&path, id)?;
        if header.environment_key != environment_key {
            return Ok(false);
        }
        authorize_user_spawn_cwd(registry, Some(&header.cwd), workspace)?;
    }
    locks.insert(id, lock);
    Ok(true)
}

/// 尝试为一次 AI 运行取得跨进程锁，重复取得同一锁视为成功。
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_session_run_acquire(
    state: State<'_, AiSessionsState>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_state: State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
    id: String,
) -> Result<bool, String> {
    let id = strict_uuid(&id)?;
    let bootstrap = workspace_state.bootstrap();
    acquire_session_run(
        &sessions_dir()?,
        state.inner(),
        registry.inner(),
        id,
        &bootstrap.environment_key,
        &bootstrap.env,
    )
}

/// 释放当前进程持有的 AI 会话运行锁。
#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_session_run_release(state: State<'_, AiSessionsState>, id: String) -> Result<(), String> {
    let id = strict_uuid(&id)?;
    state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?
        .remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! 验证 JSONL 布局、开放消息边界、旧格式隔离和跨进程运行锁不变量。

    use super::*;
    use serde_json::json;
    use std::process::Command;
    use std::time::Instant;

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn session(id: Uuid, title: &str) -> SessionFile {
        SessionFile {
            id: id.to_string(),
            created_at: "2026-07-26T10:00:00.000Z".to_string(),
            updated_at: "2026-07-26T10:00:01.000Z".to_string(),
            environment_key: "local".to_string(),
            cwd: "D:/workspace/project".to_string(),
            metadata: serde_json::from_value(json!({
                "title": title
            }))
            .unwrap(),
            messages: vec![json!({
                "role": "user",
                "content": "hello",
                "timestamp": "2026-07-26T10:00:01.000Z"
            })],
        }
    }

    fn custom_session(id: Uuid, title: &str, agent_id: &str) -> SessionFile {
        let mut value = session(id, title);
        value.metadata.insert(
            "agent".to_string(),
            json!({
                "id": agent_id,
                "name": "Reviewer",
                "icon": "reviewer",
                "instructions": "Review carefully.",
                "tools": ["read_file", "grep"]
            }),
        );
        value
    }

    #[test]
    fn rejects_noncanonical_ids_and_path_traversal() {
        assert!(strict_uuid("../session").is_err());
        assert!(strict_uuid(&Uuid::new_v4().to_string().to_uppercase()).is_err());
    }

    #[test]
    fn commit_appends_records_and_replaces_complete_jsonl_file() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        commit_session(dir.path(), &session(id, "old"), "local").unwrap();
        let mut next = session(id, "new");
        next.messages[0]["content"] = json!("again");
        next.metadata
            .insert("runtimeConfig".to_string(), json!({"futureField": true}));
        commit_session(dir.path(), &next, "local").unwrap();

        let content = fs::read_to_string(session_path(dir.path(), id)).unwrap();
        let lines = content.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            serde_json::from_str::<Value>(lines[0]).unwrap()["_type"],
            "metadata"
        );
        assert_eq!(
            serde_json::from_str::<Value>(lines[1]).unwrap()["role"],
            "user"
        );
        let stored = read_session(dir.path(), id).unwrap();
        assert_eq!(stored.metadata["title"], "new");
        assert_eq!(stored.metadata["runtimeConfig"]["futureField"], true);
        assert_eq!(stored.environment_key, "local");
        assert_eq!(stored.messages.len(), 2);
        assert_eq!(list_sessions(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn preserves_readable_message_field_order_when_writing_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut value = session(id, "ordered");
        value.messages = vec![
            serde_json::from_str(
                r#"{"role":"assistant","content":"answer","tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{}"}}],"reasoning_content":"thoughts","timestamp":"2026-07-26T10:00:01.000Z","turn_id":"turn-1"}"#,
            )
            .unwrap(),
            serde_json::from_str(
                r#"{"role":"tool","tool_call_id":"call-1","name":"read_file","content":"{}","status":"completed","timestamp":"2026-07-26T10:00:01.000Z","turn_id":"turn-1"}"#,
            )
            .unwrap(),
        ];

        write_session(dir.path(), &value).unwrap();

        let lines = fs::read_to_string(session_path(dir.path(), id))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(
            lines[1],
            r#"{"role":"assistant","content":"answer","tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{}"}}],"reasoning_content":"thoughts","timestamp":"2026-07-26T10:00:01.000Z","turn_id":"turn-1"}"#
        );
        assert_eq!(
            lines[2],
            r#"{"role":"tool","tool_call_id":"call-1","name":"read_file","content":"{}","status":"completed","timestamp":"2026-07-26T10:00:01.000Z","turn_id":"turn-1"}"#
        );
    }

    #[test]
    fn list_returns_summary_without_reading_messages_or_inspection_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        fs::write(
            session_path(dir.path(), id),
            format!(
                "{}\nnot valid json\n",
                serde_json::to_string(&SessionFileHeader {
                    record_type: "metadata".to_string(),
                    key: id.to_string(),
                    created_at: "2026-07-26T10:00:00.000Z".to_string(),
                    updated_at: "2026-07-26T10:00:01.000Z".to_string(),
                    environment_key: "local".to_string(),
                    cwd: "D:/workspace/project".to_string(),
                    metadata: serde_json::from_value(json!({
                        "title": "metadata only",
                        "systemPrompt": "large inspection-only value"
                    }))
                    .unwrap(),
                })
                .unwrap()
            ),
        )
        .unwrap();

        let sessions = list_sessions(dir.path()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "metadata only");
        assert!(serde_json::to_value(&sessions[0])
            .unwrap()
            .get("metadata")
            .is_none());
        assert!(read_session(dir.path(), id).is_err());
    }

    #[test]
    fn list_projects_agent_identity_and_legacy_sessions_as_main() {
        let dir = tempfile::tempdir().unwrap();
        let custom_id = Uuid::new_v4();
        let main_id = Uuid::new_v4();
        commit_session(
            dir.path(),
            &custom_session(custom_id, "custom", "a-review"),
            "local",
        )
        .unwrap();
        commit_session(dir.path(), &session(main_id, "legacy"), "local").unwrap();

        let sessions = list_sessions(dir.path()).unwrap();
        let custom = sessions
            .iter()
            .find(|item| item.id == custom_id.to_string())
            .unwrap();
        let main = sessions
            .iter()
            .find(|item| item.id == main_id.to_string())
            .unwrap();
        assert_eq!(custom.agent_id, "a-review");
        assert_eq!(custom.agent_name, "Reviewer");
        assert_eq!(custom.agent_icon, "reviewer");
        assert_eq!(main.agent_id, MAIN_AGENT_ID);
        assert_eq!(main.agent_name, MAIN_AGENT_NAME);
        assert_eq!(main.agent_icon, MAIN_AGENT_ICON);
    }

    #[test]
    fn agent_deletion_removes_only_owned_sessions_and_rejects_running_ones() {
        let dir = tempfile::tempdir().unwrap();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let main = Uuid::new_v4();
        commit_session(
            dir.path(),
            &custom_session(first, "first", "a-review"),
            "local",
        )
        .unwrap();
        commit_session(
            dir.path(),
            &custom_session(second, "second", "a-review"),
            "local",
        )
        .unwrap();
        commit_session(dir.path(), &session(main, "main"), "local").unwrap();
        let state = AiSessionsState::default();
        let run_lock = FileLock::try_acquire(&lock_path(dir.path(), first))
            .unwrap()
            .unwrap();
        state.run_locks.lock().unwrap().insert(first, run_lock);

        assert_eq!(
            delete_sessions_by_agent(dir.path(), &state, "a-review").unwrap_err(),
            "CUSTOM_AGENT_SESSIONS_RUNNING"
        );
        assert!(session_path(dir.path(), second).exists());
        state.run_locks.lock().unwrap().remove(&first);

        let external_lock = FileLock::try_acquire(&lock_path(dir.path(), second))
            .unwrap()
            .unwrap();
        assert_eq!(
            delete_sessions_by_agent(dir.path(), &state, "a-review").unwrap_err(),
            "CUSTOM_AGENT_SESSIONS_RUNNING"
        );
        assert!(session_path(dir.path(), first).exists());
        drop(external_lock);

        let mut deleted = delete_sessions_by_agent(dir.path(), &state, "a-review").unwrap();
        deleted.sort();
        let mut expected = vec![first.to_string(), second.to_string()];
        expected.sort();
        assert_eq!(deleted, expected);
        assert!(session_path(dir.path(), main).exists());
    }

    #[test]
    fn rejects_headers_without_environment_identity() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        fs::write(
            session_path(dir.path(), id),
            format!(
                "{}\n",
                json!({
                    "_type": "metadata",
                    "key": id,
                    "createdAt": "2026-07-26T10:00:00.000Z",
                    "updatedAt": "2026-07-26T10:00:01.000Z",
                    "metadata": {"title": "legacy"}
                })
            ),
        )
        .unwrap();

        assert!(read_session(dir.path(), id).is_err());
        assert!(list_sessions(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn refuses_to_reassign_a_session_to_another_environment() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        commit_session(dir.path(), &session(id, "local"), "local").unwrap();

        let mut foreign = session(id, "foreign");
        foreign.environment_key = "wsl:Ubuntu".to_string();
        assert!(commit_session(dir.path(), &foreign, "wsl:Ubuntu").is_err());

        let stored = read_session(dir.path(), id).unwrap();
        assert_eq!(stored.environment_key, "local");
        assert_eq!(stored.metadata["title"], "local");
        assert_eq!(stored.messages.len(), 1);
    }

    #[test]
    fn refuses_to_change_a_session_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        commit_session(dir.path(), &session(id, "local"), "local").unwrap();

        let mut moved = session(id, "moved");
        moved.cwd = "D:/workspace/other".to_string();
        assert!(commit_session(dir.path(), &moved, "local").is_err());

        let stored = read_session(dir.path(), id).unwrap();
        assert_eq!(stored.cwd, "D:/workspace/project");
        assert_eq!(stored.metadata["title"], "local");
    }

    #[test]
    fn channel_ownership_survives_listing_and_cannot_be_rebound() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let owner = Uuid::new_v4().to_string();
        let mut initial = session(id, "channel");
        initial.metadata.insert("channelId".into(), json!(owner));
        commit_session(dir.path(), &initial, "local").unwrap();
        assert_eq!(
            metadata(dir.path(), id).unwrap().channel_id.as_deref(),
            Some(owner.as_str())
        );
        initial.metadata.remove("channelId");
        assert!(commit_session(dir.path(), &initial, "local").is_err());
        assert_eq!(
            read_session(dir.path(), id).unwrap().metadata["channelId"],
            owner
        );
    }

    #[test]
    fn refuses_to_change_a_session_agent_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        commit_session(
            dir.path(),
            &custom_session(id, "review", "a-review"),
            "local",
        )
        .unwrap();

        let mut changed = custom_session(id, "changed", "a-review");
        changed.metadata["agent"]["instructions"] = json!("Different instructions.");
        assert_eq!(
            commit_session(dir.path(), &changed, "local").unwrap_err(),
            "session agent snapshot must not change"
        );

        let stored = read_session(dir.path(), id).unwrap();
        assert_eq!(stored.metadata["title"], "review");
        assert_eq!(
            stored.metadata["agent"]["instructions"],
            "Review carefully."
        );
    }

    #[test]
    fn external_agent_binding_only_accepts_the_first_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut initial = session(id, "external");
        initial.metadata.insert(
            "externalAgent".into(),
            json!({ "agentId": "claude", "sessionId": null }),
        );
        commit_session(dir.path(), &initial, "local").unwrap();

        let mut captured = initial.clone();
        captured.metadata["externalAgent"]["sessionId"] = json!("session-1");
        commit_session(dir.path(), &captured, "local").unwrap();

        let mut changed = captured;
        changed.metadata["externalAgent"]["sessionId"] = json!("session-2");
        assert_eq!(
            commit_session(dir.path(), &changed, "local").unwrap_err(),
            "session External Agent session id must not change"
        );
    }

    #[test]
    fn acquiring_a_saved_session_restores_its_cwd_authorization() {
        let sessions = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut saved = session(id, "saved");
        saved.cwd = workspace.path().to_string_lossy().into_owned();
        commit_session(sessions.path(), &saved, "local").unwrap();

        let state = AiSessionsState::default();
        let registry = WorkspaceRegistry::default();
        let canonical = fs::canonicalize(workspace.path()).unwrap();
        assert!(!registry.is_authorized(&canonical));

        assert!(acquire_session_run(
            sessions.path(),
            &state,
            &registry,
            id,
            "local",
            &WorkspaceEnv::Local,
        )
        .unwrap());
        assert!(registry.is_authorized(&canonical));
    }

    #[test]
    fn accepts_opaque_message_objects_and_rejects_non_objects() {
        let id = Uuid::new_v4();
        let mut value = session(id, "opaque");
        value.messages = vec![json!({
            "role": "subtool",
            "content": {"custom": true},
            "timestamp": "2026-07-26T10:00:01.000Z",
            "future_field": ["preserved"]
        })];
        assert!(validate_session_file(&value).is_ok());
        value.messages = vec![json!("not an object")];
        assert!(validate_session_file(&value).is_err());
    }

    #[test]
    fn rejects_partial_agent_snapshots_but_accepts_legacy_sessions() {
        let id = Uuid::new_v4();
        assert!(validate_session_file(&session(id, "legacy")).is_ok());
        let mut partial = session(id, "partial");
        partial
            .metadata
            .insert("agent".to_string(), json!({"id": "a-review"}));
        assert!(validate_session_file(&partial).is_err());
    }

    #[test]
    fn subprocess_session_lock_helper() {
        let Some(root) = std::env::var_os("TERAX_SESSION_TEST_ROOT") else {
            return;
        };
        let id = Uuid::parse_str(&std::env::var("TERAX_SESSION_TEST_ID").unwrap()).unwrap();
        let ready = PathBuf::from(std::env::var_os("TERAX_SESSION_TEST_READY").unwrap());
        let release = PathBuf::from(std::env::var_os("TERAX_SESSION_TEST_RELEASE").unwrap());
        let _lock = FileLock::try_acquire(&lock_path(Path::new(&root), id))
            .unwrap()
            .unwrap();
        fs::write(&ready, b"ready").unwrap();
        wait_for(&release);
    }

    #[test]
    fn commit_is_exclusive_across_processes_and_retries_after_release() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let ready = dir.path().join("ready");
        let release = dir.path().join("release");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("modules::ai_sessions::tests::subprocess_session_lock_helper")
            .arg("--nocapture")
            .env("TERAX_SESSION_TEST_ROOT", dir.path())
            .env("TERAX_SESSION_TEST_ID", id.to_string())
            .env("TERAX_SESSION_TEST_READY", &ready)
            .env("TERAX_SESSION_TEST_RELEASE", &release)
            .spawn()
            .unwrap();

        wait_for(&ready);
        let state = AiSessionsState::default();
        let value = session(id, "locked");
        assert!(commit_with_run_lock(dir.path(), &state, id, &value, "local").is_err());
        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());

        commit_with_run_lock(dir.path(), &state, id, &value, "local").unwrap();
        assert_eq!(
            read_session(dir.path(), id).unwrap().metadata["title"],
            "locked"
        );
    }
}
