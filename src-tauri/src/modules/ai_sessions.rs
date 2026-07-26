//! AI 会话 JSONL 文件的读取、发布和跨进程运行锁管理。
//!
//! 每个会话使用一个文件，首行固定为 metadata，后续每行是一条 SDK 无关的消息记录。
//! 完整 turn 结束后原子替换文件，运行锁确保两个进程不能同时续写同一会话。

use crate::modules::storage::{write_atomic, FileLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Lines};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(test)]
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tauri::State;
use uuid::Uuid;

/// 前端与 Rust 之间传递的会话文件内容。
///
/// 读取时 messages 是完整记录，提交时 messages 只包含本次新增记录。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFile {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<Value>,
    pub todos: Vec<Value>,
}

/// 会话列表使用的轻量 metadata 和文件指纹。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
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
    metadata: SessionFileMetadata,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct SessionFileMetadata {
    title: String,
    #[serde(default)]
    todos: Vec<Value>,
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
    validate_timestamps(&header.created_at, &header.updated_at)
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
        title: header.metadata.title,
        created_at: header.created_at,
        updated_at: header.updated_at,
        messages,
        todos: header.metadata.todos,
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
        metadata: SessionFileMetadata {
            title: session.title.clone(),
            todos: session.todos.clone(),
        },
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

/// 在锁内读取现有记录，追加本次新增记录后整体原子替换。
fn commit_session(root: &Path, update: &SessionFile) -> Result<(), String> {
    let id = validate_session_file(update)?;
    let path = session_path(root, id);
    let mut messages = if path.exists() {
        let existing = read_session(root, id)?;
        if existing.created_at != update.created_at {
            return Err("session createdAt does not match existing file".to_string());
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
    Ok(SessionMetadata {
        id: header.key,
        title: header.metadata.title,
        created_at: header.created_at,
        updated_at: header.updated_at,
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
#[tauri::command]
pub fn ai_sessions_list() -> Result<Vec<SessionMetadata>, String> {
    list_sessions(&sessions_dir()?)
}

/// 读取指定 AI 会话的 metadata 和全部消息记录。
#[tauri::command]
pub fn ai_session_read(id: String) -> Result<SessionFile, String> {
    read_session(&sessions_dir()?, strict_uuid(&id)?)
}

/// 在持有进程内运行锁或临时取得文件锁后提交新增记录。
fn commit_with_run_lock(
    root: &Path,
    state: &AiSessionsState,
    id: Uuid,
    session: &SessionFile,
) -> Result<(), String> {
    let run_locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?;
    if run_locks.contains_key(&id) {
        return commit_session(root, session);
    }
    drop(run_locks);
    let _lock = FileLock::try_acquire(&lock_path(root, id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session is running in another window".to_string())?;
    commit_session(root, session)
}

/// 将新增记录提交到 AI 会话，拒绝写入其他进程正在运行的会话。
#[tauri::command]
pub fn ai_session_commit(
    state: State<'_, AiSessionsState>,
    session: SessionFile,
) -> Result<(), String> {
    let id = validate_session_file(&session)?;
    let root = sessions_dir()?;
    commit_with_run_lock(&root, state.inner(), id, &session)
}

/// 删除指定会话文件，运行中的会话不可删除。
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
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// 尝试为一次 AI 运行取得跨进程锁，重复取得同一锁视为成功。
#[tauri::command]
pub fn ai_session_run_acquire(
    state: State<'_, AiSessionsState>,
    id: String,
) -> Result<bool, String> {
    let id = strict_uuid(&id)?;
    let mut locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?;
    if locks.contains_key(&id) {
        return Ok(true);
    }
    let root = sessions_dir()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let Some(lock) =
        FileLock::try_acquire(&lock_path(&root, id)).map_err(|error| error.to_string())?
    else {
        return Ok(false);
    };
    locks.insert(id, lock);
    Ok(true)
}

/// 释放当前进程持有的 AI 会话运行锁。
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
            title: title.to_string(),
            created_at: "2026-07-26T10:00:00.000Z".to_string(),
            updated_at: "2026-07-26T10:00:01.000Z".to_string(),
            messages: vec![json!({
                "role": "user",
                "content": "hello",
                "timestamp": "2026-07-26T10:00:01.000Z"
            })],
            todos: vec![json!({"id": "todo", "title": "test", "status": "pending"})],
        }
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
        commit_session(dir.path(), &session(id, "old")).unwrap();
        let mut next = session(id, "new");
        next.messages[0]["content"] = json!("again");
        commit_session(dir.path(), &next).unwrap();

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
        assert_eq!(stored.title, "new");
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
    fn list_reads_only_metadata() {
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
                    metadata: SessionFileMetadata {
                        title: "metadata only".to_string(),
                        todos: Vec::new(),
                    },
                })
                .unwrap()
            ),
        )
        .unwrap();

        let sessions = list_sessions(dir.path()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "metadata only");
        assert!(read_session(dir.path(), id).is_err());
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
        assert!(commit_with_run_lock(dir.path(), &state, id, &value).is_err());
        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());

        commit_with_run_lock(dir.path(), &state, id, &value).unwrap();
        assert_eq!(read_session(dir.path(), id).unwrap().title, "locked");
    }
}
