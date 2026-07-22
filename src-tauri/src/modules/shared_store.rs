//! 跨 Terax 进程共享的白名单配置存储。
//!
//! 所有变更都在文件锁内读取最新值并原子替换文件。批量接口仅修改明确列出的键，
//! 用于保持跨键业务不变量，不允许调用方整表覆盖。

use crate::modules::storage::{write_atomic, FileLock};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const STORES: &[(&str, &str)] = &[
    ("settings", "terax-settings.json"),
    ("ssh-profiles", "terax-ssh-profiles.json"),
    ("custom-themes", "terax-custom-themes.json"),
    ("ai-agents", "terax-ai-agents.json"),
    ("ai-snippets", "terax-ai-snippets.json"),
    ("keys-epoch", "terax-keys-epoch.json"),
];
const WORKSPACE_FILE_OPEN_REQUESTS: &str = "workspaceFileOpenRequests";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileOpenRequest {
    environment: String,
    workspace_id: String,
    files: Vec<String>,
}

pub struct SharedStoreState {
    _watcher: Mutex<RecommendedWatcher>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedStoreChanged {
    store: String,
    revision: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
/// 一次共享存储批量提交中的精确键变更。
pub enum SharedStoreMutation {
    Set { key: String, value: Value },
    Delete { key: String },
}

fn filename(store: &str) -> Result<&'static str, String> {
    STORES
        .iter()
        .find_map(|(name, file)| (*name == store).then_some(*file))
        .ok_or_else(|| format!("shared store is not allowed: {store}"))
}

fn store_dir() -> Result<PathBuf, String> {
    crate::modules::app_data::directory(crate::modules::app_data::Directory::Shared)
}

fn store_path(root: &Path, store: &str) -> Result<PathBuf, String> {
    Ok(root.join(filename(store)?))
}

fn lock_path(root: &Path, store: &str) -> Result<PathBuf, String> {
    Ok(root.join(format!("{}.lock", filename(store)?)))
}

fn read_map(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("shared store {} is invalid: {error}", path.display()))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("shared store {} must contain an object", path.display()))
}

fn mutate<T>(
    root: &Path,
    store: &str,
    mutation: impl FnOnce(&mut Map<String, Value>) -> T,
) -> Result<T, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let _lock = FileLock::acquire(&lock_path(root, store)?, Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("shared store {store} is busy"))?;
    let path = store_path(root, store)?;
    let mut map = read_map(&path)?;
    let result = mutation(&mut map);
    let bytes = serde_json::to_vec(&map).map_err(|error| error.to_string())?;
    write_atomic(&path, &bytes).map_err(|error| error.to_string())?;
    Ok(result)
}

/// 校验并应用一组精确的键变更。
///
/// 调用方必须在 `mutate` 持有文件锁期间调用，避免其他进程观察到部分结果。
fn apply_mutations(
    map: &mut Map<String, Value>,
    mutations: Vec<SharedStoreMutation>,
) -> Result<(), String> {
    if mutations.iter().any(|mutation| match mutation {
        SharedStoreMutation::Set { key, .. } | SharedStoreMutation::Delete { key } => {
            key.is_empty()
        }
    }) {
        return Err("shared store key cannot be empty".to_string());
    }
    for mutation in mutations {
        match mutation {
            SharedStoreMutation::Set { key, value } => {
                map.insert(key, value);
            }
            SharedStoreMutation::Delete { key } => {
                map.remove(&key);
            }
        }
    }
    Ok(())
}

pub(crate) fn bump_keys_epoch(app: &AppHandle) -> Result<(), String> {
    let root = store_dir()?;
    mutate(&root, "keys-epoch", |map| {
        map.insert(
            "epoch".to_string(),
            Value::from(uuid::Uuid::new_v4().to_string()),
        );
    })?;
    emit_changed(app, &root, "keys-epoch")
}

pub(crate) fn request_workspace_activation(
    environment: &str,
    workspace_id: &str,
) -> Result<(), String> {
    let root = store_dir()?;
    mutate(&root, "settings", |map| {
        map.insert(
            "workspaceActivation".to_string(),
            serde_json::json!({
                "requestId": uuid::Uuid::new_v4().to_string(),
                "environment": environment,
                "workspaceId": workspace_id,
            }),
        );
    })
}

pub(crate) fn request_workspace_file_open(
    environment: &str,
    workspace_id: &str,
    files: &[String],
) -> Result<(), String> {
    request_workspace_file_open_at(&store_dir()?, environment, workspace_id, files)
}

