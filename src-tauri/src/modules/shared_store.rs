//! 跨 Terax 进程共享的白名单配置存储。
//!
//! 所有变更都在文件锁内读取最新值并原子替换文件。批量接口仅修改明确列出的键，
//! 用于保持跨键业务不变量，不允许调用方整表覆盖。配置目录与 UUID 状态记录均由原生白名单决定。
//! Custom Agent 的新会话提交和
//! 级联删除共享配置锁，通用删除接口不能绕过会话清理。

use crate::modules::storage::write_atomic;
use crate::modules::storage::FileLock;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 配置白名单及其固定文件名，桌面监听器复用同一份定义。
pub(crate) const STORES: &[(&str, &str)] = &[
    ("channels", "config.json"),
    ("settings", "terax-settings.json"),
    ("alpha", "terax-alpha.json"),
    ("ssh-profiles", "terax-ssh-profiles.json"),
    ("custom-themes", "terax-custom-themes.json"),
    ("ai-agents", "terax-ai-agents.json"),
    ("ai-snippets", "terax-ai-snippets.json"),
    ("ui-layout", "terax-ui-layout.json"),
    ("keys-epoch", "terax-keys-epoch.json"),
];
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
/// 一次共享存储批量提交中的精确键变更。
pub enum SharedStoreMutation {
    Set { key: String, value: Value },
    Delete { key: String },
}

/// 动态记录仅允许规范 UUID，调用者不能提供目录或文件路径。
pub(crate) fn state_id(store: &str) -> Result<Option<uuid::Uuid>, String> {
    let Some(value) = store.strip_prefix("channels-state:") else {
        return Ok(None);
    };
    let id = uuid::Uuid::parse_str(value).map_err(|_| "invalid state store ID".to_string())?;
    if id.to_string() != value {
        return Err("state store ID must be canonical".into());
    }
    Ok(Some(id))
}

fn filename(store: &str) -> Result<String, String> {
    if let Some(id) = state_id(store)? {
        return Ok(format!("{id}.json"));
    }
    STORES
        .iter()
        .find_map(|(name, file)| (*name == store).then(|| file.to_string()))
        .ok_or_else(|| format!("shared store is not allowed: {store}"))
}

/// 所有目录由原生白名单决定，配置与状态复用同一套锁和原子提交。
pub(crate) fn store_dir(store: &str) -> Result<PathBuf, String> {
    use crate::modules::app_data::{directory, Directory};
    filename(store)?;
    if state_id(store)?.is_some() {
        Ok(directory(Directory::Channels)?.join("state"))
    } else if store == "channels" {
        directory(Directory::Channels)
    } else {
        directory(Directory::Shared)
    }
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

/// 从白名单共享存储读取并反序列化一个键。
///
/// 文件由原子替换保证完整性；缺失键返回 `None`，格式错误不会回退到旧值。
pub(crate) fn read_value<T: DeserializeOwned>(store: &str, key: &str) -> Result<Option<T>, String> {
    let path = store_path(&store_dir(store)?, store)?;
    read_map(&path)?
        .remove(key)
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("shared store {store} key {key} is invalid: {error}"))
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

/// 在 Custom Agent 配置锁内校验定义存在并执行会话操作。
///
/// 新会话首次提交和 Agent 级联删除共享同一把锁，避免删除期间产生孤儿会话。
pub(crate) fn with_ai_agent<T>(
    agent_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let root = store_dir("ai-agents")?;
    with_ai_agent_at(&root, agent_id, operation)
}

fn with_ai_agent_at<T>(
    root: &Path,
    agent_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let _lock = FileLock::acquire(&lock_path(root, "ai-agents")?, Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "shared store ai-agents is busy".to_string())?;
    let map = read_map(&store_path(root, "ai-agents")?)?;
    if !map.contains_key(&format!("agent:{agent_id}")) {
        return Err("CUSTOM_AGENT_NOT_FOUND".to_string());
    }
    operation()
}

/// 在 Custom Agent 配置锁内完成关联资源删除，再移除对应定义。
///
/// 关联操作失败时定义保持不变；成功后发出共享存储变更事件。
pub(crate) fn delete_ai_agent_with<T>(
    events: &dyn StoreEvents,
    agent_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let root = store_dir("ai-agents")?;
    let result = delete_ai_agent_at(&root, agent_id, operation)?;
    events.changed("ai-agents")?;
    Ok(result)
}

fn delete_ai_agent_at<T>(
    root: &Path,
    agent_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if agent_id.is_empty() || agent_id.starts_with("builtin:") {
        return Err("CUSTOM_AGENT_ID_INVALID".to_string());
    }
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let _lock = FileLock::acquire(&lock_path(root, "ai-agents")?, Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "shared store ai-agents is busy".to_string())?;
    let path = store_path(root, "ai-agents")?;
    let mut map = read_map(&path)?;
    let key = format!("agent:{agent_id}");
    if !map.contains_key(&key) {
        return Err("CUSTOM_AGENT_NOT_FOUND".to_string());
    }
    let result = operation()?;
    map.remove(&key);
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

/// 禁止通用共享存储接口绕过 Custom Agent 的会话级联删除。
fn validate_record_delete(store: &str, key: &str) -> Result<(), String> {
    if store == "ai-agents" && key.starts_with("agent:") {
        return Err("CUSTOM_AGENT_DELETE_REQUIRES_CASCADE".to_string());
    }
    Ok(())
}

/// 更新凭据修订并通知宿主重新读取，普通配置中不保存秘密。
pub fn bump_keys_epoch(events: &dyn StoreEvents) -> Result<(), String> {
    let root = store_dir("keys-epoch")?;
    mutate(&root, "keys-epoch", |map| {
        map.insert(
            "epoch".to_string(),
            Value::from(uuid::Uuid::new_v4().to_string()),
        );
    })?;
    events.changed("keys-epoch")
}

fn revision(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return "missing".to_string();
    };
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}:{}", hasher.finish(), bytes.len())
}

