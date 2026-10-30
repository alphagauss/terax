//! 文件属性命令只传递当前 Workspace 的不可变身份与查询状态。

use crate::modules::{remote::RemoteState, workspace_process::WorkspaceProcessState};
use terax_core::modules::fs::properties as service;
pub use terax_core::modules::fs::properties::{
    DirectorySummary, FilePropertiesSnapshot, FilePropertiesState,
};

#[tauri::command]
pub async fn fs_properties_get(
    remote: tauri::State<'_, RemoteState>,
    process: tauri::State<'_, WorkspaceProcessState>,
    path: String,
) -> Result<FilePropertiesSnapshot, String> {
    let workspace = process.bootstrap();
    service::fs_properties_get(
        &remote,
        workspace.env.clone(),
        workspace.environment_key.clone(),
        path,
    )
    .await
}

#[tauri::command]
pub async fn fs_properties_scan(
    remote: tauri::State<'_, RemoteState>,
    process: tauri::State<'_, WorkspaceProcessState>,
    state: tauri::State<'_, FilePropertiesState>,
    path: String,
    scan_id: String,
) -> Result<DirectorySummary, String> {
    let workspace = process.bootstrap();
    service::fs_properties_scan(
        &remote,
        workspace.env.clone(),
        workspace.environment_key.clone(),
        &state,
        path,
        scan_id,
    )
    .await
}

#[tauri::command]
pub fn fs_properties_scan_cancel(
    state: tauri::State<'_, FilePropertiesState>,
    scan_id: String,
) -> Result<(), String> {
    service::fs_properties_scan_cancel(&state, scan_id)
}
