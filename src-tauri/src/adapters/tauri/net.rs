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
        DesktopHttpEvents(on_event),
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

struct DesktopHttpEvents(Channel<HttpEvent>);

impl HttpEventSink for DesktopHttpEvents {
    fn send(&self, event: HttpEvent) -> Result<(), String> {
        Channel::send(&self.0, event).map_err(|error| error.to_string())
    }
}

/// 准备不可变的本地文件请求体；摘要来自变换前内容，快照由当前 WebView 拥有。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn http_prepare_file(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpState>,
    registry: tauri::State<'_, crate::modules::workspace::WorkspaceRegistry>,
    files: tauri::State<'_, crate::modules::fs::agent::AgentFileState>,
    request_id: String,
    request: files::PrepareRequest,
    on_event: Channel<HttpEvent>,
) -> Result<files::PreparedMetadata, String> {
    state
        .operation(
            window.label(),
            &request_id,
            DesktopHttpEvents(on_event),
            180_000,
            files::prepare(
                &state,
                &files,
                &registry,
                window.label(),
                &request_id,
                request,
            ),
        )
        .await
}

/// 显式释放当前 WebView 的文件请求体，不影响已经持有快照的在途传输。
#[tauri::command]
pub fn http_release_file(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpState>,
    file_id: String,
) {
    state.files.release(window.label(), &file_id);
}

/// 文件 HTTP 请求复用相同的地址、代理和取消边界，不解释请求中的业务字段。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn http_file_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HttpState>,
    registry: tauri::State<'_, crate::modules::workspace::WorkspaceRegistry>,
    secrets: tauri::State<'_, crate::modules::secrets::SecretsState>,
    request_id: String,
    request: files::FileRequest,
    on_event: Channel<HttpEvent>,
) -> Result<files::FileResponse, String> {
    state
        .operation(
            window.label(),
            &request_id,
            DesktopHttpEvents(on_event),
            request.timeout_ms.unwrap_or(120_000),
            files::request(&secrets, &registry, &state, window.label(), request),
        )
        .await
}
