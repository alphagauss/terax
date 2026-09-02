//! 受控 HTTP 客户端与网络安全边界。
//!
//! 本模块统一执行协议、地址、重定向和请求头校验，防止 AI 请求与图片下载绕过 SSRF 限制。

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, LOCATION, USER_AGENT};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

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
const AI_HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const AI_HTTP_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;

/// 已通过公开地址校验和体积限制的网络图片。
pub(crate) struct DownloadedImage {
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

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

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

/// 为 AI HTTP 代理构造固定已验证 DNS 结果的客户端。
fn build_safe_client(
    allow_private: bool,
    pinned: &[(String, Vec<IpAddr>)],
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(10));
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
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 10 {
                return attempt.error("too many redirects");
            }
            let next = attempt.url();
            match next.scheme() {
                "http" | "https" => {}
                _ => return attempt.stop(),
            }
            if next.username() != "" || next.password().is_some() {
                return attempt.stop();
            }
            let Some(host) = next.host_str() else {
                return attempt.stop();
            };
            if is_blocked_host_name(host) {
                return attempt.stop();
            }
            if let Some(ip) = parse_ip_literal(host) {
                let k = ip_kind(ip);
                if k == IpKind::BlockedMetadata {
                    return attempt.stop();
                }
                if !allow_private && matches!(k, IpKind::Loopback | IpKind::Private) {
                    return attempt.stop();
                }
            } else if let Some(previous) = attempt.previous().last() {
                // 新 host 无法在同步重定向策略中重新执行 DNS 分类，因此一律停止跨 host 跳转。
                if previous.host_str() != Some(host) {
                    return attempt.stop();
                }
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// 为单次图片请求创建固定 DNS 结果且禁用自动重定向的客户端。
fn build_pinned_client(
    host: &str,
    safe_ips: &[IpAddr],
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let addrs: Vec<SocketAddr> = safe_ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
    reqwest::Client::builder()
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
pub(crate) async fn download_public_image(
    url: &str,
    max_bytes: usize,
    user_agent: &str,
) -> Result<DownloadedImage, String> {
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
        let client = build_pinned_client(&host, &safe_ips, remaining)?;
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

/// 执行受 SSRF 防护、总时限和响应体积限制的非流式 AI HTTP 请求。
#[tauri::command]
pub async fn ai_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
) -> Result<HttpResponse, String> {
    tokio::time::timeout(AI_HTTP_REQUEST_TIMEOUT, async move {
        let allow_private = allow_private_network.unwrap_or(false);
        let parsed = validate_url(&url)?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "missing host".to_string())?
            .to_string();
        let safe_ips = classify_and_collect_safe_ips(&host, allow_private).await?;
        let client = build_safe_client(allow_private, &[(host, safe_ips)])?;
        let request = build_request(&client, &method, parsed, headers, body)?;
        let response = request.send().await.map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|length| length > AI_HTTP_RESPONSE_MAX_BYTES as u64)
        {
            return Err("AI HTTP response is too large".into());
        }

        let status = response.status().as_u16();
        let headers = header_map_to_strings(response.headers());
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            append_bounded_response(&mut body, &chunk.map_err(|error| error.to_string())?)?;
        }
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    })
    .await
    .map_err(|_| "AI HTTP request timed out".to_string())?
}

/// 追加非流式响应块，并在分配前拒绝超过固定上限的正文。
fn append_bounded_response(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > AI_HTTP_RESPONSE_MAX_BYTES {
        return Err("AI HTTP response is too large".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

#[tauri::command]
pub async fn ai_http_stream(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let allow_private = allow_private_network.unwrap_or(false);
    let parsed = match validate_url(&url) {
        Ok(p) => p,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => {
            let e = "missing host".to_string();
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let safe_ips = match classify_and_collect_safe_ips(&host, allow_private).await {
        Ok(v) => v,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };

    let client = build_safe_client(allow_private, &[(host, safe_ips)])?;

    let req = build_request(&client, &method, parsed, headers, body)?;
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error {
                message: e.to_string(),
            });
            return Err(e.to_string());
        }
    };

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let _ = on_event.send(AiStreamEvent::Headers { status, headers });

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                let bytes: Bytes = chunk;
                if on_event
                    .send(AiStreamEvent::Chunk {
                        bytes: bytes.to_vec(),
                    })
                    .is_err()
                {
                    // Channel dropped (frontend aborted), stop streaming.
                    return Ok(());
                }
            }
            Err(e) => {
                let _ = on_event.send(AiStreamEvent::Error {
                    message: e.to_string(),
                });
                return Err(e.to_string());
            }
        }
    }

    let _ = on_event.send(AiStreamEvent::End);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn bounded_ai_response_rejects_oversized_chunks_before_append() {
        let mut body = vec![0; AI_HTTP_RESPONSE_MAX_BYTES];
        assert!(append_bounded_response(&mut body, &[1]).is_err());
        assert_eq!(body.len(), AI_HTTP_RESPONSE_MAX_BYTES);
    }
}
