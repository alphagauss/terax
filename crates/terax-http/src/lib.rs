//! 受控 HTTP 客户端与网络安全边界。
//!
//! 本模块统一执行协议、地址、重定向和请求头校验，并按 WebView 隔离取消与响应上限。
//! AI、Channel 与图片下载复用网络边界；不管理平台协议或业务重试。

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::header::{ACCEPT, LOCATION, USER_AGENT};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use terax_core::modules::network_proxy::{self, NetworkTarget, ResolvedRoute};
use tokio_util::sync::CancellationToken;
pub mod files;

const HEADER_BLOCKLIST: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "transfer-encoding",
    "upgrade",
    "trailer",
    "expect",
];
const IMAGE_REDIRECT_LIMIT: usize = 5;
const IMAGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_RESPONSE_MAX_BYTES: usize = 64 * 1024 * 1024;
const HTTP_REQUEST_LIMIT: usize = 128;

/// 已通过公开地址校验和体积限制的网络图片。
pub struct DownloadedImage {
    /// 未解码的原始响应字节。
    pub bytes: Vec<u8>,
    /// 完成所有受控重定向后的 URL，用于推导保存文件名。
    pub final_url: reqwest::Url,
}

fn is_blocked_host_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    matches!(
        host.as_str(),
        "metadata.google.internal" | "metadata" | "metadata.azure.com"
    )
}

/// 将 IP 归类为公开、私有、回环或必须无条件拒绝的元数据地址。
fn ip_kind(ip: IpAddr) -> IpKind {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            // Cloud metadata IPv4: 169.254.169.254
            if v.is_link_local() {
                return IpKind::BlockedMetadata;
            }
            if v.is_loopback() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // RFC1918 + CGNAT + benchmarking + IETF
            if o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            {
                return IpKind::Private;
            }
            IpKind::Public
        }
        IpAddr::V6(v) => {
            if let Some(mapped) = v.to_ipv4_mapped() {
                return ip_kind(IpAddr::V4(mapped));
            }
            if v.is_loopback() || v.is_unspecified() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // Cloud metadata IPv6 (AWS): fd00:ec2::254
            let segs = v.segments();
            if segs[0] == 0xfd00 && segs[1] == 0xec2 {
                return IpKind::BlockedMetadata;
            }
            // fe80::/10 link-local
            if segs[0] & 0xffc0 == 0xfe80 {
                return IpKind::BlockedMetadata;
            }
            // fc00::/7 unique-local (private)
            if segs[0] & 0xfe00 == 0xfc00 {
                return IpKind::Private;
            }
            IpKind::Public
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum IpKind {
    Public,
    Private,
    Loopback,
    BlockedMetadata,
}

/// 识别 URL host 中可能带方括号的 IP 字面量。
fn parse_ip_literal(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .parse()
        .ok()
}

/// 只解析一次 host，并返回安全分类和可固定到 HTTP 客户端的具体地址。
async fn resolve_and_classify(host: &str) -> Result<(IpKind, Vec<IpAddr>), String> {
    // IP 字面量无需 DNS，方括号已在解析函数内兼容。
    if let Some(ip) = parse_ip_literal(host) {
        return Ok((ip_kind(ip), vec![ip]));
    }
    let mut lookup = tokio::net::lookup_host((host, 0u16))
        .await
        .map_err(|error| format!("dns: {error}"))?
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    if lookup.is_empty() {
        return Err("dns: no addresses".into());
    }
    lookup.sort_unstable();
    lookup.dedup();
    let mut worst = IpKind::Public;
    for ip in &lookup {
        let k = ip_kind(*ip);
        worst = match (worst, k) {
            (_, IpKind::BlockedMetadata) => IpKind::BlockedMetadata,
            (IpKind::BlockedMetadata, _) => IpKind::BlockedMetadata,
            (IpKind::Public, x) => x,
            (x, IpKind::Public) => x,
            (a, _) => a,
        };
    }
    Ok((worst, lookup))
}

/// 校验 URL 语法级边界；解析后的 IP 安全分类由异步调用方完成。
fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("userinfo in url is not allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?;
    if is_blocked_host_name(host) {
        return Err(format!("host not allowed: {host}"));
    }
    Ok(parsed)
}

/// 分类 host 并只返回通过校验的地址，供 reqwest 固定解析结果以阻止 DNS 重绑定。
async fn classify_and_collect_safe_ips(
    host: &str,
    allow_private: bool,
) -> Result<Vec<IpAddr>, String> {
    let (worst, ips) = resolve_and_classify(host).await?;
    match worst {
        IpKind::BlockedMetadata => return Err(format!("host not allowed: {host}")),
        IpKind::Loopback | IpKind::Private if !allow_private => {
            return Err(format!(
                "host {host} resolves to a private/loopback address; this endpoint requires explicit opt-in",
            ));
        }
        _ => {}
    }
    let safe: Vec<IpAddr> = ips
        .into_iter()
        .filter(|ip| match ip_kind(*ip) {
            IpKind::BlockedMetadata => false,
            IpKind::Loopback | IpKind::Private => allow_private,
            IpKind::Public => true,
        })
        .collect();
    if safe.is_empty() {
        return Err(format!("host {host}: no safe IPs"));
    }
    Ok(safe)
}

fn sanitize_headers(headers: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(h) = headers else { return Ok(map) };
    for (k, v) in h {
        let lower = k.to_ascii_lowercase();
        if HEADER_BLOCKLIST.contains(&lower.as_str()) {
            return Err(format!("header not allowed: {k}"));
        }
        // CRLF injection: header value must not contain CR / LF / NUL.
        if v.as_bytes().iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return Err(format!("header value contains control bytes: {k}"));
        }
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
        map.insert(name, value);
    }
    Ok(map)
}

