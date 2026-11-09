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
    app_subdir: Option<String>,
) -> Result<String, String> {
    if let Some(relative) = app_subdir {
        if !matches!(process.bootstrap().env, WorkspaceEnv::Local) {
            return Err("application data workspaces require Local".into());
        }
        return service::workspace_prepare_app_root(&relative, registry.inner());
    }
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

/// 检测当前进程启动时绑定的 WSL 发行版。
#[tauri::command]
pub async fn wsl_capabilities_probe(
    process: tauri::State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
) -> Result<terax_core::modules::workspace_capabilities::CapabilityReport, String> {
    let WorkspaceEnv::Wsl { distro } = &process.bootstrap().env else {
        return Err("capability probe requires a WSL Workspace".into());
    };
    #[cfg(windows)]
    return terax_core::modules::workspace_capabilities::probe_wsl(distro).await;
    #[cfg(not(windows))]
    {
        let _ = distro;
        Err("WSL is only available on Windows".into())
    }
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn wsl_home(distro: String) -> Result<String, String> {
    service::wsl_home(distro)
}
