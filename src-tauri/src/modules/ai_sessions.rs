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

use std::time::Duration;
use std::time::UNIX_EPOCH;
use uuid::Uuid;

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

/// 会话正文搜索结果，只返回首个可见文本命中，避免把完整历史加载到 WebView。
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionContentMatch {
    pub id: String,
    pub preview: String,
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

/// 串行化会话锁文件的打开与删除，不覆盖会话运行期；此固定锁文件不得删除。
fn lock_session_lifecycle(root: &Path) -> Result<FileLock, String> {
    FileLock::acquire(&root.join("sessions.lock"), Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session lock management is busy".to_string())
}

fn try_session_lock(root: &Path, id: Uuid) -> Result<Option<FileLock>, String> {
    let _lifecycle = lock_session_lifecycle(root)?;
    FileLock::try_acquire(&lock_path(root, id)).map_err(|error| error.to_string())
}

/// 调用方须持有生命周期锁，防止关闭句柄后其他进程打开即将删除的锁文件。
fn remove_session_files(root: &Path, id: Uuid, lock: FileLock) -> Result<(), String> {
    remove_if_present(&session_path(root, id))?;
    drop(lock);
    remove_if_present(&lock_path(root, id))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
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

/// 会话只接受完整身份，不持久化可变的指令和工具配置。
fn validate_agent_metadata(metadata: &Map<String, Value>) -> Result<(), String> {
    let agent = metadata
        .get("agent")
        .and_then(Value::as_object)
        .ok_or_else(|| "session agent must be an object".to_string())?;
    if agent.len() != 3 {
        return Err("session agent must contain only id, name and icon".to_string());
    }
    for field in ["id", "name", "icon"] {
        if agent
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(format!("session agent {field} must be a nonempty string"));
        }
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
    let mut business_metadata = update.metadata.clone();
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
            return Err("session agent identity must not change".to_string());
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
        // 分叉身份与计数由原生层拥有，旧窗口的 metadata 快照不能覆盖它们。
        for key in ["forkCount", "forkPath", "forkTitle"] {
            if let Some(value) = existing.metadata.get(key) {
                business_metadata.insert(key.into(), value.clone());
            } else {
                business_metadata.remove(key);
            }
        }
        existing.messages
    } else {
        Vec::new()
    };
    messages.extend(update.messages.iter().cloned());
    write_session(
        root,
        &SessionFile {
            metadata: business_metadata,
            messages,
            ..update.clone()
        },
    )?;
    metadata(root, id)
}

/// 读取已通过完整身份校验的会话归属。
fn session_agent_id(metadata: &Map<String, Value>) -> &str {
    metadata["agent"]["id"]
        .as_str()
        .expect("validated agent id")
}

fn session_agent_summary(metadata: &Map<String, Value>) -> (String, String, String) {
    let agent = &metadata["agent"];
    (
        session_agent_id(metadata).to_string(),
        agent["name"]
            .as_str()
            .expect("validated agent name")
            .to_string(),
        agent["icon"]
            .as_str()
            .expect("validated agent icon")
            .to_string(),
    )
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

fn normalized_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn case_insensitive_match(value: &str, query: &str) -> Option<usize> {
    if value.is_ascii() && query.is_ascii() {
        return value.to_ascii_lowercase().find(&query.to_ascii_lowercase());
    }
    let match_index = value.to_lowercase().find(&query.to_lowercase())?;
    let mut lowered_offset = 0;
    for (original_index, character) in value.char_indices() {
        let lowered_len = character.to_lowercase().map(char::len_utf8).sum::<usize>();
        if lowered_offset + lowered_len > match_index {
            return Some(original_index);
        }
        lowered_offset += lowered_len;
    }
    Some(value.len())
}

fn match_preview(value: &str, query: &str) -> Option<String> {
    let value = normalized_text(value);
    let index = case_insensitive_match(&value, query)?;
    let match_char = value[..index].chars().count();
    let chars = value.chars().collect::<Vec<_>>();
    let start = match_char.saturating_sub(40);
    let end = (start + 120).min(chars.len());
    let preview = chars[start..end].iter().collect::<String>();
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        preview,
        if end < chars.len() { "…" } else { "" }
    ))
}

fn visible_message_texts(record: &Value) -> Vec<&str> {
    match record.get("role").and_then(Value::as_str) {
        Some("user" | "assistant") => record
            .get("content")
            .and_then(Value::as_str)
            .into_iter()
            .collect(),
        Some("model") => record
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
            .flat_map(|message| match message.get("content") {
                Some(Value::String(text)) => vec![text.as_str()],
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect(),
                _ => Vec::new(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn search_session_content(root: &Path, id: Uuid, query: &str) -> Result<Option<String>, String> {
    let file = match File::open(session_path(root, id)) {
        Ok(file) => file,
        // 列表刷新或其他窗口可能在搜索请求到达前删除会话。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    for line in BufReader::new(file).lines().skip(1) {
        let record = serde_json::from_str::<Value>(&line.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        for text in visible_message_texts(&record) {
            if let Some(preview) = match_preview(text, query) {
                return Ok(Some(preview));
            }
        }
    }
    Ok(None)
}

fn search_sessions(
    root: &Path,
    query: &str,
    session_ids: Vec<String>,
) -> Result<Vec<SessionContentMatch>, String> {
    let query = normalized_text(query);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    session_ids
        .into_iter()
        .map(|id| {
            let parsed = strict_uuid(&id)?;
            Ok(search_session_content(root, parsed, &query)?
                .map(|preview| SessionContentMatch { id, preview }))
        })
        .filter_map(|result| result.transpose())
        .collect()
}

/// 列出当前用户的全部有效 AI 会话。
pub fn ai_sessions_list() -> Result<Vec<SessionMetadata>, String> {
    list_sessions(&sessions_dir()?)
}

/// 在指定会话中搜索用户与助手可见文本，并返回每个会话的首个命中。
pub fn ai_sessions_search(
    query: String,
    session_ids: Vec<String>,
) -> Result<Vec<SessionContentMatch>, String> {
    search_sessions(&sessions_dir()?, &query, session_ids)
}

/// 读取指定 AI 会话的 metadata 和全部消息记录。
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
    let _lock = try_session_lock(root, id)?
        .ok_or_else(|| "session is running in another window".to_string())?;
    commit_session(root, session, environment_key)
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
    shared_store::with_ai_agent(&agent_id, || {
        commit_with_run_lock(&root, state, id, &session, &environment_key)
    })
}

/// 显式历史操作只能在调用方持有运行锁时执行，并校验界面所见版本。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryAction {
    Edit {
        message_id: String,
        text: String,
        turn_id: String,
    },
    Fork {
        turn_id: String,
        label: String,
    },
}

/// 返回已提交的记录，调用方无需再次读盘即可安装一致的内存历史。
#[derive(Serialize)]
pub struct HistoryRevision {
    pub meta: SessionMetadata,
    pub session: SessionFile,
}

/// 持有源会话锁期间校验版本并原子提交历史变更。
pub fn revise_history(
    state: &AiSessionsState,
    environment_key: &str,
    id: String,
    fingerprint: String,
    action: HistoryAction,
    now: String,
) -> Result<HistoryRevision, String> {
    let root = sessions_dir()?;
    let uuid = strict_uuid(&id)?;
    let locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned")?;
    if !locks.contains_key(&uuid) {
        return Err("Session is not locked".into());
    }
    revise_history_file(&root, uuid, environment_key, &fingerprint, action, now)
}

fn revise_history_file(
    root: &Path,
    id: Uuid,
    environment_key: &str,
    fingerprint: &str,
    action: HistoryAction,
    now: String,
) -> Result<HistoryRevision, String> {
    if metadata(root, id)?.fingerprint != fingerprint {
        return Err("Session changed; reopen it before editing or forking".into());
    }
    let mut session = read_session(root, id)?;
    if session.environment_key != environment_key
        || session.metadata.contains_key("channelId")
        || session.metadata.contains_key("externalAgent")
    {
        return Err("History actions require a desktop built-in Agent session".into());
    }
    validate_timestamps(&now, &now)?;
    match action {
        HistoryAction::Edit {
            message_id,
            text,
            turn_id,
        } => {
            let index = session
                .messages
                .iter()
                .rposition(|r| r["role"] == "user")
                .ok_or("No user message")?;
            let record = &session.messages[index];
            let fallback = format!("{}:user:{}", session.id, index);
            if record["message_id"].as_str().unwrap_or(&fallback) != message_id
                || record.get("command_id").is_some()
            {
                return Err("Only the latest user message can be edited".into());
            }
            if text.trim().is_empty()
                && record["media"].as_array().is_none_or(Vec::is_empty)
                && record["attachments"].as_array().is_none_or(Vec::is_empty)
            {
                return Err("Message is empty".into());
            }
            session.messages.truncate(index + 1);
            let record = &mut session.messages[index];
            record["content"] = Value::String(text);
            record["timestamp"] = Value::String(now.clone());
            record["turn_id"] = Value::String(turn_id);
            record.as_object_mut().unwrap().remove("guided");
        }
        HistoryAction::Fork { turn_id, label } => {
            let end = session
                .messages
                .iter()
                .rposition(|r| r["turn_id"] == turn_id)
                .ok_or("Final reply is unavailable")?;
            let final_record = session.messages[..=end]
                .iter()
                .rev()
                .find(|r| {
                    r["turn_id"] == turn_id && (r["role"] == "model" || r["role"] == "assistant")
                })
                .ok_or("Final reply is unavailable")?;
            if final_record["turn_status"] != "completed" {
                return Err("Reply is not complete".into());
            }
            let number = session
                .metadata
                .get("forkCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            session
                .metadata
                .insert("forkCount".into(), Value::from(number));
            // 先预留序号；创建失败允许跳号，删除子会话也不复用编号。
            write_session(root, &session)?;
            let mut path = session
                .metadata
                .get("forkPath")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            path.push(Value::from(number));
            let title = session
                .metadata
                .get("forkTitle")
                .or_else(|| session.metadata.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("New chat")
                .to_string();
            let suffix: String = path
                .iter()
                .map(|v| format!("({})", v.as_u64().unwrap()))
                .collect();
            session.metadata.insert(
                "title".into(),
                Value::String(format!("{label}{suffix}·{title}")),
            );
            session
                .metadata
                .insert("forkTitle".into(), Value::String(title));
            session
                .metadata
                .insert("forkPath".into(), Value::Array(path));
            session.metadata.remove("forkCount");
            session.messages.truncate(end + 1);
            session.id = Uuid::new_v4().to_string();
            session.created_at = now.clone();
        }
    }
    session.updated_at = now;
    write_session(root, &session)?;
    Ok(HistoryRevision {
        meta: metadata(root, strict_uuid(&session.id)?)?,
        session,
    })
}

/// 删除指定会话文件，运行中的会话不可删除。
pub fn ai_session_delete(state: &AiSessionsState, id: String) -> Result<(), String> {
    delete_session(&sessions_dir()?, state, strict_uuid(&id)?)
}

fn delete_session(root: &Path, state: &AiSessionsState, id: Uuid) -> Result<(), String> {
    if state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?
        .contains_key(&id)
    {
        return Err("cannot delete a running session".to_string());
    }
    let _lifecycle = lock_session_lifecycle(root)?;
    let lock = FileLock::try_acquire(&lock_path(root, id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session is running in another window".to_string())?;
    let path = session_path(root, id);
    if path.exists() {
        let header = read_header(&path, id)?;
        if let Some(channel_id) = header.metadata.get("channelId").and_then(Value::as_str) {
            if shared_store::read_value::<Value>("channels", channel_id)?.is_some() {
                return Err("CHANNEL_SESSION_IS_BOUND".into());
            }
        }
    }
    remove_session_files(root, id, lock)
}

/// 删除指定 Custom Agent 拥有的全部会话。
///
/// 调用方必须先持有共享 Agent 配置锁。函数会先取得全部会话锁再删除任何文件，
/// 检测到任一运行中会话时不产生部分删除。
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

    let _lifecycle = lock_session_lifecycle(root)?;
    let mut file_locks = Vec::with_capacity(ids.len());
    for id in &ids {
        let Some(lock) =
            FileLock::try_acquire(&lock_path(root, *id)).map_err(|error| error.to_string())?
        else {
            return Err("CUSTOM_AGENT_SESSIONS_RUNNING".to_string());
        };
        file_locks.push(lock);
    }

    for (id, lock) in ids.iter().zip(file_locks) {
        remove_session_files(root, *id, lock)?;
    }
    Ok(ids.into_iter().map(|id| id.to_string()).collect())
}

/// 级联删除 Custom Agent 和其跨 Workspace 的全部会话。
pub fn ai_agent_delete(
    events: &dyn shared_store::StoreEvents,
    state: &AiSessionsState,
    agent_id: String,
) -> Result<Vec<String>, String> {
    let root = sessions_dir()?;
    shared_store::delete_ai_agent_with(events, &agent_id, || {
        delete_sessions_by_agent(&root, state, &agent_id)
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
    let Some(lock) = try_session_lock(root, id)? else {
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
                "title": title,
                "agent": { "id": "builtin:main", "name": "Terax", "icon": "coder" }
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
                "icon": "reviewer"
            }),
        );
        value
    }

    #[test]
    fn history_edit_keeps_prefix_and_attachments_and_rejects_stale_versions() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut file = session(id, "original");
        file.messages.extend(vec![
            json!({"role":"model","turn_id":"first","content":[{"role":"assistant","content":"answer","providerOptions":{"test":{"signature":"signed"}}}],"turn_status":"completed"}),
            json!({"role":"user","message_id":"last","content":"old","guided":true,"attachments":[{"kind":"snippet","text":"snapshot"}],"media":[{"url":"data:image/png;base64,AA"}]}),
            json!({"role":"model","turn_id":"last","content":[],"turn_status":"cancelled"}),
            json!({"role":"event","content":{"event":"compaction","summary":"later"}}),
        ]);
        write_session(dir.path(), &file).unwrap();
        let fingerprint = metadata(dir.path(), id).unwrap().fingerprint;
        let action = || HistoryAction::Edit {
            message_id: "last".into(),
            text: "new".into(),
            turn_id: "replacement".into(),
        };
        assert!(revise_history_file(
            dir.path(),
            id,
            "local",
            "stale",
            action(),
            file.updated_at.clone()
        )
        .is_err());
        assert_eq!(read_session(dir.path(), id).unwrap(), file);
        assert!(revise_history_file(
            dir.path(),
            id,
            "wsl:Ubuntu",
            &fingerprint,
            action(),
            file.updated_at.clone()
        )
        .is_err());
        assert_eq!(read_session(dir.path(), id).unwrap(), file);
        revise_history_file(
            dir.path(),
            id,
            "local",
            &fingerprint,
            action(),
            file.updated_at.clone(),
        )
        .unwrap();
        let edited = read_session(dir.path(), id).unwrap();
        assert_eq!(edited.messages.len(), 3);
        assert_eq!(edited.messages[..2], file.messages[..2]);
        assert_eq!(
            edited.messages[2]["attachments"],
            file.messages[2]["attachments"]
        );
        assert_eq!(edited.messages[2]["media"], file.messages[2]["media"]);
        assert_eq!(edited.messages[2]["content"], "new");
        assert!(edited.messages[2].get("guided").is_none());
        assert_eq!(edited.metadata, file.metadata);
    }

    #[test]
    fn forks_copy_complete_prefix_and_allocate_independent_monotonic_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut file = session(id, "original");
        file.messages.extend(vec![
            json!({"role":"model","turn_id":"first","content":[{"role":"assistant","content":"answer"}],"turn_status":"completed"}),
            json!({"role":"display","turn_id":"first","content":{"snapshot":true}}),
            json!({"role":"user","message_id":"later","content":"later"}),
            json!({"role":"model","turn_id":"later","content":[],"turn_status":"cancelled"}),
        ]);
        write_session(dir.path(), &file).unwrap();
        let fork = |source| {
            revise_history_file(
                dir.path(),
                source,
                "local",
                &metadata(dir.path(), source).unwrap().fingerprint,
                HistoryAction::Fork {
                    turn_id: "first".into(),
                    label: "分叉".into(),
                },
                file.updated_at.clone(),
            )
            .unwrap()
            .meta
        };
        let first = fork(id);
        let first_id = strict_uuid(&first.id).unwrap();
        assert_eq!(first.title, "分叉(1)·original");
        let mut stale = file.clone();
        stale.messages.clear();
        commit_session(dir.path(), &stale, "local").unwrap();
        assert_eq!(
            read_session(dir.path(), id).unwrap().metadata["forkCount"],
            1
        );
        assert_eq!(
            read_session(dir.path(), first_id).unwrap().messages,
            file.messages[..3]
        );
        assert_eq!(fork(first_id).title, "分叉(1)(1)·original");
        assert_eq!(fork(first_id).title, "分叉(1)(2)·original");
        fs::remove_file(session_path(dir.path(), first_id)).unwrap();
        assert_eq!(fork(id).title, "分叉(2)·original");
        assert_eq!(
            read_session(dir.path(), id).unwrap().messages,
            file.messages
        );
        assert!(revise_history_file(
            dir.path(),
            id,
            "local",
            &metadata(dir.path(), id).unwrap().fingerprint,
            HistoryAction::Fork {
                turn_id: "later".into(),
                label: "Fork".into()
            },
            file.updated_at
        )
        .is_err());
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
                        "agent": { "id": "builtin:main", "name": "Terax", "icon": "coder" },
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
    fn list_projects_main_and_custom_agent_identities() {
        let dir = tempfile::tempdir().unwrap();
        let custom_id = Uuid::new_v4();
        let main_id = Uuid::new_v4();
        commit_session(
            dir.path(),
            &custom_session(custom_id, "custom", "a-review"),
            "local",
        )
        .unwrap();
        commit_session(dir.path(), &session(main_id, "main"), "local").unwrap();

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
        assert_eq!(main.agent_id, "builtin:main");
        assert_eq!(main.agent_name, "Terax");
        assert_eq!(main.agent_icon, "coder");
    }

    #[test]
    fn content_search_matches_visible_text_and_only_requested_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let included = Uuid::new_v4();
        let excluded = Uuid::new_v4();
        let mut first = session(included, "included");
        first.messages = vec![
            json!({
                "role": "system",
                "content": "hidden system secret",
                "timestamp": "2026-07-26T10:00:00.000Z"
            }),
            json!({
                "role": "assistant",
                "content": "The Release Checklist is ready for review",
                "reasoning_content": "hidden reasoning phrase",
                "timestamp": "2026-07-26T10:00:01.000Z"
            }),
            json!({
                "role": "tool",
                "name": "read_file",
                "content": "hidden tool phrase",
                "tool_call_id": "call-1",
                "timestamp": "2026-07-26T10:00:01.000Z"
            }),
        ];
        let mut second = session(excluded, "excluded");
        second.messages[0]["content"] = json!("release checklist elsewhere");
        commit_session(dir.path(), &first, "local").unwrap();
        commit_session(dir.path(), &second, "local").unwrap();

        let matches = search_sessions(
            dir.path(),
            "release checklist",
            vec![Uuid::new_v4().to_string(), included.to_string()],
        )
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].id, included.to_string());
        assert!(matches[0].preview.contains("Release Checklist"));
        assert!(
            search_sessions(dir.path(), "system secret", vec![included.to_string()])
                .unwrap()
                .is_empty()
        );
        assert!(
            search_sessions(dir.path(), "reasoning phrase", vec![included.to_string()])
                .unwrap()
                .is_empty()
        );
        assert!(
            search_sessions(dir.path(), "tool phrase", vec![included.to_string()])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn content_search_positions_unicode_case_insensitive_preview_at_match() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut value = session(id, "unicode");
        value.messages[0]["content"] = json!(format!("{} ÜBER das Ziel", "前".repeat(70)));
        commit_session(dir.path(), &value, "local").unwrap();

        let preview = search_sessions(dir.path(), "über", vec![id.to_string()]).unwrap()[0]
            .preview
            .clone();
        assert!(preview.starts_with('…'));
        assert!(preview.contains("ÜBER das Ziel"));
    }

    #[test]
    fn content_search_reads_assistant_text_from_model_records() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let mut value = session(id, "model");
        value.messages = vec![json!({
            "role": "model",
            "content": [
                { "role": "user", "content": "ignore user model input" },
                {
                    "role": "assistant",
                    "content": [
                        { "type": "reasoning", "text": "ignore model reasoning" },
                        { "type": "text", "text": "Visible model answer" }
                    ]
                }
            ],
            "timestamp": "2026-07-26T10:00:01.000Z"
        })];
        commit_session(dir.path(), &value, "local").unwrap();

        assert_eq!(
            search_sessions(dir.path(), "VISIBLE MODEL", vec![id.to_string()]).unwrap()[0].preview,
            "Visible model answer"
        );
        assert!(
            search_sessions(dir.path(), "model reasoning", vec![id.to_string()])
                .unwrap()
                .is_empty()
        );
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
        for id in [first, second] {
            assert!(!session_path(dir.path(), id).exists());
            assert!(!lock_path(dir.path(), id).exists());
        }
    }

    #[test]
    fn deletion_cleans_lock_and_preserves_files_when_running_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let state = AiSessionsState::default();
        commit_with_run_lock(dir.path(), &state, id, &session(id, "saved"), "local").unwrap();
        let lock = try_session_lock(dir.path(), id).unwrap().unwrap();
        state.run_locks.lock().unwrap().insert(id, lock);
        assert!(delete_session(dir.path(), &state, id).is_err());
        assert!(session_path(dir.path(), id).exists());
        assert!(lock_path(dir.path(), id).exists());
        release(&state, &id.to_string()).unwrap();

        delete_session(dir.path(), &state, id).unwrap();
        delete_session(dir.path(), &state, id).unwrap();
        assert!(!session_path(dir.path(), id).exists());
        assert!(!lock_path(dir.path(), id).exists());

        fs::write(session_path(dir.path(), id), b"invalid").unwrap();
        assert!(delete_session(dir.path(), &state, id).is_err());
        assert!(session_path(dir.path(), id).exists());
        assert!(lock_path(dir.path(), id).exists());

        // 数据删除失败时保留锁文件，且管理锁和会话锁均能重新取得。
        let lifecycle = lock_session_lifecycle(dir.path()).unwrap();
        let lock = FileLock::try_acquire(&lock_path(dir.path(), id))
            .unwrap()
            .unwrap();
        fs::remove_file(session_path(dir.path(), id)).unwrap();
        fs::create_dir(session_path(dir.path(), id)).unwrap();
        assert!(remove_session_files(dir.path(), id, lock).is_err());
        assert!(lock_path(dir.path(), id).exists());
        drop(lifecycle);
        assert!(try_session_lock(dir.path(), id).unwrap().is_some());
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
    fn refuses_to_change_a_session_agent_identity() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        commit_session(
            dir.path(),
            &custom_session(id, "review", "a-review"),
            "local",
        )
        .unwrap();

        let mut changed = custom_session(id, "changed", "a-review");
        changed.metadata["agent"]["id"] = json!("a-other");
        assert_eq!(
            commit_session(dir.path(), &changed, "local").unwrap_err(),
            "session agent identity must not change"
        );

        let stored = read_session(dir.path(), id).unwrap();
        assert_eq!(stored.metadata["title"], "review");
        assert_eq!(stored.metadata["agent"]["id"], "a-review");
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
    fn rejects_missing_partial_and_old_agent_snapshots() {
        let id = Uuid::new_v4();
        let mut missing = session(id, "missing");
        missing.metadata.remove("agent");
        assert!(validate_session_file(&missing).is_err());
        let mut old = session(id, "old");
        old.metadata["agent"]["instructions"] = json!("old instructions");
        assert!(validate_session_file(&old).is_err());
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
        if let Some(blocked) = std::env::var_os("TERAX_SESSION_TEST_BLOCKED") {
            assert!(
                FileLock::try_acquire(&Path::new(&root).join("sessions.lock"))
                    .unwrap()
                    .is_none()
            );
            fs::write(blocked, b"blocked").unwrap();
        }
        let _lock = try_session_lock(Path::new(&root), id).unwrap().unwrap();
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
        assert!(delete_session(dir.path(), &state, id).is_err());
        assert!(lock_path(dir.path(), id).exists());
        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());

        commit_with_run_lock(dir.path(), &state, id, &value, "local").unwrap();
        assert_eq!(
            read_session(dir.path(), id).unwrap().metadata["title"],
            "locked"
        );
        delete_session(dir.path(), &state, id).unwrap();
        assert!(!lock_path(dir.path(), id).exists());
    }

    #[test]
    fn lifecycle_lock_blocks_other_process_until_session_lock_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let ready = dir.path().join("ready");
        let release = dir.path().join("release");
        let blocked = dir.path().join("blocked");
        let lifecycle = lock_session_lifecycle(dir.path()).unwrap();
        let lock = FileLock::try_acquire(&lock_path(dir.path(), id))
            .unwrap()
            .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("modules::ai_sessions::tests::subprocess_session_lock_helper")
            .arg("--nocapture")
            .env("TERAX_SESSION_TEST_ROOT", dir.path())
            .env("TERAX_SESSION_TEST_ID", id.to_string())
            .env("TERAX_SESSION_TEST_READY", &ready)
            .env("TERAX_SESSION_TEST_RELEASE", &release)
            .env("TERAX_SESSION_TEST_BLOCKED", &blocked)
            .spawn()
            .unwrap();
        wait_for(&blocked);
        remove_session_files(dir.path(), id, lock).unwrap();
        assert!(!ready.exists());
        assert!(!lock_path(dir.path(), id).exists());
        drop(lifecycle);

        wait_for(&ready);
        assert!(try_session_lock(dir.path(), id).unwrap().is_none());
        // 管理锁不覆盖运行期，其他会话仍可独立取得运行锁。
        assert!(try_session_lock(dir.path(), Uuid::new_v4())
            .unwrap()
            .is_some());
        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());
        delete_session(dir.path(), &AiSessionsState::default(), id).unwrap();
        assert!(!lock_path(dir.path(), id).exists());
    }
}