/// 读取白名单配置或状态记录，不接受任意磁盘路径。
pub fn shared_store_read(store: String) -> Result<Map<String, Value>, String> {
    read_map(&store_path(&store_dir(&store)?, &store)?)
}

/// 在所有单键与批量写入入口校验网络配置，不能把代理密码写入普通存储。
fn validate_record_set(store: &str, key: &str, value: &Value) -> Result<(), String> {
    if store == "settings" && key.starts_with("network.") {
        crate::modules::network_proxy::validate_setting(&key["network.".len()..], value)?;
    } else if store == "ssh-profiles" && key.starts_with("profile:") {
        #[cfg(not(feature = "desktop"))]
        return Err("SSH profile configuration requires the desktop host".into());
        #[cfg(feature = "desktop")]
        {
            let profile: crate::modules::remote::models::SshProfile =
                serde_json::from_value(value.clone()).map_err(|_| "invalid SSH profile")?;
            if let Some(url) = &profile.proxy_url {
                if !url.is_empty() {
                    crate::modules::network_proxy::ProxyConfig::parse(url, None)?;
                }
            }
            profile.validate()?;
        }
    }
    Ok(())
}

/// 加锁更新一个配置键，保留其他进程已经提交的数据。
pub fn shared_store_set(
    events: impl StoreEvents,
    store: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("shared store key cannot be empty".to_string());
    }
    validate_record_set(&store, &key, &value)?;
    let root = store_dir(&store)?;
    mutate(&root, &store, |map| {
        map.insert(key, value);
    })?;
    events.changed(&store)
}

/// 删除一个配置键，并保留业务所有者要求的级联边界。
pub fn shared_store_delete(
    events: impl StoreEvents,
    store: String,
    key: String,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("shared store key cannot be empty".to_string());
    }
    validate_record_delete(&store, &key)?;
    let root = store_dir(&store)?;
    mutate(&root, &store, |map| {
        map.remove(&key);
    })?;
    events.changed(&store)
}

