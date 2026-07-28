//! Alpha 服务的 Tauri 命令。
//!
//! 命令仅负责参数转发和结果序列化，单例协调与真实状态判断统一位于 `service`。

use super::proxy::{
    self, AlphaHttpRequest, AlphaHttpResponse, AlphaProxyState, AlphaQueryParam,
    AlphaWebSocketEvent,
};
use super::service::{self, AlphaStatus, PythonCheck};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// 返回 Alpha 服务的实时状态。
#[tauri::command]
pub async fn alpha_status() -> Result<AlphaStatus, String> {
    service::status().await
}

/// 保存 Python 解释器路径，不执行版本或依赖检查。
#[tauri::command]
pub fn alpha_set_python_path(app: AppHandle, path: String) -> Result<(), String> {
    service::set_python_path(app, path)
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

/// 通过固定本机目标转发通用 Alpha GET 或 POST JSON 请求。
#[tauri::command]
pub async fn alpha_http_request(request: AlphaHttpRequest) -> Result<AlphaHttpResponse, String> {
    proxy::http_request(request).await
}

/// 建立一个受管的双向 Alpha JSON WebSocket。
#[tauri::command]
pub async fn alpha_ws_open(
    state: State<'_, AlphaProxyState>,
    path: String,
    query: Vec<AlphaQueryParam>,
    on_event: Channel<AlphaWebSocketEvent>,
) -> Result<u32, String> {
    proxy::websocket_open(&state, path, query, on_event).await
}

/// 向指定 Alpha WebSocket 发送 JSON 消息。
#[tauri::command]
pub fn alpha_ws_send(
    state: State<'_, AlphaProxyState>,
    id: u32,
    message: Value,
) -> Result<(), String> {
    proxy::websocket_send(&state, id, message)
}

/// 幂等关闭指定 Alpha WebSocket。
#[tauri::command]
pub fn alpha_ws_close(state: State<'_, AlphaProxyState>, id: u32) {
    proxy::websocket_close(&state, id);
}
