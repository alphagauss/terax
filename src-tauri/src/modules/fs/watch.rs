//! 桌面文件监听命令适配。

use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
use terax_core::modules::fs::watch as service;
pub use terax_core::modules::fs::watch::FsWatchState;

#[tauri::command]
pub fn fs_watch_add(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: tauri::AppHandle,
    state: tauri::State<'_, FsWatchState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    service::fs_watch_add(
        paths,
        workspace,
        crate::adapters::tauri::host::events(&app),
        &state,
        &registry,
    )
}

#[tauri::command]
pub fn fs_watch_remove(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    state: tauri::State<'_, FsWatchState>,
) -> Result<(), String> {
    service::fs_watch_remove(paths, workspace, &state)
}