// AI HTTP proxy: bypasses webview CORS / Mixed-Content / PNA so local-network
// model servers (LM Studio, Ollama, vLLM) work in the production bundle.

fn build_request(
    client: &reqwest::Client,
    method: &str,
    url: reqwest::Url,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
) -> Result<reqwest::RequestBuilder, String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    let map = sanitize_headers(headers)?;
    req = req.headers(map);
    if let Some(b) = body {
        req = req.body(b);
    }
    Ok(req)
}

/// 构造固定已验证 DNS 结果的客户端，重定向由传输层逐跳处理。
fn build_safe_client(
    pinned: &[(String, Vec<IpAddr>)],
    proxy: &ResolvedRoute,
) -> Result<reqwest::Client, String> {
    let mut builder =
        proxy.apply(reqwest::Client::builder().connect_timeout(Duration::from_secs(10)))?;
    // 直连固定已验证的 DNS；显式代理是受信任出口，目标解析由代理端负责。
    // Pin reqwest's resolver to the IPs we just classified. Without this,
    // reqwest's own DNS lookup could return a different (private/metadata) IP
    // for the same hostname between classify and connect; classic DNS
    // rebinding attack. We pin port 0 because reqwest fills in the actual
    // port from the URL when wiring up the override map.
    for (host, ips) in pinned {
        let addrs: Vec<SocketAddr> = ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
        if !addrs.is_empty() {
            builder = builder.resolve_to_addrs(host, &addrs);
        }
    }
    builder
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// 保持既有重定向边界：域名只允许同主机，字面 IP 重新分类，不能跳到元数据地址。
fn redirect_allowed(previous: &reqwest::Url, next: &reqwest::Url, allow_private: bool) -> bool {
    if !matches!(next.scheme(), "http" | "https")
        || !next.username().is_empty()
        || next.password().is_some()
    {
        return false;
    }
    let Some(host) = next.host_str() else {
        return false;
    };
    if is_blocked_host_name(host) {
        return false;
    }
    if let Some(ip) = parse_ip_literal(host) {
        let kind = ip_kind(ip);
        kind != IpKind::BlockedMetadata
            && (allow_private || !matches!(kind, IpKind::Loopback | IpKind::Private))
    } else {
        previous.host_str() == Some(host)
    }
}

/// 每一跳重新注入所选代理的认证，避免自动重定向丢失认证或携带上一出口的请求头。
async fn send_request(
    client: &reqwest::Client,
    mut request: reqwest::Request,
    allow_private: bool,
    redirect: HttpRedirectMode,
) -> Result<reqwest::Response, String> {
    let mut redirects = 0;
    loop {
        let previous = request.url().clone();
        // 内置请求体均为可重放的字节，不克隆网络流，也不保留客户端注入的代理认证。
        let mut next_request = request
            .try_clone()
            .ok_or("HTTP request body cannot be replayed")?;
        let response = client
            .execute(request)
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        let Some(next) = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| previous.join(value).ok())
        else {
            return Ok(response);
        };
        match redirect {
            HttpRedirectMode::Error => return Err("HTTP redirect is not allowed".into()),
            HttpRedirectMode::Manual => return Ok(response),
            HttpRedirectMode::Follow => {}
        }
        if redirects == 10 {
            return Err("too many redirects".into());
        }
        if !redirect_allowed(&previous, &next, allow_private) {
            return Ok(response);
        }
        if previous.host_str() != next.host_str()
            || previous.port_or_known_default() != next.port_or_known_default()
        {
            for header in ["authorization", "cookie", "cookie2", "www-authenticate"] {
                next_request.headers_mut().remove(header);
            }
        }
        if matches!(status, 301 | 302) && next_request.method() == Method::POST
            || status == 303 && next_request.method() != Method::HEAD
        {
            *next_request.method_mut() = Method::GET;
            *next_request.body_mut() = None;
            for header in [
                "transfer-encoding",
                "content-encoding",
                "content-type",
                "content-length",
            ] {
                next_request.headers_mut().remove(header);
            }
        }
        if !(previous.scheme() == "https" && next.scheme() == "http") {
            let mut referer = previous;
            referer.set_fragment(None);
            if let Ok(value) = HeaderValue::from_str(referer.as_str()) {
                next_request
                    .headers_mut()
                    .insert(reqwest::header::REFERER, value);
            }
        } else {
            next_request.headers_mut().remove(reqwest::header::REFERER);
        }
        *next_request.url_mut() = next;
        request = next_request;
        redirects += 1;
    }
}

