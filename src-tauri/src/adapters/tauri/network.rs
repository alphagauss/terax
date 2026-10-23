//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::network_proxy as service;

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn network_validate_proxy(url: String) -> Result<String, String> {
    service::network_validate_proxy(url)
}

/// 只返回系统代理快照的修订号。
#[tauri::command]
pub async fn network_system_proxy_revision() -> Result<String, String> {
    service::network_system_proxy_revision().await
}