fn request_workspace_file_open_at(
    root: &Path,
    environment: &str,
    workspace_id: &str,
    files: &[String],
) -> Result<(), String> {
    mutate(root, "settings", |map| {
        let requests = map
            .entry(WORKSPACE_FILE_OPEN_REQUESTS.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if !requests.is_array() {
            *requests = Value::Array(Vec::new());
        }
        requests
            .as_array_mut()
            .expect("workspace file open requests must be an array")
            .push(serde_json::json!({
                "environment": environment,
                "workspaceId": workspace_id,
                "files": files,
            }));
        map.insert(
            "workspaceActivation".to_string(),
            serde_json::json!({
                "requestId": uuid::Uuid::new_v4().to_string(),
                "environment": environment,
                "workspaceId": workspace_id,
            }),
        );
    })
}

pub(crate) fn take_workspace_file_open(
    environment: &str,
    workspace_id: &str,
) -> Result<Vec<String>, String> {
    take_workspace_file_open_at(&store_dir()?, environment, workspace_id)
}

fn take_workspace_file_open_at(
    root: &Path,
    environment: &str,
    workspace_id: &str,
) -> Result<Vec<String>, String> {
    mutate(root, "settings", |map| {
        let Some(Value::Array(requests)) = map.remove(WORKSPACE_FILE_OPEN_REQUESTS) else {
            return Vec::new();
        };
        let mut files = Vec::new();
        let mut pending = Vec::new();
        for value in requests {
            match serde_json::from_value::<WorkspaceFileOpenRequest>(value.clone()) {
                Ok(request)
                    if request.environment == environment
                        && request.workspace_id == workspace_id =>
                {
                    files.extend(request.files);
                }
                _ => pending.push(value),
            }
        }
        if !pending.is_empty() {
            map.insert(
                WORKSPACE_FILE_OPEN_REQUESTS.to_string(),
                Value::Array(pending),
            );
        }
        files
    })
}

fn revision(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return "missing".to_string();
    };
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}:{}", hasher.finish(), bytes.len())
}

fn emit_changed(app: &AppHandle, root: &Path, store: &str) -> Result<(), String> {
    app.emit(
        "terax://shared-store-changed",
        SharedStoreChanged {
            store: store.to_string(),
            revision: revision(&store_path(root, store)?),
        },
    )
    .map_err(|error| error.to_string())
}

impl SharedStoreState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let root = store_dir()?;
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let handle = app.clone();
        let watched_root = root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else {
                    return;
                };
                for path in event.paths {
                    let Some(file) = path.file_name().and_then(|value| value.to_str()) else {
                        continue;
                    };
                    let Some((store, _)) = STORES.iter().find(|(_, candidate)| *candidate == file)
                    else {
                        continue;
                    };
                    let _ = emit_changed(&handle, &watched_root, store);
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

#[tauri::command]
pub fn shared_store_read(store: String) -> Result<Map<String, Value>, String> {
    read_map(&store_path(&store_dir()?, &store)?)
}

#[tauri::command]
pub fn shared_store_set(
    app: AppHandle,
    store: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("shared store key cannot be empty".to_string());
    }
    let root = store_dir()?;
    mutate(&root, &store, |map| {
        map.insert(key, value);
    })?;
    emit_changed(&app, &root, &store)
}

#[tauri::command]
pub fn shared_store_delete(app: AppHandle, store: String, key: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("shared store key cannot be empty".to_string());
    }
    let root = store_dir()?;
    mutate(&root, &store, |map| {
        map.remove(&key);
    })?;
    emit_changed(&app, &root, &store)
}

#[tauri::command]
pub fn shared_store_mutate(
    app: AppHandle,
    store: String,
    mutations: Vec<SharedStoreMutation>,
) -> Result<(), String> {
    if mutations.is_empty() {
        return Ok(());
    }
    let root = store_dir()?;
    mutate(&root, &store, |map| apply_mutations(map, mutations))??;
    emit_changed(&app, &root, &store)
}

