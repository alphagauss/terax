//! SSH 直连与显式代理传输。
//!
//! 复用共享代理模型，HTTP CONNECT、HTTPS CONNECT 和 SOCKS5 均不读取环境代理。
//! 服务器地址由连接配置决定，隧道认证不会作为目标服务器请求头转发。
//!
//! Adapted from CrabPort `crabport-proxy/src/lib.rs` (Apache-2.0), with the
//! persistence model removed and Terax's profile-level proxy URL model added.

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::modules::network_proxy::{ProxyConfig, ProxyKind};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + ?Sized> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

/// 按已解析的服务器出口建立字节流，代理失败不会尝试直连。
pub async fn connect(
    proxy: Option<&ProxyConfig>,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    match proxy {
        Some(proxy) => connect_via_proxy(proxy, target_host, target_port).await,
        None => TcpStream::connect((target_host, target_port))
            .await
            .map(|stream| Box::new(stream) as BoxStream),
    }
}

async fn connect_via_proxy(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    match proxy.kind {
        ProxyKind::Socks5 => connect_socks5(proxy, target_host, target_port).await,
        ProxyKind::Http | ProxyKind::Https => {
            connect_http_connect(proxy, target_host, target_port).await
        }
    }
}

/// 使用代理端 DNS 解析目标，保留显式用户名及空密码认证语义。
async fn connect_socks5(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    use tokio_socks::tcp::Socks5Stream;

    let proxy_addr = (proxy.host.as_str(), proxy.port);
    let target = (target_host, target_port);
    let stream = match proxy.username.as_deref() {
        Some(user) => Socks5Stream::connect_with_password(
            proxy_addr,
            target,
            user,
            proxy.password.as_deref().unwrap_or(""),
        )
        .await
        .map_err(socks_io_err)?,
        _ => Socks5Stream::connect(proxy_addr, target)
            .await
            .map_err(socks_io_err)?,
    };
    Ok(Box::new(stream))
}

/// 建立封闭 CONNECT 隧道，支持 IPv6 authority 并限制响应头大小。
async fn connect_http_connect(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let target = if target_host.contains(':') {
        format!("[{target_host}]:{target_port}")
    } else {
        format!("{target_host}:{target_port}")
    };
    let tcp = TcpStream::connect((proxy.host.as_str(), proxy.port)).await?;
    let mut stream: BoxStream = if proxy.kind == ProxyKind::Https {
        connect_tls_over(tcp, &proxy.host).await?
    } else {
        Box::new(tcp)
    };

    let auth = match proxy.username.as_deref() {
        Some(user) => format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64_encode(format!("{user}:{}", proxy.password.as_deref().unwrap_or("")).as_bytes())
        ),
        _ => String::new(),
    };
    let request = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{auth}Proxy-Connection: keep-alive\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;

    let mut header = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await? == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "proxy closed during CONNECT",
            ));
        }
        header.push(byte[0]);
        if header.len() > 8192 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "proxy CONNECT response too large",
            ));
        }
    }
    let header = String::from_utf8_lossy(&header);
    let status = header.lines().next().unwrap_or("");
    let status_code = status.split_whitespace().nth(1);
    if status_code != Some("200") {
        return Err(std::io::Error::new(
            if status_code == Some("407") {
                std::io::ErrorKind::PermissionDenied
            } else {
                std::io::ErrorKind::ConnectionRefused
            },
            format!("proxy CONNECT rejected: {status}"),
        ));
    }
    Ok(stream)
}

async fn connect_tls_over(tcp: TcpStream, server_name: &str) -> std::io::Result<BoxStream> {
    use rustls_pki_types::ServerName;
    use rustls_platform_verifier::BuilderVerifierExt;
    use std::sync::Arc;
    use tokio_rustls::{rustls, TlsConnector};

    let config = rustls::ClientConfig::builder()
        .with_platform_verifier()
        .map_err(io_err)?
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let server_name = ServerName::try_from(server_name.to_string())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    connector
        .connect(server_name, tcp)
        .await
        .map(|stream| Box::new(stream) as BoxStream)
        .map_err(io_err)
}

fn io_err(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

fn socks_io_err(error: tokio_socks::Error) -> std::io::Error {
    let kind = match error {
        tokio_socks::Error::NoAcceptableAuthMethods
        | tokio_socks::Error::PasswordAuthFailure(_)
        | tokio_socks::Error::AuthorizationRequired
        | tokio_socks::Error::InvalidAuthValues(_)
        | tokio_socks::Error::IdentdAuthFailure
        | tokio_socks::Error::InvalidUserIdAuthFailure => std::io::ErrorKind::PermissionDenied,
        _ => std::io::ErrorKind::Other,
    };
    std::io::Error::new(kind, error.to_string())
}

fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[((a & 3) << 4 | b >> 4) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((b & 15) << 2 | c >> 6) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn proxy_auth_failures_require_user_action() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = ProxyConfig::parse(&format!("http://{}", listener.local_addr().unwrap()), None)
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 512];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0 && request.len() + read <= 4096);
                request.extend_from_slice(&chunk[..read]);
            }
            stream
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .await
                .unwrap();
        });
        let error = connect(Some(&proxy), "example.com", 22)
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            socks_io_err(tokio_socks::Error::PasswordAuthFailure(1)).kind(),
            std::io::ErrorKind::PermissionDenied
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_proxy_preserves_auth_ipv6_target_and_ssh_banner() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = ProxyConfig::parse(
            &format!("http://alice@{}", listener.local_addr().unwrap()),
            None,
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
                assert!(request.len() < 4096);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("CONNECT [::1]:22 HTTP/1.1\r\n"));
            assert!(request.contains("Proxy-Authorization: Basic YWxpY2U6\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-test\r\n")
                .await
                .unwrap();
        });
        let mut stream = connect(Some(&proxy), "::1", 22).await.unwrap();
        let mut banner = [0; 14];
        stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-test\r\n");
        server.await.unwrap();
    }
}
