//! 当前 Workspace 的后台文件传输子系统。
//!
//! 本模块统一协调 Host、WSL 与 SSH 之间的 Direct 和 Archive 传输。任务由 Rust
//! 持有，WebView 仅负责选择策略、入队和展示，因此关闭传输面板不会中断文件复制。

mod archive;
pub mod commands;
mod commit;
mod direct;
mod errors;
mod local;
mod manager;
mod metadata;
pub mod models;
mod planner;
mod progress;
mod scheduler;
mod source;
mod ssh;
mod wsl;

pub use manager::TransferState;
