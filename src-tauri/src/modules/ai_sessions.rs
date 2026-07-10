use crate::modules::storage::{write_atomic, FileLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const MIGRATION_MARKER: &str = ".migration-v1-complete";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshot {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<Value>,
    pub todos: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub modified_at: u64,
    pub size: u64,
    pub fingerprint: String,
}

#[derive(Default)]
pub struct AiSessionsState {
    run_locks: Mutex<HashMap<Uuid, FileLock>>,
}

fn strict_uuid(id: &str) -> Result<Uuid, String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "session id must be a UUID".to_string())?;
    if parsed.to_string() != id {
        return Err("session id must use canonical lowercase UUID format".to_string());
    }
    Ok(parsed)
}

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sessions"))
}

fn snapshot_path(root: &Path, id: Uuid) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn lock_path(root: &Path, id: Uuid) -> PathBuf {
    root.join(format!("{id}.lock"))
}

fn validate_snapshot(snapshot: &SessionSnapshot) -> Result<Uuid, String> {
    if snapshot.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported session schema version {}",
            snapshot.schema_version
        ));
    }
    let id = strict_uuid(&snapshot.id)?;
    if snapshot.updated_at < snapshot.created_at {
        return Err("session updatedAt precedes createdAt".to_string());
    }
    Ok(id)
}

fn read_snapshot(root: &Path, id: Uuid) -> Result<SessionSnapshot, String> {
    let path = snapshot_path(root, id);
    let bytes = fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let snapshot: SessionSnapshot = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    let inner_id = validate_snapshot(&snapshot)?;
    if inner_id != id {
        return Err(format!(
            "session id does not match filename: {}",
            path.display()
        ));
    }
    Ok(snapshot)
}

fn publish_snapshot(root: &Path, snapshot: &SessionSnapshot) -> Result<(), String> {
    let id = validate_snapshot(snapshot)?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
    write_atomic(&snapshot_path(root, id), &bytes).map_err(|error| error.to_string())
}

fn metadata(root: &Path, id: Uuid) -> Result<SessionMetadata, String> {
    let snapshot = read_snapshot(root, id)?;
    let info = fs::metadata(snapshot_path(root, id)).map_err(|error| error.to_string())?;
    let modified_at = info
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let size = info.len();
    Ok(SessionMetadata {
        id: snapshot.id,
        title: snapshot.title,
        created_at: snapshot.created_at,
        updated_at: snapshot.updated_at,
        modified_at,
        size,
        fingerprint: format!("{modified_at}:{size}"),
    })
}

fn list_sessions(root: &Path) -> Result<Vec<SessionMetadata>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
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
            Err(error) => log::warn!("ignoring invalid session snapshot: {error}"),
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

#[tauri::command]
pub fn ai_sessions_list(app: AppHandle) -> Result<Vec<SessionMetadata>, String> {
    list_sessions(&sessions_dir(&app)?)
}

#[tauri::command]
pub fn ai_session_read(app: AppHandle, id: String) -> Result<SessionSnapshot, String> {
    read_snapshot(&sessions_dir(&app)?, strict_uuid(&id)?)
}

