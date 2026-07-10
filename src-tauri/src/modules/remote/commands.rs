use std::path::PathBuf;

use super::manager::RemoteState;
use super::models::{ConnectRequest, ConnectionInfo, ImportedHost, TunnelConfig, TunnelInfo};

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
    config: TunnelConfig,
) -> Result<TunnelInfo, String> {
    state.manager.start_tunnel(config).await
}

#[tauri::command]
pub async fn ssh_tunnel_stop(state: tauri::State<'_, RemoteState>, id: u64) -> Result<(), String> {
    state.manager.stop_tunnel(id).await
}

#[tauri::command]
pub async fn ssh_tunnel_list(
    state: tauri::State<'_, RemoteState>,
    profile_id: Option<String>,
) -> Result<Vec<TunnelInfo>, String> {
    Ok(state.manager.tunnels.list(profile_id.as_deref()).await)
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
