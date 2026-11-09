//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::fs::mutate::{self as service, *};
use crate::modules::fs::paste::{self, PasteError, PasteMode};
use crate::modules::workspace::WorkspaceEnv;

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_create_file(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    service::fs_create_file(path, workspace).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_create_dir(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    service::fs_create_dir(path, workspace).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_rename(
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    service::fs_rename(from, to, workspace).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_delete(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    service::fs_delete(path, workspace).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_trash(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<TrashResult, String> {
    service::fs_trash(path, workspace).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_copy(
    sources: Vec<String>,
    dest_dir: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    service::fs_copy(sources, dest_dir, workspace).await
}

/// 执行同一 Workspace 内的文件树粘贴。
#[tauri::command]
pub async fn fs_paste(
    source: String,
    destination: String,
    mode: PasteMode,
    workspace: WorkspaceEnv,
) -> Result<String, PasteError> {
    paste::paste(source, destination, mode, workspace).await
}