/// 为单次图片请求创建固定 DNS 结果且禁用自动重定向的客户端。
fn build_pinned_client(
    host: &str,
    safe_ips: &[IpAddr],
    timeout: Duration,
    proxy: &ResolvedRoute,
) -> Result<reqwest::Client, String> {
    let addrs: Vec<SocketAddr> = safe_ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
    let builder = proxy.apply(reqwest::Client::builder())?;
    builder
        .connect_timeout(Duration::from_secs(10).min(timeout))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|error| error.to_string())
}

/// 返回网络图片请求的剩余总时限，避免 DNS 和重定向分别获得完整超时。
fn remaining_image_request_time(started: Instant) -> Result<Duration, String> {
    IMAGE_REQUEST_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "image request timed out".to_string())
}

/// 下载公开网络图片，并对每次重定向重新执行地址校验和体积限制。
pub async fn download_public_image(
    secrets: &terax_core::modules::secrets::SecretsState,
    url: &str,
    max_bytes: usize,
    user_agent: &str,
) -> Result<DownloadedImage, String> {
    let proxy = network_proxy::resolve(secrets, &NetworkTarget::Markdown).await?;
    let started = Instant::now();
    let mut current = validate_url(url)?;

    for redirect_count in 0..=IMAGE_REDIRECT_LIMIT {
        let remaining = remaining_image_request_time(started)?;
        let host = current
            .host_str()
            .ok_or_else(|| "missing host".to_string())?
            .to_string();
        let safe_ips = tokio::time::timeout(remaining, classify_and_collect_safe_ips(&host, false))
            .await
            .map_err(|_| "image request timed out".to_string())??;
        let remaining = remaining_image_request_time(started)?;
        let client = build_pinned_client(&host, &safe_ips, remaining, &proxy)?;
        let mut request = client.get(current.clone()).header(
            ACCEPT,
            "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.9,*/*;q=0.5",
        );
        if !user_agent.is_empty()
            && user_agent.len() <= 512
            && !user_agent.chars().any(char::is_control)
        {
            request = request.header(USER_AGENT, user_agent);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;

        if response.status().is_redirection() {
            if redirect_count == IMAGE_REDIRECT_LIMIT {
                return Err("too many image redirects".into());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| "image redirect has no location".to_string())?
                .to_str()
                .map_err(|_| "image redirect location is invalid".to_string())?;
            current = validate_url(
                current
                    .join(location)
                    .map_err(|error| format!("invalid image redirect: {error}"))?
                    .as_str(),
            )?;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("image request failed: {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(format!("image is larger than {max_bytes} bytes"));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(format!("image is larger than {max_bytes} bytes"));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(DownloadedImage {
            bytes,
            final_url: current,
        });
    }

    Err("too many image redirects".into())
}

fn header_map_to_strings(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    out
}

/// 遵循 Fetch 的重定向模式；平台适配器可拒绝未经协议校验的目标变更。
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HttpRedirectMode {
    /// 在通用地址安全检查通过后跟随跳转。
    #[default]
    Follow,
    /// 任何重定向均返回错误，不转发正文与请求头。
    Error,
    /// 将重定向响应交回调用者。
    Manual,
}

/// 当前 WebView 拥有的可取消 HTTP 请求；不保存平台协议或业务状态。
#[derive(Default)]
pub struct HttpState {
    requests: Mutex<HashMap<(String, String), CancellationToken>>,
    pub files: files::PreparedFiles,
}

/// 请求退出时释放登记；取消会丢弃整个网络 future，包括等待响应头的阶段。
struct RequestGuard<'a> {
    state: &'a HttpState,
    key: (String, String),
    token: CancellationToken,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.state.requests.lock() {
            requests.remove(&self.key);
        }
    }
}

