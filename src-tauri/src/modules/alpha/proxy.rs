//! Alpha 通用 HTTP 与 WebSocket 代理。
//!
//! 本模块只允许访问固定本机 Alpha 服务，注入共享凭据并限制传输资源。
//! WebView 不能指定主机、端口、认证头或服务生命周期控制路径。

use super::service;
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderMap, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const MAX_HTTP_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const WEBSOCKET_COMMAND_CAPACITY: usize = 8;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// URL 查询参数，使用数组保留同名参数和调用方顺序。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaQueryParam {
    pub name: String,
    pub value: String,
}

/// Alpha 通用 HTTP 请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaHttpRequest {
    pub method: String,
    pub path: String,
    pub query: Vec<AlphaQueryParam>,
    pub body: Option<Value>,
}

/// Alpha 通用 HTTP 响应。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Value,
}

/// WebSocket 向前端发送的连接事件。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AlphaWebSocketEvent {
    Message { message: Value },
    Closed { code: Option<u16>, reason: String },
    Error { message: String },
}

enum WebSocketCommand {
    Send(String),
    Close,
}

/// 当前 Terax 进程持有的 Alpha WebSocket 连接。
///
/// 多个原生窗口属于不同进程，各自维护代理连接；Alpha 业务服务仍是本机共享单例。
pub struct AlphaProxyState {
    sessions: Arc<Mutex<HashMap<u32, mpsc::Sender<WebSocketCommand>>>>,
    next_id: AtomicU32,
}

impl Default for AlphaProxyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
        }
    }
}

impl AlphaProxyState {
    /// 关闭当前 Terax 进程建立的全部 Alpha WebSocket。
    pub fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .expect("Alpha proxy sessions mutex poisoned")
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>();
        for sender in sessions {
            let _ = sender.try_send(WebSocketCommand::Close);
        }
    }
}

/// 转发一个 GET 或 POST JSON 请求。
pub async fn http_request(request: AlphaHttpRequest) -> Result<AlphaHttpResponse, String> {
    let method = request.method.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST") {
        return Err("Alpha 代理只支持 GET 和 POST".to_string());
    }
    if method == "GET" && request.body.is_some() {
        return Err("Alpha GET 请求不能携带请求体".to_string());
    }

    let url = build_url(&request.path, &request.query)?;
    let token = service::read_token()?;
    let mut builder = client()
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?,
            url,
        )
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(HTTP_TIMEOUT);
    if let Some(body) = request.body {
        let bytes = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_HTTP_REQUEST_BYTES {
            return Err("Alpha 请求超过 16 MiB 限制".to_string());
        }
        builder = builder.header(CONTENT_TYPE, "application/json").body(bytes);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("Alpha 请求失败: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES)
    {
        return Err("Alpha 响应超过 16 MiB 限制".to_string());
    }
    let status = response.status().as_u16();
    let headers = response_headers(response.headers());
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(MAX_HTTP_RESPONSE_BYTES) as usize,
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 Alpha 响应失败: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_HTTP_RESPONSE_BYTES as usize {
            return Err("Alpha 响应超过 16 MiB 限制".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("Alpha 返回了非 JSON 响应: {error}"))?
    };
    Ok(AlphaHttpResponse {
        status,
        headers,
        body,
    })
}

/// 建立一个经过凭据注入的双向 JSON WebSocket。
pub async fn websocket_open(
    state: &AlphaProxyState,
    path: String,
    query: Vec<AlphaQueryParam>,
    on_event: Channel<AlphaWebSocketEvent>,
) -> Result<u32, String> {
    let http_url = build_url(&path, &query)?;
    let websocket_url = http_url.as_str().replacen("http://", "ws://", 1);
    let token = service::read_token()?;
    let mut request = websocket_url
        .into_client_request()
        .map_err(|error| error.to_string())?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|error| error.to_string())?,
    );
    let websocket_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES));
    let (socket, _) = tokio::time::timeout(
        WEBSOCKET_CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(websocket_config), false),
    )
    .await
    .map_err(|_| "连接 Alpha WebSocket 超时".to_string())?
    .map_err(|error| format!("连接 Alpha WebSocket 失败: {error}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel(WEBSOCKET_COMMAND_CAPACITY);
    state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id, sender);
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn(run_websocket(id, socket, receiver, on_event, sessions));
    Ok(id)
}

/// 向已建立的 Alpha WebSocket 发送 JSON 消息。
pub fn websocket_send(state: &AlphaProxyState, id: u32, message: Value) -> Result<(), String> {
    let message = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    if message.len() > MAX_WEBSOCKET_MESSAGE_BYTES {
        return Err("Alpha WebSocket 消息超过 4 MiB 限制".to_string());
    }
    let sender = state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Alpha WebSocket 不存在: {id}"))?;
    sender
        .try_send(WebSocketCommand::Send(message))
        .map_err(|error| format!("Alpha WebSocket 无法发送消息: {id}: {error}"))
}

