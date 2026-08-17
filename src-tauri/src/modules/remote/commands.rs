//! SSH 连接、终端与隧道的 Tauri command 适配层。
//!
//! 文件传输命令由 transfers 子系统统一提供，本模块不保留可绕过任务管理器的入口。

use crate::modules::workspace_process::WorkspaceProcessState;
use crate::modules::{secrets, secrets::SecretsState};

use super::manager::RemoteState;
use super::models::{
    ConnectRequest, CredentialOverride, ImportedHost, RemoteRuntimeSnapshot, SshAuthMethod,
    TunnelConfig, TunnelEventKind, TunnelInfo,
};

const SSH_SECRET_SERVICE: &str = "terax-ssh";

#[tauri::command]
/// 建立当前 SSH Workspace 唯一 Runtime，并返回权威快照。
pub async fn ssh_runtime_connect(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    secrets_state: tauri::State<'_, SecretsState>,
    app: tauri::AppHandle,
    profile_id: String,
    credentials: Option<CredentialOverride>,
) -> Result<RemoteRuntimeSnapshot, String> {
    let profile = super::profile::load(&profile_id)?;
    profile.validate()?;
    workspace.assert_ssh_runtime_owner(&profile)?;
    let (secret, proxy_secret) = match credentials {
        Some(credentials) => (
            credentials.secret.filter(|value| !value.is_empty()),
            credentials.proxy_secret.filter(|value| !value.is_empty()),
        ),
        None => {
            let secret = if profile.auth_method == SshAuthMethod::Agent {
                None
            } else {
                secrets::get(&app, &secrets_state, SSH_SECRET_SERVICE, &profile.id)?
                    .filter(|value| !value.is_empty())
            };
            let proxy_secret = if profile
                .proxy_url
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                secrets::get(
                    &app,
                    &secrets_state,
                    SSH_SECRET_SERVICE,
                    &format!("{}:proxy", profile.id),
                )?
                .filter(|value| !value.is_empty())
            } else {
                None
            };
            (secret, proxy_secret)
        }
    };
    let request = ConnectRequest {
        profile,
        secret,
        proxy_secret,
    };
    state.manager.connect(request, app).await
}

#[tauri::command]
/// 取消连接或恢复流程并释放当前 Runtime。
pub async fn ssh_runtime_disconnect(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.manager.disconnect(&app).await
}

#[tauri::command]
/// 返回当前 Runtime 的权威状态快照。
pub async fn ssh_runtime_snapshot(
    state: tauri::State<'_, RemoteState>,
) -> Result<RemoteRuntimeSnapshot, String> {
    Ok(state.manager.snapshot().await)
}

#[tauri::command]
/// 窗口激活时确认当前 transport，必要时立即进入统一重连流程。
pub async fn ssh_runtime_wake(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
) -> Result<RemoteRuntimeSnapshot, String> {
    state.manager.wake(&app).await
}

#[tauri::command]
pub async fn ssh_confirm_host_key(
    state: tauri::State<'_, RemoteState>,
    request_id: String,
    accepted: bool,
    remember: bool,
) -> Result<(), String> {
    state
        .manager
        .host_keys
        .confirm(&request_id, accepted, remember)
        .await
}

#[tauri::command]
pub async fn ssh_import_config() -> Result<Vec<ImportedHost>, String> {
    Ok(super::ssh_config::parse_default())
}

#[tauri::command]
pub async fn ssh_tunnel_start(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    app: tauri::AppHandle,
    config: TunnelConfig,
) -> Result<TunnelInfo, String> {
    workspace.assert_ssh_tunnel_owner(&config.profile_id)?;
    let profile_id = config.profile_id.clone();
    match state.manager.start_tunnel(config).await {
        Ok(tunnel) => {
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Started,
                &profile_id,
                Some(tunnel.clone()),
                None,
            );
            Ok(tunnel)
        }
        Err(error) => {
            let message = error.message;
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Failed,
                &profile_id,
                error.info,
                Some(message.clone()),
            );
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    app: tauri::AppHandle,
    id: u64,
) -> Result<(), String> {
    let Some(existing) = state.manager.tunnel_info(id).await else {
        return Ok(());
    };
    workspace.assert_ssh_tunnel_owner(&existing.profile_id)?;
    match state.manager.stop_tunnel(id).await {
        Ok(Some(tunnel)) => {
            let profile_id = tunnel.profile_id.clone();
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Stopped,
                &profile_id,
                Some(tunnel),
                None,
            );
        }
        Ok(None) => {}
        Err(error) => {
            let message = error.message;
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Failed,
                &existing.profile_id,
                error.info,
                Some(message.clone()),
            );
            return Err(message);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_tunnel_update(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    app: tauri::AppHandle,
    id: u64,
    config: TunnelConfig,
) -> Result<TunnelInfo, String> {
    let Some(existing) = state.manager.tunnel_info(id).await else {
        return Err(format!("SSH tunnel {id} was not found"));
    };
    workspace.assert_ssh_tunnel_owner(&existing.profile_id)?;
    if config.profile_id != existing.profile_id {
        return Err("SSH tunnel profile cannot be changed".into());
    }
    match state.manager.update_tunnel(id, config).await {
        Ok(tunnel) => {
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Updated,
                &tunnel.profile_id,
                Some(tunnel.clone()),
                None,
            );
            Ok(tunnel)
        }
        Err(error) => {
            let message = error.message;
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Failed,
                &existing.profile_id,
                error.info,
                Some(message.clone()),
            );
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn ssh_tunnel_list(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    profile_id: String,
) -> Result<Vec<TunnelInfo>, String> {
    workspace.assert_ssh_tunnel_owner(&profile_id)?;
    Ok(state.manager.list_tunnels(&profile_id).await)
}