impl HttpState {
    /// 为原生复合传输登记一次取消身份，整个操作共享启动确认与总时限。
    pub async fn operation<T>(
        &self,
        owner: &str,
        id: &str,
        events: impl HttpEventSink,
        timeout_ms: u64,
        work: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        if timeout_ms == 0 || timeout_ms > 600_000 {
            return Err("HTTP timeout is out of range".into());
        }
        let request = self.begin(owner, id)?;
        events.send(HttpEvent::Started)?;
        let result = run_request(&request.token, Some(timeout_ms), work).await;
        if result.is_err() || request.token.is_cancelled() {
            self.files.release(owner, id);
        }
        if request.token.is_cancelled() {
            return Err("HTTP request cancelled".into());
        }
        result
    }
    /// 在发送启动确认前登记请求，同一窗口不能重复使用正在运行的请求 ID。
    fn begin(&self, owner: &str, id: &str) -> Result<RequestGuard<'_>, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("HTTP request ID must be a UUID".into());
        }
        if self.files.contains(owner, id) {
            return Err("request ID belongs to a prepared file".into());
        }
        let key = (owner.to_string(), id.to_string());
        let mut requests = self.requests.lock().map_err(|error| error.to_string())?;
        if requests.len() >= HTTP_REQUEST_LIMIT || requests.contains_key(&key) {
            return Err("HTTP request limit reached or duplicate request ID".into());
        }
        let token = CancellationToken::new();
        requests.insert(key.clone(), token.clone());
        Ok(RequestGuard {
            state: self,
            key,
            token,
        })
    }

    /// 窗口销毁时取消它拥有的全部请求，不影响其他 WebView。
    pub fn cancel_owner(&self, owner: &str) {
        self.files.clear_owner(owner);
        if let Ok(requests) = self.requests.lock() {
            for ((window, _), token) in requests.iter() {
                if window == owner {
                    token.cancel();
                }
            }
        }
    }

    /// 请求只能由发起它的 WebView 取消。
    pub fn cancel(&self, owner: &str, id: &str) {
        if let Ok(requests) = self.requests.lock() {
            if let Some(token) = requests.get(&(owner.to_string(), id.to_string())) {
                token.cancel();
            }
        }
    }
}

/// HTTP 传输事件，启动事件解决前端取消早于原生登记的竞争。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HttpEvent {
    /// 原生请求已经登记，前端此时可以安全发送取消。
    Started,
    /// 状态码与响应头先于正文到达。
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// 有界正文片段，沿用平台传输顺序。
    Chunk { bytes: Vec<u8> },
    /// 正文已经完整结束。
    End,
}

/// 在宿主隔离身份下执行相同的地址校验、出口选择、流式传输和取消。
#[allow(clippy::too_many_arguments)]
pub async fn http_request(
    secrets: &terax_core::modules::secrets::SecretsState,
    owner: &str,
    state: &HttpState,
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
    on_event: impl HttpEventSink,
) -> Result<(), String> {
    if timeout_ms.is_some_and(|value| value == 0 || value > 600_000) {
        return Err("HTTP timeout must be between 1 and 600000 milliseconds".into());
    }
    let request = state.begin(owner, &request_id)?;
    on_event.send(HttpEvent::Started)?;
    run_request(
        &request.token,
        timeout_ms,
        exchange(
            secrets,
            url,
            method,
            redirect,
            headers,
            body,
            allow_private_network,
            network_target,
            max_response_bytes,
            on_event,
        ),
    )
    .await
}

