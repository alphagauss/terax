//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::net::{self as service, *};
use crate::modules::network_proxy::NetworkTarget;
use std::collections::HashMap;
use tauri::{ipc::Channel, Manager};

/// 执行通用、有界且可取消的 HTTP 请求；AI 流与长轮询共用同一安全边界。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn http_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpState>,
    request_id: String,
    url: String,
    method: String,
    redirect: Option<HttpRedirectMode>,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
    network_target: NetworkTarget,
    timeout_ms: Option<u64>,
    max_response_bytes: usize,
    on_event: Channel<HttpEvent>,
) -> Result<(), String> {
    service::http_request(
        &app.state::<crate::modules::secrets::SecretsState>(),
        window.label(),
        state.inner(),
        request_id,
        url,
        method,
        redirect,
        headers,
        body,
        allow_private_network,
        network_target,
        timeout_ms,
        max_response_bytes,
        on_event,
    )
    .await
}

/// 取消当前 WebView 发起的指定 HTTP 请求。
#[tauri::command]
pub fn http_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpState>,
    request_id: String,
) {
    state.cancel(window.label(), &request_id);
}

impl HttpEventSink for Channel<HttpEvent> {
    fn send(&self, event: HttpEvent) -> Result<(), String> {
        Channel::send(self, event).map_err(|error| error.to_string())
    }
}
