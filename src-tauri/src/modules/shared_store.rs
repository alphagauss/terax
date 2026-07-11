use crate::modules::storage::{write_atomic, FileLock};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
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

pub struct SharedStoreState {
    _watcher: Mutex<RecommendedWatcher>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedStoreChanged {
    store: String,
    revision: String,
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

fn mutate(
    root: &Path,
    store: &str,
    mutation: impl FnOnce(&mut Map<String, Value>),
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let _lock = FileLock::acquire(&lock_path(root, store)?, Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("shared store {store} is busy"))?;
    let path = store_path(root, store)?;
    let mut map = read_map(&path)?;
    mutation(&mut map);
    let bytes = serde_json::to_vec(&map).map_err(|error| error.to_string())?;
    write_atomic(&path, &bytes).map_err(|error| error.to_string())
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

pub(crate) fn request_workspace_activation(environment: &str) -> Result<(), String> {
    let root = store_dir()?;
    mutate(&root, "settings", |map| {
        map.insert(
            "workspaceActivation".to_string(),
            serde_json::json!({
                "requestId": uuid::Uuid::new_v4().to_string(),
                "environment": environment,
            }),
        );
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
