//! 系统静态代理快照与按目标分流，不读取代理环境变量，不执行 PAC 或自动发现。
//!
//! Windows 读取用户 Internet Settings，macOS 读取 SystemConfiguration，Linux 读取桌面配置。

use super::ProxyConfig;
use std::net::IpAddr;

#[cfg(any(target_os = "linux", test))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

/// 原生读取的代理及绕过规则只驻留当前请求，不写入 Terax 设置或 IPC。
#[derive(Clone, Default)]
pub struct SystemProxy {
    http: Option<ProxyConfig>,
    https: Option<ProxyConfig>,
    socks: Option<ProxyConfig>,
    bypass: Vec<String>,
    exclude_simple: bool,
    reverse_bypass: bool,
}

impl SystemProxy {
    /// 前端只接收不可逆修订号，系统地址和凭据不离开原生层。
    pub(super) fn revision(&self) -> String {
        use sha2::{Digest, Sha256};
        let proxies = [&self.http, &self.https, &self.socks].map(|proxy| {
            proxy
                .as_ref()
                .map(|proxy| (proxy.endpoint(), &proxy.username, &proxy.password))
        });
        let bytes = serde_json::to_vec(&(
            proxies,
            &self.bypass,
            self.exclude_simple,
            self.reverse_bypass,
        ))
        .expect("system proxy identity contains only serializable values");
        format!("{:x}", Sha256::digest(bytes))
    }

    pub(super) fn for_destination(
        &self,
        scheme: &str,
        host: &str,
        port: u16,
    ) -> Option<&ProxyConfig> {
        let bypass = (self.exclude_simple && is_simple_host(host))
            || self
                .bypass
                .iter()
                .any(|rule| bypass_matches(rule, scheme, host, port));
        if bypass != self.reverse_bypass {
            return None;
        }
        match scheme {
            "http" => self.http.as_ref().or(self.socks.as_ref()),
            "https" => self.https.as_ref().or(self.socks.as_ref()),
            // 系统没有 SSH 专用项；优先 SOCKS，其次通过 Web 代理建立隧道。
            "ssh" => self
                .socks
                .as_ref()
                .or(self.https.as_ref())
                .or(self.http.as_ref()),
            _ => None,
        }
    }

    pub(super) fn apply(
        &self,
        mut builder: reqwest::ClientBuilder,
    ) -> Result<reqwest::ClientBuilder, String> {
        builder = builder.no_proxy();
        for scheme in ["http", "https"] {
            let candidate = match scheme {
                "http" => self.http.as_ref().or(self.socks.as_ref()),
                _ => self.https.as_ref().or(self.socks.as_ref()),
            };
            let Some(candidate) = candidate else { continue };
            let mut endpoint = reqwest::Url::parse(&candidate.endpoint())
                .map_err(|_| "invalid system proxy endpoint")?;
            if let Some(username) = &candidate.username {
                // 认证只进入原生代理 URL，保留 SOCKS 认证，不能作为目标请求头发送。
                endpoint
                    .set_username(username)
                    .map_err(|_| "invalid system proxy username")?;
                endpoint
                    .set_password(candidate.password.as_deref())
                    .map_err(|_| "invalid system proxy password")?;
            }
            let rules = self.clone();
            let proxy = reqwest::Proxy::custom(move |url| {
                if url.scheme() != scheme {
                    return None;
                }
                rules
                    .for_destination(scheme, url.host_str()?, url.port_or_known_default()?)
                    .map(|_| endpoint.clone())
            });
            builder = builder.proxy(proxy);
        }
        Ok(builder)
    }
}

fn is_simple_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    !host.contains('.') && host.parse::<IpAddr>().is_err()
}

fn bypass_matches(rule: &str, scheme: &str, host: &str, port: u16) -> bool {
    let rule = rule.trim().to_ascii_lowercase();
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let rule = if let Some((protocol, rest)) = rule.split_once("://") {
        if protocol != scheme {
            return false;
        }
        rest
    } else {
        &rule
    };
    if rule == "<local>" {
        return is_simple_host(&host);
    }
    if let Ok(network) = rule.parse::<ipnet::IpNet>() {
        return host.parse::<IpAddr>().is_ok_and(|ip| network.contains(&ip));
    }
    if rule == host || rule.trim_matches(['[', ']']) == host {
        return true;
    }
    if let Some(domain) = rule.strip_prefix('.') {
        let domain = if let Some((domain, expected_port)) = domain.rsplit_once(':') {
            if expected_port.parse::<u16>().ok() != Some(port) {
                return false;
            }
            domain
        } else {
            domain
        };
        return host == domain || host.ends_with(&format!(".{domain}"));
    }
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    if rule == authority {
        return true;
    }
    // 系统通配符按主机或带端口的 authority 匹配，不对 URL 路径进行分流。
    if !rule.contains(['*', '?']) {
        return false;
    }
    globset::GlobBuilder::new(rule)
        .backslash_escape(false)
        .build()
        .is_ok_and(|glob| {
            let matcher = glob.compile_matcher();
            matcher.is_match(&host) || matcher.is_match(&authority)
        })
}

/// 系统地址没有协议时使用 HTTP，SOCKS 项统一使用代理端 DNS。
fn endpoint(value: &str, socks: bool) -> Result<ProxyConfig, String> {
    let value = value.trim();
    let url = if let Some(rest) = value.strip_prefix("socks://") {
        format!("socks5://{rest}")
    } else if value.contains("://") {
        value.to_string()
    } else {
        format!("{}://{value}", if socks { "socks5" } else { "http" })
    };
    ProxyConfig::parse(&url, None).map_err(|_| "invalid system proxy endpoint".into())
}