#[tauri::command]
pub fn shared_store_revision(store: String) -> Result<String, String> {
    Ok(revision(&store_path(&store_dir()?, &store)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Arc;
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

    #[test]
    fn rejects_unknown_store_and_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        assert!(store_path(dir.path(), "../../outside").is_err());
        let path = dir.path().join("terax-settings.json");
        fs::write(&path, "not json").unwrap();
        assert!(mutate(dir.path(), "settings", |_| {}).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "not json");
    }

    #[test]
    fn independent_key_mutations_do_not_overwrite_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writers: Vec<_> = [("font", "mono"), ("theme", "dark")]
            .into_iter()
            .map(|(key, value)| {
                let root = dir.path().to_path_buf();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    mutate(&root, "settings", |map| {
                        map.insert(key.to_string(), Value::from(value));
                    })
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        let map = read_map(&dir.path().join("terax-settings.json")).unwrap();
        assert_eq!(map.get("font"), Some(&Value::from("mono")));
        assert_eq!(map.get("theme"), Some(&Value::from("dark")));
    }

    #[test]
    fn batch_mutation_applies_sets_and_deletes_to_one_snapshot() {
        let mut map = Map::from_iter([
            ("group:prod".to_string(), Value::from("Production")),
            ("profile:web".to_string(), Value::from("prod")),
        ]);
        apply_mutations(
            &mut map,
            vec![
                SharedStoreMutation::Set {
                    key: "profile:web".to_string(),
                    value: Value::from("default"),
                },
                SharedStoreMutation::Delete {
                    key: "group:prod".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(map.get("profile:web"), Some(&Value::from("default")));
        assert!(!map.contains_key("group:prod"));
    }

    #[test]
    fn batch_mutation_rejects_every_change_before_applying_any() {
        let mut map = Map::new();
        let result = apply_mutations(
            &mut map,
            vec![
                SharedStoreMutation::Set {
                    key: "valid".to_string(),
                    value: Value::Bool(true),
                },
                SharedStoreMutation::Delete { key: String::new() },
            ],
        );

        assert!(result.is_err());
        assert!(map.is_empty());
    }

    #[test]
    fn workspace_file_open_requests_are_queued_and_drained_by_workspace() {
        let dir = tempfile::tempdir().unwrap();
        for (workspace_id, files) in [
            (
                "primary",
                vec!["C:/one.rs".to_string(), "C:/two.rs".to_string()],
            ),
            ("other", vec!["C:/other.rs".to_string()]),
            ("primary", vec!["C:/three.rs".to_string()]),
        ] {
            request_workspace_file_open_at(dir.path(), "local", workspace_id, &files).unwrap();
        }

        assert_eq!(
            take_workspace_file_open_at(dir.path(), "local", "primary").unwrap(),
            vec!["C:/one.rs", "C:/two.rs", "C:/three.rs"]
        );
        assert_eq!(
            take_workspace_file_open_at(dir.path(), "local", "other").unwrap(),
            vec!["C:/other.rs"]
        );
        assert!(take_workspace_file_open_at(dir.path(), "local", "primary")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn equal_length_writes_have_distinct_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terax-settings.json");
        fs::write(&path, br#"{"a":true}"#).unwrap();
        let before = revision(&path);
        fs::write(&path, br#"{"b":true}"#).unwrap();
        assert_ne!(before, revision(&path));
    }

    #[test]
    fn concurrent_mutation_waits_for_the_file_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_path(dir.path(), "settings").unwrap();
        let lock = FileLock::try_acquire(&path).unwrap().unwrap();
        let root = dir.path().to_path_buf();
        let writer = std::thread::spawn(move || {
            mutate(&root, "settings", |map| {
                map.insert("after".to_string(), Value::Bool(true));
            })
        });
        std::thread::sleep(Duration::from_millis(30));
        drop(lock);
        writer.join().unwrap().unwrap();
        assert_eq!(
            read_map(&dir.path().join("terax-settings.json"))
                .unwrap()
                .get("after"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn subprocess_mutation_helper() {
        let Some(root) = std::env::var_os("TERAX_SHARED_TEST_ROOT") else {
            return;
        };
        let key = std::env::var("TERAX_SHARED_TEST_KEY").unwrap();
        let ready = PathBuf::from(std::env::var_os("TERAX_SHARED_TEST_READY").unwrap());
        let go = PathBuf::from(std::env::var_os("TERAX_SHARED_TEST_GO").unwrap());
        fs::write(&ready, b"ready").unwrap();
        wait_for(&go);
        mutate(Path::new(&root), "settings", |map| {
            map.insert(key, Value::Bool(true));
        })
        .unwrap();
    }

    #[test]
    fn independent_key_mutations_are_safe_across_processes() {
        let dir = tempfile::tempdir().unwrap();
        let go = dir.path().join("go");
        let executable = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for (index, key) in ["from-a", "from-b"].into_iter().enumerate() {
            let ready = dir.path().join(format!("ready-{index}"));
            let child = Command::new(&executable)
                .arg("--exact")
                .arg("modules::shared_store::tests::subprocess_mutation_helper")
                .arg("--nocapture")
                .env("TERAX_SHARED_TEST_ROOT", dir.path())
                .env("TERAX_SHARED_TEST_KEY", key)
                .env("TERAX_SHARED_TEST_READY", &ready)
                .env("TERAX_SHARED_TEST_GO", &go)
                .spawn()
                .unwrap();
            children.push((child, ready));
        }
        for (_, ready) in &children {
            wait_for(ready);
        }
        fs::write(&go, b"go").unwrap();
        for (mut child, _) in children {
            assert!(child.wait().unwrap().success());
        }

        let map = read_map(&dir.path().join("terax-settings.json")).unwrap();
        assert_eq!(map.get("from-a"), Some(&Value::Bool(true)));
        assert_eq!(map.get("from-b"), Some(&Value::Bool(true)));
    }
}
