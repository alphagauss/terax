//! Alpha 服务的 Tauri 命令。
//!
//! 命令仅负责参数转发和结果序列化，单例协调与真实状态判断统一位于 `service`。

use super::service::{self, AlphaStatus, PythonCheck};
use tauri::AppHandle;

/// 返回 Alpha 服务的实时状态。
#[tauri::command]
pub async fn alpha_status() -> Result<AlphaStatus, String> {
    service::status().await
}

/// 保存 Python 解释器路径并返回依赖检查结果。
#[tauri::command]
pub async fn alpha_set_python_path(app: AppHandle, path: String) -> Result<PythonCheck, String> {
    service::set_python_path(app, path).await
}

/// 检查当前或显式指定的 Python 解释器。
#[tauri::command]
pub async fn alpha_check_python(path: Option<String>) -> Result<PythonCheck, String> {
    service::check_configured_python(path).await
}

/// 更新 Alpha 自动启动设置。
#[tauri::command]
pub fn alpha_set_auto_start(app: AppHandle, enabled: bool) -> Result<(), String> {
    service::set_auto_start(app, enabled)
}

/// 幂等启动共享 Alpha 服务。
#[tauri::command]
pub async fn alpha_start() -> Result<AlphaStatus, String> {
    service::start().await
}

/// 幂等停止共享 Alpha 服务。
#[tauri::command]
pub async fn alpha_stop() -> Result<AlphaStatus, String> {
    service::stop().await
}

/// 重启共享 Alpha 服务。
#[tauri::command]
pub async fn alpha_restart() -> Result<AlphaStatus, String> {
    service::restart().await
}