/// 统一 HTTP 传输内核；调用方拥有取消与总时限，正文出口可以是 WebView 或原生文件。
#[allow(clippy::too_many_arguments)]
async fn exchange(
    secrets: &terax_core::modules::secrets::SecretsState,
    url: String,
    method: String,
    redirect: Option<HttpRedirectMode>,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
    network_target: NetworkTarget,
    max_response_bytes: usize,
    on_event: impl HttpEventSink,
) -> Result<(), String> {
    if max_response_bytes == 0 || max_response_bytes > HTTP_RESPONSE_MAX_BYTES {
        return Err("HTTP response limit is out of range".into());
    }
    if body
        .as_ref()
        .is_some_and(|bytes| bytes.len() > HTTP_RESPONSE_MAX_BYTES)
    {
        return Err("HTTP request body is too large".into());
    }
    let parsed = validate_url(&url)?;
    let host = parsed.host_str().ok_or("missing host")?.to_string();
    let allow_private = allow_private_network.unwrap_or(false);
    let safe_ips = classify_and_collect_safe_ips(&host, allow_private).await?;
    let proxy = network_proxy::resolve(secrets, &network_target).await?;
    let client = build_safe_client(&[(host, safe_ips)], &proxy)?;
    let request = build_request(&client, &method, parsed, headers, body)?
        .build()
        .map_err(|error| error.to_string())?;
    let response = send_request(
        &client,
        request,
        allow_private,
        redirect.unwrap_or_default(),
    )
    .await?;
    if response
        .content_length()
        .is_some_and(|length| length > max_response_bytes as u64)
    {
        return Err("HTTP response is too large".into());
    }
    on_event
        .send(HttpEvent::Headers {
            status: response.status().as_u16(),
            headers: header_map_to_strings(response.headers()),
        })
        .map_err(|error| error.to_string())?;
    let mut size = 0usize;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| error.to_string())?;
        size = size.saturating_add(bytes.len());
        if size > max_response_bytes {
            return Err("HTTP response is too large".into());
        }
        on_event
            .send(HttpEvent::Chunk {
                bytes: bytes.to_vec(),
            })
            .map_err(|error| error.to_string())?;
    }
    on_event
        .send(HttpEvent::End)
        .map_err(|error| error.to_string())
}

