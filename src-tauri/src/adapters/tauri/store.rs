//! 桌面共享配置命令与低频变更通知。
//!
//! 文件锁、校验和原子写入归共享服务，窗口广播与 watcher 只在桌面启动。

use crate::modules::shared_store::{self as service, SharedStoreMutation, StoreEvents};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{Map, Value};
use service::{state_id, store_dir, STORES};
use std::{fs, sync::Mutex};
use tauri::{AppHandle, Emitter};

/// 桌面进程持有的配置监听器，随宿主退出释放。
pub struct SharedStoreState {
    _watcher: Mutex<RecommendedWatcher>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedStoreChanged {
    store: String,
    revision: String,
}

/// 广播配置修订，不广播仅用于恢复协议的状态记录。
fn emit_changed(app: &AppHandle, store: &str) -> Result<(), String> {
    if state_id(store)?.is_some() {
        return Ok(());
    }
    app.emit(
        "terax://shared-store-changed",
        SharedStoreChanged {
            store: store.to_string(),
            revision: service::shared_store_revision(store.to_string())?,
        },
    )
    .map_err(|error| error.to_string())
}

impl SharedStoreState {
    /// 复用一个 watcher 观察两个低频配置目录；协议状态不参与跨窗口广播。
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let roots = [store_dir("settings")?, store_dir("channels")?];
        for root in &roots {
            fs::create_dir_all(root).map_err(|error| error.to_string())?;
        }
        let handle = app.clone();
        let watched = roots.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else {
                    return;
                };
                for path in event.paths {
                    let Some(file) = path.file_name().and_then(|value| value.to_str()) else {
                        continue;
                    };
                    if let Some((store, _)) = STORES.iter().find(|(store, candidate)| {
                        *candidate == file
                            && path.parent()
                                == Some(
                                    if *store == "channels" {
                                        &watched[1]
                                    } else {
                                        &watched[0]
                                    }
                                    .as_path(),
                                )
                    }) {
                        let _ = emit_changed(&handle, store);
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        for root in &roots {
            watcher
                .watch(root, RecursiveMode::NonRecursive)
                .map_err(|error| error.to_string())?;
        }
        Ok(Self {
            _watcher: Mutex::new(watcher),
        })
    }
}

impl StoreEvents for AppHandle {
    fn changed(&self, store: &str) -> Result<(), String> {
        emit_changed(self, store)
    }
}

/// 将桌面请求交给共享配置服务。
#[tauri::command]
pub fn shared_store_read(store: String) -> Result<Map<String, Value>, String> {
    service::shared_store_read(store)
}

/// 将桌面请求交给共享配置服务。
#[tauri::command]
pub fn shared_store_set(
    app: AppHandle,
    store: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    service::shared_store_set(app, store, key, value)
}

/// 将桌面请求交给共享配置服务。
#[tauri::command]
pub fn shared_store_delete(app: AppHandle, store: String, key: String) -> Result<(), String> {
    service::shared_store_delete(app, store, key)
}

/// 将桌面请求交给共享配置服务。
#[tauri::command]
pub fn shared_store_delete_state(store: String) -> Result<(), String> {
    service::shared_store_delete_state(store)
}

/// 将桌面请求交给共享配置服务。
#[tauri::command]
pub fn shared_store_mutate(
    app: AppHandle,
    store: String,
    mutations: Vec<SharedStoreMutation>,
) -> Result<(), String> {
    service::shared_store_mutate(app, store, mutations)
}

/// 将桌面请求交给共享配置服务。
#[tauri::command]
pub fn shared_store_revision(store: String) -> Result<String, String> {
    service::shared_store_revision(store)
}
