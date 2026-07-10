//! SSH transport proxy support.
//!
//! Adapted from CrabPort `crabport-proxy/src/lib.rs` (Apache-2.0), with the
//! persistence model removed and Terax's profile-level proxy URL model added.

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use super::models::{ProxyConfig, ProxyKind};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + ?Sized> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

pub async fn connect(
    proxy: Option<&ProxyConfig>,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    match proxy {
        Some(proxy) => connect_via_proxy(proxy, target_host, target_port).await,
        None => TcpStream::connect(format!("{target_host}:{target_port}"))
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

async fn connect_socks5(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    use tokio_socks::tcp::Socks5Stream;

    let proxy_addr = format!("{}:{}", proxy.host, proxy.port);
    let target = format!("{target_host}:{target_port}");
    let stream = match (proxy.username.as_deref(), proxy.password.as_deref()) {
        (Some(user), Some(password)) if !user.is_empty() && !password.is_empty() => {
            Socks5Stream::connect_with_password(
                proxy_addr.as_str(),
                target.as_str(),
                user,
                password,
            )
            .await
            .map_err(io_err)?
        }
        _ => Socks5Stream::connect(proxy_addr.as_str(), target.as_str())
            .await
            .map_err(io_err)?,
    };
    Ok(Box::new(stream))
}

async fn connect_http_connect(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> std::io::Result<BoxStream> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let target = format!("{target_host}:{target_port}");
    let tcp = TcpStream::connect(format!("{}:{}", proxy.host, proxy.port)).await?;
    let mut stream: BoxStream = if proxy.kind == ProxyKind::Https {
        connect_tls_over(tcp, &proxy.host).await?
    } else {
        Box::new(tcp)
    };

    let auth = match (proxy.username.as_deref(), proxy.password.as_deref()) {
        (Some(user), Some(password)) if !user.is_empty() => format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64_encode(format!("{user}:{password}").as_bytes())
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
    let accepted = status
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code == "200");
    if !accepted {
        return Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
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