/// 等待完整请求的取消或总超时，返回时网络 future 已释放。
async fn run_request<T>(
    token: &CancellationToken,
    timeout_ms: Option<u64>,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let deadline = async {
        match timeout_ms {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        biased;
        _ = token.cancelled() => Err("HTTP request cancelled".into()),
        _ = deadline => Err("HTTP request timed out".into()),
        result = work => result,
    }
}

/// 宿主提供的有序 HTTP 事件出口，写入失败会结束请求。
pub trait HttpEventSink: Send + Sync {
    /// 按顺序发送事件，出口关闭时返回错误以终止传输。
    fn send(&self, event: HttpEvent) -> Result<(), String>;
}

impl<F: Fn(HttpEvent) -> Result<(), String> + Send + Sync> HttpEventSink for F {
    fn send(&self, event: HttpEvent) -> Result<(), String> {
        self(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn redirects_reapply_proxy_authentication_for_each_destination() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = network_proxy::ProxyConfig::parse(
            &format!("http://alice@{}", listener.local_addr().unwrap()),
            Some("secret"),
        )
        .unwrap();
        let server = tokio::spawn(async move {
            for port in [8000, 8001, 8002] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = Vec::new();
                loop {
                    assert!(socket.read_buf(&mut buffer).await.unwrap() > 0);
                    if buffer.windows(4).any(|bytes| bytes == b"\r\n\r\n")
                        && (port == 8002 || buffer.ends_with(b"payload"))
                    {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&buffer);
                let method = if port == 8002 { "GET" } else { "POST" };
                assert!(request.starts_with(&format!("{method} http://localhost:{port}/")));
                assert!(request.contains("Basic YWxpY2U6c2VjcmV0"));
                assert_eq!(request.contains("target-token"), port == 8000);
                assert_eq!(
                    request.to_ascii_lowercase().contains("content-type:"),
                    port != 8002
                );
                let response = if port == 8000 {
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://localhost:8001/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else if port == 8001 {
                    "HTTP/1.1 302 Found\r\nLocation: http://localhost:8002/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = build_safe_client(&[], &ResolvedRoute::Proxy(proxy)).unwrap();
        let request = client
            .post("http://localhost:8000/")
            .header("Authorization", "target-token")
            .header("Content-Type", "text/plain")
            .body("payload")
            .build()
            .unwrap();
        let response = send_request(&client, request, true, HttpRedirectMode::Follow)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
    }

    #[test]
    fn redirects_keep_the_original_address_security_boundary() {
        let previous = reqwest::Url::parse("https://api.example/").unwrap();
        for (next, allow_private, allowed) in [
            ("http://api.example:8080/", false, true),
            ("https://other.example/", true, false),
            ("http://127.0.0.1/", false, false),
            ("http://127.0.0.1/", true, true),
            ("http://169.254.169.254/", true, false),
            ("https://metadata.google.internal/", true, false),
            ("https://user:secret@api.example/", true, false),
            ("file:///etc/passwd", true, false),
        ] {
            assert_eq!(
                redirect_allowed(
                    &previous,
                    &reqwest::Url::parse(next).unwrap(),
                    allow_private
                ),
                allowed,
                "{next}"
            );
        }
    }

    /// 环境变量只注入隔离测试子进程，不能污染并发测试或开发进程。
    #[test]
    fn explicit_routes_ignore_environment_and_never_fall_back() {
        const MARKER: &str = "TERAX_PROXY_TEST_CHILD";
        if std::env::var_os(MARKER).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::explicit_routes_ignore_environment_and_never_fall_back",
                    "--nocapture",
                ])
                .env(MARKER, "1")
                .env("HTTP_PROXY", "http://127.0.0.1:1")
                .env("HTTPS_PROXY", "http://127.0.0.1:1")
                .env("ALL_PROXY", "http://127.0.0.1:1")
                .env("http_proxy", "http://127.0.0.1:1")
                .env("https_proxy", "http://127.0.0.1:1")
                .env("all_proxy", "http://127.0.0.1:1")
                .env("NO_PROXY", "")
                .env("no_proxy", "")
                .output()
                .unwrap();
            assert!(
                result.status.success() && String::from_utf8_lossy(&result.stdout).contains(MARKER),
                "child stdout: {}\nchild stderr: {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let direct = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/model", direct.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = direct.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let read = stream.read(&mut bytes).await.unwrap();
                assert!(read > 0);
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect",
                    )
                    .await
                    .unwrap();
                direct
            });
            let response = build_safe_client(&[], &ResolvedRoute::Direct)
                .unwrap()
                .get(&url)
                .send()
                .await
                .unwrap();
            assert_eq!(response.text().await.unwrap(), "direct");
            let direct = server.await.unwrap();
            let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = network_proxy::ProxyConfig::parse(
                &format!("http://{}", proxy_listener.local_addr().unwrap()),
                None,
            )
            .unwrap();
            let proxy = ResolvedRoute::Proxy(proxy);
            let proxy_server = tokio::spawn(async move {
                let (mut stream, _) = proxy_listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                let read = stream.read(&mut bytes).await.unwrap();
                assert!(String::from_utf8_lossy(&bytes[..read]).starts_with("GET http://"));
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy",
                    )
                    .await
                    .unwrap();
            });
            let response = build_safe_client(&[], &proxy)
                .unwrap()
                .get(&url)
                .send()
                .await
                .unwrap();
            assert_eq!(response.text().await.unwrap(), "proxy");
            proxy_server.await.unwrap();
            let failed = build_safe_client(&[], &proxy)
                .unwrap()
                .get(&url)
                .send()
                .await;
            assert!(failed.is_err());
            assert!(
                tokio::time::timeout(Duration::from_millis(100), direct.accept())
                    .await
                    .is_err()
            );
        });
        // 测试名失效时 --exact 会成功退出但执行零项，要求子进程确认完成了网络断言。
        println!("{MARKER}");
    }
    use std::net::Ipv4Addr;

    #[test]
    fn metadata_ips_classified_as_blocked() {
        // AWS / Google / Azure all share the IPv4 169.254.169.254 link-local.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
            IpKind::BlockedMetadata
        );
        // AWS IPv6 metadata
        assert_eq!(
            ip_kind("fd00:ec2::254".parse().unwrap()),
            IpKind::BlockedMetadata
        );
        // Any link-local IPv4 (169.254/16); same network range, still blocked.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))),
            IpKind::BlockedMetadata
        );
        // IPv6 link-local fe80::/10
        assert_eq!(ip_kind("fe80::1".parse().unwrap()), IpKind::BlockedMetadata);
    }

    #[test]
    fn private_ips_classified_correctly() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))),
            IpKind::Private
        );
        // CGNAT 100.64/10
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            IpKind::Private
        );
    }

    #[test]
    fn loopback_classified_as_loopback() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            IpKind::Loopback
        );
        assert_eq!(ip_kind("::1".parse().unwrap()), IpKind::Loopback);
        assert_eq!(
            ip_kind("::ffff:127.0.0.1".parse().unwrap()),
            IpKind::Loopback
        );
    }

    #[test]
    fn parses_bracketed_ipv6_literals_before_dns_resolution() {
        assert_eq!(
            parse_ip_literal("[2606:4700:4700::1111]"),
            Some("2606:4700:4700::1111".parse().unwrap())
        );
        assert_eq!(
            parse_ip_literal("[::ffff:127.0.0.1]"),
            Some("::ffff:127.0.0.1".parse().unwrap())
        );
    }

    #[test]
    fn public_ips_classified_as_public() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))),
            IpKind::Public
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))),
            IpKind::Public
        );
    }

    #[test]
    fn validate_url_blocks_userinfo_and_metadata_hostnames() {
        // URLs with userinfo can confuse browsers / leak creds in redirects.
        assert!(validate_url("http://user:pass@example.com/").is_err());
        // Cloud metadata-by-name.
        assert!(validate_url("http://metadata.google.internal/").is_err());
        assert!(validate_url("http://metadata/").is_err());
        assert!(validate_url("http://metadata.azure.com/").is_err());
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        assert!(validate_url("ftp://example.com/").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn sanitize_headers_blocks_crlf_injection() {
        let mut h = HashMap::new();
        h.insert("X-Foo".to_string(), "bar\r\nX-Evil: yes".to_string());
        assert!(sanitize_headers(Some(h)).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_hop_by_hop_headers() {
        for hop in [
            "host",
            "content-length",
            "connection",
            "proxy-authorization",
        ] {
            let mut h = HashMap::new();
            h.insert(hop.to_string(), "value".to_string());
            assert!(
                sanitize_headers(Some(h)).is_err(),
                "expected {hop} to be rejected"
            );
        }
    }

    #[tokio::test]
    async fn explicit_redirect_modes_do_not_forward_the_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let read = socket.read(&mut request).await.unwrap();
                let response = if request[..read].starts_with(b"GET /target ") {
                    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: /target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let url = format!("http://{address}/redirect");
        let client = build_safe_client(&[], &ResolvedRoute::Direct).unwrap();
        let rejected = send_request(
            &client,
            client.get(&url).build().unwrap(),
            true,
            HttpRedirectMode::Error,
        )
        .await;
        assert_eq!(rejected.unwrap_err(), "HTTP redirect is not allowed");
        let manual = send_request(
            &client,
            client.get(&url).build().unwrap(),
            true,
            HttpRedirectMode::Manual,
        )
        .await
        .unwrap();
        assert_eq!(manual.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        server.abort();
    }

    #[tokio::test]
    async fn cancellation_is_window_scoped_and_releases_pending_work() {
        let state = HttpState::default();
        let id = uuid::Uuid::new_v4().to_string();
        let request = state.begin("main", &id).unwrap();
        state.cancel("settings", &id);
        assert!(!request.token.is_cancelled());
        state.cancel("main", &id);
        let result = run_request::<()>(&request.token, None, std::future::pending()).await;
        assert_eq!(result.unwrap_err(), "HTTP request cancelled");
        drop(request);
        assert!(state.requests.lock().unwrap().is_empty());
        let next = state.begin("main", &id).unwrap();
        assert_eq!(
            run_request::<()>(&next.token, Some(1), std::future::pending())
                .await
                .unwrap_err(),
            "HTTP request timed out"
        );
    }
}
