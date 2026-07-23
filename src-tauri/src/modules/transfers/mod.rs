//! 当前 Workspace 的后台文件传输子系统。
//!
//! 本模块统一协调 Host、WSL 与 SSH 之间的 Direct 传输。任务由 Rust 持有，
//! WebView 仅负责入队和展示，因此关闭传输面板不会中断文件复制。

pub mod commands;
mod commit;
mod direct;
mod local;
mod manager;
pub mod models;
mod planner;
mod progress;
mod scheduler;
mod ssh;

pub use manager::TransferState;
