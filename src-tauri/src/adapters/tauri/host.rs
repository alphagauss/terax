//! 将桌面事件、原始数据通道和秘密存储接入原生核心。

use tauri::{Emitter, Manager};
use terax_core::events::{EventSink, OutputSink};
use terax_core::modules::{remote::RemoteHost, secrets::SecretsState};

pub fn events(app: &tauri::AppHandle) -> EventSink {
    let app = app.clone();
    EventSink::new(move |event, payload| {
        app.emit(event, payload).map_err(|error| error.to_string())
    })
}

pub fn remote(app: &tauri::AppHandle) -> RemoteHost {
    RemoteHost {
        events: events(app),
        secrets: app.state::<SecretsState>().inner().clone(),
    }
}

pub fn bytes(channel: tauri::ipc::Channel<tauri::ipc::Response>) -> OutputSink<Vec<u8>> {
    OutputSink::new(move |bytes| {
        channel
            .send(tauri::ipc::Response::new(bytes))
            .map_err(|error| error.to_string())
    })
}

pub fn output<T: serde::Serialize + Send + Sync + 'static>(
    channel: tauri::ipc::Channel<T>,
) -> OutputSink<T> {
    OutputSink::new(move |value| channel.send(value).map_err(|error| error.to_string()))
}

struct DesktopTransferSettings(tauri::AppHandle);

impl terax_transfers::TransferSettings for DesktopTransferSettings {
    fn get(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        use crate::modules::workspace_process::WorkspaceProcessState;
        use tauri_plugin_store::StoreExt;
        let workspace = self.0.state::<WorkspaceProcessState>();
        let store = self
            .0
            .store(&workspace.bootstrap().state_path)
            .map_err(|error| error.to_string())?;
        Ok(store.get(key))
    }

    fn set(&self, key: &str, value: serde_json::Value) -> Result<(), String> {
        use crate::modules::workspace_process::WorkspaceProcessState;
        use tauri_plugin_store::StoreExt;
        let workspace = self.0.state::<WorkspaceProcessState>();
        let store = self
            .0
            .store(&workspace.bootstrap().state_path)
            .map_err(|error| error.to_string())?;
        let previous = store.get(key);
        store.set(key, value);
        if let Err(error) = store.save() {
            match previous {
                Some(value) => store.set(key, value),
                None => {
                    store.delete(key);
                }
            }
            return Err(error.to_string());
        }
        Ok(())
    }
}

/// 使用与 WebView 相同的 Store 实例，失败时恢复之前的内存值。
pub fn transfer(app: &tauri::AppHandle) -> terax_transfers::TransferHost {
    terax_transfers::TransferHost {
        events: events(app),
        settings: std::sync::Arc::new(DesktopTransferSettings(app.clone())),
    }
}