#[tauri::command]
pub fn ai_session_publish(
    app: AppHandle,
    state: State<'_, AiSessionsState>,
    snapshot: SessionSnapshot,
) -> Result<(), String> {
    let id = validate_snapshot(&snapshot)?;
    let root = sessions_dir(&app)?;
    let owns_run_lock = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?
        .contains_key(&id);
    if owns_run_lock {
        return publish_snapshot(&root, &snapshot);
    }
    let _lock = FileLock::try_acquire(&lock_path(&root, id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session is running in another window".to_string())?;
    publish_snapshot(&root, &snapshot)
}

#[tauri::command]
pub fn ai_session_delete(
    app: AppHandle,
    state: State<'_, AiSessionsState>,
    id: String,
) -> Result<(), String> {
    let id = strict_uuid(&id)?;
    let root = sessions_dir(&app)?;
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
    let path = snapshot_path(&root, id);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn ai_session_run_acquire(
    app: AppHandle,
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
    let root = sessions_dir(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let Some(lock) =
        FileLock::try_acquire(&lock_path(&root, id)).map_err(|error| error.to_string())?
    else {
        return Ok(false);
    };
    locks.insert(id, lock);
    Ok(true)
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySession {
    id: String,
    title: String,
    created_at: u64,
    updated_at: u64,
}

fn object_from_file(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))
}

fn migrate_legacy(root: &Path, app_data: &Path) -> Result<usize, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    if root.join(MIGRATION_MARKER).exists() {
        return Ok(0);
    }
    let _migration_lock = FileLock::try_acquire(&root.join(".migration-v1.lock"))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "AI session migration is running in another process".to_string())?;
    if root.join(MIGRATION_MARKER).exists() {
        return Ok(0);
    }

    let sessions_path = app_data.join("terax-ai-sessions.json");
    let todos_path = app_data.join("terax-ai-todos.json");
    let sessions_store = object_from_file(&sessions_path)?;
    let todos_store = object_from_file(&todos_path)?;
    let legacy_sessions: Vec<LegacySession> = match sessions_store.get("sessions") {
        None => Vec::new(),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid legacy sessions: {error}"))?,
    };

    for legacy in &legacy_sessions {
        let id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("terax-ai-session:{}", legacy.id).as_bytes(),
        );
        let messages = match sessions_store.get(&format!("messages:{}", legacy.id)) {
            None => Vec::new(),
            Some(Value::Array(values)) => values.clone(),
            Some(_) => {
                return Err(format!(
                    "legacy messages for {} are not an array",
                    legacy.id
                ))
            }
        };
        let todos = match todos_store.get(&format!("todos:{}", legacy.id)) {
            None => Vec::new(),
            Some(Value::Array(values)) => values.clone(),
            Some(_) => return Err(format!("legacy todos for {} are not an array", legacy.id)),
        };
        publish_snapshot(
            root,
            &SessionSnapshot {
                schema_version: SCHEMA_VERSION,
                id: id.to_string(),
                title: legacy.title.clone(),
                created_at: legacy.created_at,
                updated_at: legacy.updated_at,
                messages,
                todos,
            },
        )?;
    }

    write_atomic(&root.join(MIGRATION_MARKER), b"1\n").map_err(|error| error.to_string())?;
    if sessions_path.exists() {
        fs::rename(
            &sessions_path,
            app_data.join("terax-ai-sessions.v0.backup.json"),
        )
        .map_err(|error| error.to_string())?;
    }
    if todos_path.exists() {
        fs::rename(&todos_path, app_data.join("terax-ai-todos.v0.backup.json"))
            .map_err(|error| error.to_string())?;
    }
    Ok(legacy_sessions.len())
}

#[tauri::command]
pub fn ai_sessions_migrate_legacy(app: AppHandle) -> Result<usize, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    migrate_legacy(&app_data.join("sessions"), &app_data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(id: Uuid, title: &str) -> SessionSnapshot {
        SessionSnapshot {
            schema_version: 1,
            id: id.to_string(),
            title: title.to_string(),
            created_at: 10,
            updated_at: 20,
            messages: vec![json!({"role": "user", "parts": []})],
            todos: vec![json!({"id": "todo", "title": "test", "status": "pending"})],
        }
    }

    #[test]
    fn rejects_noncanonical_ids_and_path_traversal() {
        assert!(strict_uuid("../session").is_err());
        assert!(strict_uuid(&Uuid::new_v4().to_string().to_uppercase()).is_err());
    }

    #[test]
    fn publish_replaces_complete_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        publish_snapshot(dir.path(), &snapshot(id, "old")).unwrap();
        publish_snapshot(dir.path(), &snapshot(id, "new")).unwrap();
        assert_eq!(read_snapshot(dir.path(), id).unwrap().title, "new");
        assert_eq!(list_sessions(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn migration_is_lossless_and_idempotent() {
        let app_data = tempfile::tempdir().unwrap();
        fs::write(
            app_data.path().join("terax-ai-sessions.json"),
            serde_json::to_vec(&json!({
                "sessions": [{
                    "id": "legacy-one",
                    "title": "History",
                    "createdAt": 1,
                    "updatedAt": 2
                }],
                "messages:legacy-one": [{"role": "user", "parts": []}]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            app_data.path().join("terax-ai-todos.json"),
            serde_json::to_vec(&json!({
                "todos:legacy-one": [{"id": "one", "title": "Todo", "status": "pending"}]
            }))
            .unwrap(),
        )
        .unwrap();

        let root = app_data.path().join("sessions");
        assert_eq!(migrate_legacy(&root, app_data.path()).unwrap(), 1);
        assert_eq!(migrate_legacy(&root, app_data.path()).unwrap(), 0);
        let listed = list_sessions(&root).unwrap();
        assert_eq!(listed.len(), 1);
        let loaded = read_snapshot(&root, strict_uuid(&listed[0].id).unwrap()).unwrap();
        assert_eq!(loaded.title, "History");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.todos.len(), 1);
        assert!(app_data
            .path()
            .join("terax-ai-sessions.v0.backup.json")
            .exists());
    }

    #[test]
    fn failed_migration_does_not_create_marker_or_backup() {
        let app_data = tempfile::tempdir().unwrap();
        fs::write(
            app_data.path().join("terax-ai-sessions.json"),
            br#"{"sessions":"broken"}"#,
        )
        .unwrap();
        let root = app_data.path().join("sessions");
        assert!(migrate_legacy(&root, app_data.path()).is_err());
        assert!(!root.join(MIGRATION_MARKER).exists());
        assert!(app_data.path().join("terax-ai-sessions.json").exists());
    }
}
