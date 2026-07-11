use crate::modules::storage::{write_atomic, FileLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(test)]
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
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

fn publish_with_run_lock(
    root: &Path,
    state: &AiSessionsState,
    id: Uuid,
    snapshot: &SessionSnapshot,
) -> Result<(), String> {
    let run_locks = state
        .run_locks
        .lock()
        .map_err(|_| "AI session lock state is poisoned".to_string())?;
    if run_locks.contains_key(&id) {
        return publish_snapshot(root, snapshot);
    }
    drop(run_locks);
    let _lock = FileLock::try_acquire(&lock_path(root, id))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "session is running in another window".to_string())?;
    publish_snapshot(root, snapshot)
}

#[tauri::command]
pub fn ai_session_publish(
    app: AppHandle,
    state: State<'_, AiSessionsState>,
    snapshot: SessionSnapshot,
) -> Result<(), String> {
    let id = validate_snapshot(&snapshot)?;
    let root = sessions_dir(&app)?;
    publish_with_run_lock(&root, state.inner(), id, &snapshot)
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

#[cfg(test)]
mod tests {
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
    fn publish_is_exclusive_across_processes_and_retries_after_release() {
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
        let value = snapshot(id, "locked");
        assert!(publish_with_run_lock(dir.path(), &state, id, &value).is_err());
        fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());

        publish_with_run_lock(dir.path(), &state, id, &value).unwrap();
        assert_eq!(read_snapshot(dir.path(), id).unwrap().title, "locked");
    }
}
