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
mod traffic;
pub mod tunnel;

pub use manager::RemoteState;

use tauri::Manager;

/// 在 SSH Workspace 的 Tauri setup 阶段立即启动自动连接。
pub(crate) fn start_workspace_connection(app: tauri::AppHandle) {
    let profile_id = match &app
        .state::<crate::modules::workspace_process::WorkspaceProcessState>()
        .bootstrap()
        .env
    {
        crate::modules::workspace::WorkspaceEnv::Ssh { profile_id } => profile_id.clone(),
        _ => return,
    };
    tauri::async_runtime::spawn(async move {
        let remote = app.state::<RemoteState>();
        let workspace = app.state::<crate::modules::workspace_process::WorkspaceProcessState>();
        let secrets = app.state::<crate::modules::secrets::SecretsState>();
        let _ = commands::connect_startup_profile(
            &remote,
            &workspace,
            &secrets,
            app.clone(),
            profile_id,
        )
        .await;
    });
}