/// 在状态记录的既有锁内删除正文；拒绝普通配置表和非规范 UUID。
///
/// 保留锁文件，避免已等待旧锁的调用与新调用锁定不同文件而并发写入。
fn delete_state_at(root: &Path, store: &str) -> Result<(), String> {
    if state_id(store)?.is_none() {
        return Err("only scoped state stores can be deleted".into());
    }
    if !root.exists() {
        return Ok(());
    }
    let _lock = FileLock::acquire(&lock_path(root, store)?, Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("shared store {store} is busy"))?;
    match fs::remove_file(store_path(root, store)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// 删除白名单中的单个协议状态文件，不允许调用方指定路径或删除普通配置。
pub fn shared_store_delete_state(store: String) -> Result<(), String> {
    delete_state_at(&store_dir(&store)?, &store)
}

/// 在一次锁内应用明确列出的键变更，不执行整表覆盖。
pub fn shared_store_mutate(
    events: impl StoreEvents,
    store: String,
    mutations: Vec<SharedStoreMutation>,
) -> Result<(), String> {
    if mutations.is_empty() {
        return Ok(());
    }
    for mutation in &mutations {
        if let SharedStoreMutation::Set { key, value } = mutation {
            validate_record_set(&store, key, value)?;
        }
        if let SharedStoreMutation::Delete { key } = mutation {
            validate_record_delete(&store, key)?;
        }
    }
    let root = store_dir(&store)?;
    mutate(&root, &store, |map| apply_mutations(map, mutations))??;
    events.changed(&store)
}

/// 返回配置修订指纹，供跨窗口事件合并后检查最新值。
pub fn shared_store_revision(store: String) -> Result<String, String> {
    Ok(revision(&store_path(&store_dir(&store)?, &store)?))
}

/// 已提交配置的通知出口；持久化和验证不依赖窗口。
pub trait StoreEvents {
    /// 通知订阅者重新读取对应配置，协议状态不参与广播。
    fn changed(&self, store: &str) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn general_settings_keep_the_network_validation_boundary() {
        assert!(validate_record_set("settings", "theme", &Value::from("dark")).is_ok());
        assert!(validate_record_set(
            "settings",
            "network.proxyUrl",
            &Value::from("http://127.0.0.1:8080")
        )
        .is_ok());
        assert!(validate_record_set(
            "settings",
            "network.proxyUrl",
            &Value::from("http://user:secret@127.0.0.1:8080")
        )
        .is_err());
        assert!(validate_record_set(
            "settings",
            "network.provider:builtin:openai",
            &Value::from("system")
        )
        .is_err());
    }

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
    fn scoped_state_stores_are_isolated_and_reject_paths() {
        let dir = tempfile::tempdir().unwrap();
        let a = format!("channels-state:{}", uuid::Uuid::new_v4());
        let b = format!("channels-state:{}", uuid::Uuid::new_v4());
        mutate(dir.path(), &a, |map| {
            map.insert("cursor".into(), Value::from("a"));
        })
        .unwrap();
        mutate(dir.path(), &b, |map| {
            map.insert("cursor".into(), Value::from("b"));
        })
        .unwrap();
        assert_eq!(
            read_map(&store_path(dir.path(), &a).unwrap()).unwrap()["cursor"],
            "a"
        );
        assert_eq!(
            read_map(&store_path(dir.path(), &b).unwrap()).unwrap()["cursor"],
            "b"
        );
        assert!(store_path(dir.path(), "channels-state:../../outside").is_err());
        assert!(store_path(dir.path(), &a.to_uppercase()).is_err());
    }

    #[test]
    fn state_deletion_waits_for_writers_and_preserves_other_stores() {
        let dir = tempfile::tempdir().unwrap();
        let state = format!("channels-state:{}", uuid::Uuid::new_v4());
        let other = format!("channels-state:{}", uuid::Uuid::new_v4());
        mutate(dir.path(), &state, |map| {
            map.insert("checkpoint".into(), Value::Bool(true));
        })
        .unwrap();
        mutate(dir.path(), &other, |map| {
            map.insert("checkpoint".into(), Value::Bool(true));
        })
        .unwrap();
        let path = store_path(dir.path(), &state).unwrap();
        let lock = FileLock::try_acquire(&lock_path(dir.path(), &state).unwrap())
            .unwrap()
            .unwrap();
        let root = dir.path().to_path_buf();
        let deleting_state = state.clone();
        let deleting = std::thread::spawn(move || delete_state_at(&root, &deleting_state));
        std::thread::sleep(Duration::from_millis(30));
        assert!(path.exists());
        drop(lock);
        deleting.join().unwrap().unwrap();
        assert!(!path.exists());
        assert!(store_path(dir.path(), &other).unwrap().exists());
        // 缺失文件和损坏正文都可清理，失败重试不依赖状态内容能否解析。
        delete_state_at(dir.path(), &state).unwrap();
        fs::write(&path, b"invalid json").unwrap();
        delete_state_at(dir.path(), &state).unwrap();
        assert!(!path.exists());
        for forbidden in ["settings", "channels", "channels-state:../../outside"] {
            assert!(delete_state_at(dir.path(), forbidden).is_err());
        }
    }

    #[test]
    fn rejects_unknown_store_and_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        assert!(store_path(dir.path(), "../../outside").is_err());
        assert_eq!(
            store_path(dir.path(), "alpha").unwrap(),
            dir.path().join("terax-alpha.json")
        );
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
    fn custom_agent_lock_validates_definition_and_deletes_it_last() {
        let dir = tempfile::tempdir().unwrap();
        mutate(dir.path(), "ai-agents", |map| {
            map.insert("agent:a-review".to_string(), Value::Bool(true));
        })
        .unwrap();

        assert_eq!(
            with_ai_agent_at(dir.path(), "a-review", || Ok("ready")).unwrap(),
            "ready"
        );
        assert_eq!(
            delete_ai_agent_at(dir.path(), "a-review", || {
                Err::<(), _>("session delete failed".to_string())
            })
            .unwrap_err(),
            "session delete failed"
        );
        assert!(read_map(&store_path(dir.path(), "ai-agents").unwrap())
            .unwrap()
            .contains_key("agent:a-review"));

        delete_ai_agent_at(dir.path(), "a-review", || Ok(())).unwrap();
        assert!(!read_map(&store_path(dir.path(), "ai-agents").unwrap())
            .unwrap()
            .contains_key("agent:a-review"));
        assert!(with_ai_agent_at(dir.path(), "a-review", || Ok(())).is_err());
        assert_eq!(
            validate_record_delete("ai-agents", "agent:a-review").unwrap_err(),
            "CUSTOM_AGENT_DELETE_REQUIRES_CASCADE"
        );
        assert!(validate_record_delete("ai-snippets", "snippet:review").is_ok());
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
