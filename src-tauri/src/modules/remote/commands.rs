use std::path::PathBuf;

use crate::modules::workspace_process::WorkspaceProcessState;

use super::manager::RemoteState;
use super::models::{
    ConnectRequest, ConnectionInfo, ImportedHost, TunnelConfig, TunnelEventKind, TunnelInfo,
};

#[tauri::command]
pub async fn ssh_connect(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
    request: ConnectRequest,
) -> Result<ConnectionInfo, String> {
    state.manager.connect(request, app).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<(), String> {
    state.manager.disconnect(&profile_id, &app).await
}

#[tauri::command]
pub async fn ssh_reconnect(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<ConnectionInfo, String> {
    state.manager.reconnect(&profile_id, app).await
}

#[tauri::command]
pub async fn ssh_connection_status(
    state: tauri::State<'_, RemoteState>,
    profile_id: String,
) -> Result<ConnectionInfo, String> {
    Ok(state.manager.status(&profile_id).await)
}

#[tauri::command]
pub async fn ssh_home(
    state: tauri::State<'_, RemoteState>,
    profile_id: String,
) -> Result<String, String> {
    state.manager.home(&profile_id).await
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

#[tauri::command]
pub async fn ssh_upload(
    state: tauri::State<'_, RemoteState>,
    profile_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<(), String> {
    let workspace = state.manager.workspace(&profile_id).await?;
    super::sftp::upload_path(&workspace, PathBuf::from(local_path).as_path(), &remote_dir).await
}

#[tauri::command]
pub async fn ssh_download(
    state: tauri::State<'_, RemoteState>,
    profile_id: String,
    remote_path: String,
    local_dir: String,
) -> Result<String, String> {
    let workspace = state.manager.workspace(&profile_id).await?;
    super::sftp::download_path(&workspace, &remote_path, PathBuf::from(local_dir).as_path())
        .await
        .map(|path| path.to_string_lossy().into_owned())
}
