//! 桌面 SSH 命令与启动接入；运行时由原生核心持有。

pub use terax_core::modules::remote::*;
pub mod commands;

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
