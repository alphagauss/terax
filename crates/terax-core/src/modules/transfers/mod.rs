//! 当前 Workspace 的后台文件传输子系统。
//!
//! 本模块统一协调 Host、WSL 与 SSH 之间的 Direct 和 Archive 传输。任务由 Rust
//! 持有，WebView 仅负责选择策略、入队和展示，因此关闭传输面板不会中断文件复制。

mod archive;
mod cleanup_ticket;
mod commit;
mod conflicts;
mod diagnostics;
mod direct;
mod errors;
mod journal;
mod local;
mod manager;
mod metadata;
pub mod models;
mod planner;
mod progress;
mod resume;
mod scheduler;
mod source;
mod ssh;
mod sync;
mod sync_settings;
mod wsl;

pub use journal::remove_workspace_files;
pub use manager::TransferState;

pub use errors::TransferFailure;
pub use manager::TransferManager;
pub use sync::{preview, SyncPreview};
pub use sync_settings::FolderSyncSettings;

/// 宿主提供当前 Workspace 的设置读写，保存失败必须恢复原值。
pub trait TransferSettings: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<serde_json::Value>, String>;
    fn set(&self, key: &str, value: serde_json::Value) -> Result<(), String>;
}

/// 传输任务使用的宿主出口，不持有窗口或 UI 生命周期。
#[derive(Clone)]
pub struct TransferHost {
    pub events: crate::events::EventSink,
    pub settings: std::sync::Arc<dyn TransferSettings>,
}