/// 每次建连读取系统当前值；原生调用放到阻塞线程，不占用异步执行器。
pub(super) async fn read() -> Result<SystemProxy, String> {
    #[cfg(target_os = "linux")]
    {
        linux::read().await
    }
    #[cfg(not(target_os = "linux"))]
    {
        tokio::task::spawn_blocking(read_native)
            .await
            .map_err(|_| "system proxy reader failed")?
    }
}

#[cfg(target_os = "windows")]
fn read_native() -> Result<SystemProxy, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let settings = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    {
        Ok(settings) => settings,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SystemProxy::default())
        }
        Err(_) => return Err("unable to read system proxy settings".into()),
    };
    let enabled = match settings.get_value::<u32, _>("ProxyEnable") {
        Ok(value) => value != 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("unable to read system proxy switch".into()),
    };
    if !enabled {
        return Ok(SystemProxy::default());
    }
    let server: String = settings
        .get_value("ProxyServer")
        .map_err(|_| "unable to read system proxy endpoint")?;
    let bypass: String = match settings.get_value("ProxyOverride") {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("unable to read system proxy bypass rules".into()),
    };
    parse_windows(&server, &bypass)
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows(server: &str, bypass: &str) -> Result<SystemProxy, String> {
    let mut settings = SystemProxy {
        bypass: bypass.split(';').map(str::to_string).collect(),
        ..Default::default()
    };
    if server.trim().is_empty() {
        return Err("system proxy endpoint is empty".into());
    }
    if !server.contains('=') {
        let proxy = endpoint(server, false)?;
        settings.http = Some(proxy.clone());
        settings.https = Some(proxy);
    } else {
        for entry in server.split(';').filter(|entry| !entry.trim().is_empty()) {
            let Some((scheme, value)) = entry.trim().split_once('=') else {
                return Err("invalid system proxy protocol list".into());
            };
            match scheme.trim().to_ascii_lowercase().as_str() {
                "http" => settings.http = Some(endpoint(value, false)?),
                "https" => settings.https = Some(endpoint(value, false)?),
                "socks" => settings.socks = Some(endpoint(value, true)?),
                _ => {}
            }
        }
    }
    Ok(settings)
}

#[cfg(target_os = "macos")]
fn read_native() -> Result<SystemProxy, String> {
    macos::read()
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn read_native() -> Result<SystemProxy, String> {
    Ok(SystemProxy::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_rules_select_protocols_bypass_hosts_and_support_ssh() {
        let settings = parse_windows(
            "http=127.0.0.1:8080;https=127.0.0.1:8081;socks=127.0.0.1:1080",
            "<local>;*.internal;10.0.0.0/8;[::1];api.example:8443",
        )
        .unwrap();
        for (scheme, port) in [("http", 8080), ("https", 8081), ("ssh", 1080)] {
            assert_eq!(
                settings
                    .for_destination(scheme, "api.example", 443)
                    .unwrap()
                    .port,
                port
            );
        }
        for host in ["localhost", "intranet", "a.internal", "10.1.2.3", "[::1]"] {
            assert!(settings.for_destination("https", host, 443).is_none());
        }
        assert!(settings
            .for_destination("https", "api.example", 8443)
            .is_none());
        assert!(settings
            .for_destination("https", "notinternal.example", 443)
            .is_some());
        assert!(settings
            .for_destination("https", "110.1.2.3", 443)
            .is_some());
        let http_only = parse_windows("127.0.0.1:8080", "").unwrap();
        assert_eq!(
            http_only
                .for_destination("ssh", "server.example", 22)
                .unwrap()
                .port,
            8080
        );
        assert!(parse_windows("bad proxy", "").is_err());
        assert!(parse_windows("", "").is_err());
    }

    #[tokio::test]
    async fn system_proxy_uses_bypass_and_never_retries_direct_on_proxy_failure() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let direct = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let direct_address = direct.local_addr().unwrap();
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut settings =
            parse_windows(&proxy.local_addr().unwrap().to_string(), "127.0.0.1").unwrap();
        settings.http.as_mut().unwrap().username = Some("alice".into());
        settings.http.as_mut().unwrap().password = Some("secret".into());
        let direct_server = tokio::spawn(async move {
            let (mut socket, _) = direct.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(String::from_utf8_lossy(&buffer[..count]).starts_with("GET /"));
            assert!(!String::from_utf8_lossy(&buffer[..count])
                .to_ascii_lowercase()
                .contains("proxy-authorization"));
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect",
                )
                .await
                .unwrap();
            direct
        });
        let server = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(
                String::from_utf8_lossy(&buffer[..count]).starts_with("GET http://api.example/")
            );
            assert!(String::from_utf8_lossy(&buffer[..count]).contains("Basic YWxpY2U6c2VjcmV0"));
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy",
                )
                .await
                .unwrap();
        });
        let client = settings
            .apply(reqwest::Client::builder())
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            client
                .get("http://api.example/")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "proxy"
        );
        server.await.unwrap();
        assert_eq!(
            client
                .get(format!("http://{direct_address}/"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "direct"
        );
        let direct = direct_server.await.unwrap();
        assert!(client
            .get(format!("http://localhost:{}/", direct_address.port()))
            .send()
            .await
            .is_err());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), direct.accept())
                .await
                .is_err()
        );
    }
}
