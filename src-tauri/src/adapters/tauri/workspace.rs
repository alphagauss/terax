//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::workspace::{self as service, *};

/// 将桌面上下文交给共享服务。
#[tauri::command]
pub async fn workspace_authorize(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    service::workspace_authorize(path, workspace, registry.inner()).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn workspace_prepare_default_root(
    process: tauri::State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    service::workspace_prepare_default_root(&process.bootstrap().env, registry.inner()).await
}

/// 将桌面上下文交给共享服务。
#[tauri::command]
pub async fn workspace_current_dir(
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    service::workspace_current_dir(registry.inner()).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn wsl_list_distros() -> Result<Vec<WslDistro>, String> {
    service::wsl_list_distros().await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn wsl_default_distro() -> Result<Option<String>, String> {
    service::wsl_default_distro().await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn wsl_home(distro: String) -> Result<String, String> {
    service::wsl_home(distro)
}
