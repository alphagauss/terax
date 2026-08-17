//! SSH Runtime、远端文件系统、终端和隧道的原生实现。
//!
//! 当前 Workspace 进程独占一条 transport；profile、凭据和连接状态均由 Rust 管理，
//! WebView 只提交稳定 profile ID 或一次性凭据覆盖值。

pub mod commands;
mod host_key;
pub mod manager;
pub mod models;
pub(crate) mod profile;
mod proxy;
mod remote_fs;
pub mod session;
pub mod sftp;
mod ssh_config;
pub mod terminal;
pub mod tunnel;

pub use manager::RemoteState;