/// 幂等关闭一个 Alpha WebSocket。
pub fn websocket_close(state: &AlphaProxyState, id: u32) {
    let sender = state
        .sessions
        .lock()
        .expect("Alpha proxy sessions mutex poisoned")
        .remove(&id);
    if let Some(sender) = sender {
        let _ = sender.try_send(WebSocketCommand::Close);
    }
}

async fn run_websocket(
    id: u32,
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut commands: mpsc::Receiver<WebSocketCommand>,
    on_event: Channel<AlphaWebSocketEvent>,
    sessions: Arc<Mutex<HashMap<u32, mpsc::Sender<WebSocketCommand>>>>,
) {
    let (mut writer, mut reader) = socket.split();
    let mut close_code = None;
    let mut close_reason = String::new();

    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(WebSocketCommand::Send(text)) => {
                        if let Err(error) = writer.send(Message::Text(text.into())).await {
                            let _ = on_event.send(AlphaWebSocketEvent::Error {
                                message: error.to_string(),
                            });
                            break;
                        }
                    }
                    Some(WebSocketCommand::Close) | None => {
                        let _ = writer.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let message = match serde_json::from_str(&text) {
                            Ok(message) => message,
                            Err(error) => {
                                let _ = on_event.send(AlphaWebSocketEvent::Error {
                                    message: format!("Alpha WebSocket 返回了非 JSON 消息: {error}"),
                                });
                                break;
                            }
                        };
                        if on_event.send(AlphaWebSocketEvent::Message { message }).is_err() {
                            let _ = writer.send(Message::Close(None)).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if writer.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        if let Some(frame) = frame {
                            close_code = Some(frame.code.into());
                            close_reason = frame.reason.to_string();
                        }
                        break;
                    }
                    Some(Ok(Message::Binary(_))) => {
                        let _ = on_event.send(AlphaWebSocketEvent::Error {
                            message: "Alpha WebSocket 只支持 JSON 文本消息".to_string(),
                        });
                        let _ = writer.send(Message::Close(None)).await;
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        let _ = on_event.send(AlphaWebSocketEvent::Error {
                            message: error.to_string(),
                        });
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(&id);
    }
    let _ = on_event.send(AlphaWebSocketEvent::Closed {
        code: close_code,
        reason: close_reason,
    });
}

fn build_url(path: &str, query: &[AlphaQueryParam]) -> Result<reqwest::Url, String> {
    validate_path(path)?;
    let mut url = reqwest::Url::parse(&format!("{}{}", service::base_url(), path))
        .map_err(|error| format!("Alpha 请求路径无效: {error}"))?;
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for item in query {
            pairs.append_pair(&item.name, &item.value);
        }
    }
    Ok(url)
}

fn validate_path(path: &str) -> Result<(), String> {
    let valid_prefix = path == "/api/alpha" || path.starts_with("/api/alpha/");
    if !valid_prefix
        || path.contains(['?', '#', '\\', '%'])
        || path.split('/').any(|segment| matches!(segment, "." | ".."))
    {
        return Err("Alpha 代理路径必须是 /api/alpha 下的安全相对路径".to_string());
    }
    if path == "/api/alpha/system" || path.starts_with("/api/alpha/system/") {
        return Err("Alpha 生命周期接口不能通过通用代理访问".to_string());
    }
    Ok(())
}

fn response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect()
}

/// 本机 Alpha 通道固定直连，不读取环境或共享代理。
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("Alpha HTTP client configuration must be valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_only_accepts_safe_alpha_business_paths() {
        assert!(validate_path("/api/alpha/health").is_ok());
        assert!(validate_path("/api/alpha/backtests/result.json").is_ok());
        assert!(validate_path("http://example.com/api/alpha").is_err());
        assert!(validate_path("/api/alpha/../system/shutdown").is_err());
        assert!(validate_path("/api/alpha/%2e%2e/system/shutdown").is_err());
        assert!(validate_path("/api/alpha/system/shutdown").is_err());
    }

    #[test]
    fn proxy_encodes_repeated_query_parameters() {
        let url = build_url(
            "/api/alpha/bars",
            &[
                AlphaQueryParam {
                    name: "symbol".to_string(),
                    value: "000001.SZSE".to_string(),
                },
                AlphaQueryParam {
                    name: "symbol".to_string(),
                    value: "000002.SZSE".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:11123/api/alpha/bars?symbol=000001.SZSE&symbol=000002.SZSE"
        );
    }

    #[test]
    fn closing_unknown_websocket_is_idempotent() {
        websocket_close(&AlphaProxyState::default(), 99);
    }
}
