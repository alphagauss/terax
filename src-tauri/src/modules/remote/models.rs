use serde::{Deserialize, Serialize};

fn default_port() -> u16 {
    22
}

fn default_keepalive() -> u64 {
    30
}

fn default_reconnect_attempts() -> u32 {
    5
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
    Agent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive_seconds: u64,
    #[serde(default)]
    pub reconnect_enabled: bool,
    #[serde(default = "default_reconnect_attempts")]
    pub reconnect_max_attempts: u32,
    #[serde(default)]
    pub root_path: Option<String>,
}

impl SshProfile {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("SSH profile id is required".into());
        }
        if self.host.trim().is_empty() || self.host.chars().any(char::is_whitespace) {
            return Err("SSH host is required and cannot contain whitespace".into());
        }
        if self.port == 0 {
            return Err("SSH port must be between 1 and 65535".into());
        }
        if self.username.trim().is_empty() {
            return Err("SSH username is required".into());
        }
        if self.auth_method == SshAuthMethod::PrivateKey
            && self
                .identity_file
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            return Err("A private-key path is required".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub profile: SshProfile,
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub proxy_secret: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub profile_id: String,
    pub status: ConnectionStatus,
    pub home: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub identity_file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: u64,
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub status: TunnelStatus,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub bytes: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEvent {
    pub kind: TunnelEventKind,
    pub profile_id: String,
    pub tunnel: Option<TunnelInfo>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelEventKind {
    Started,
    Updated,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelStatus {
    Starting,
    Active,
    Failed,
    Closed,
}

#[derive(Clone, Debug)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyKind {
    Socks5,
    Http,
    Https,
}

impl ProxyConfig {
    pub fn parse(value: &str, proxy_secret: Option<&str>) -> Result<Option<Self>, String> {
        let value = value.trim();
        if value.is_empty() {
            return Ok(None);
        }
        let (scheme, rest) = value
            .split_once("://")
            .ok_or_else(|| "proxy URL must include a scheme".to_string())?;
        let kind = match scheme.to_ascii_lowercase().as_str() {
            "socks" | "socks5" | "socks5h" => ProxyKind::Socks5,
            "http" => ProxyKind::Http,
            "https" => ProxyKind::Https,
            _ => return Err(format!("unsupported proxy scheme: {scheme}")),
        };
        let (auth, address) = rest
            .rsplit_once('@')
            .map_or((None, rest), |(a, v)| (Some(a), v));
        let (host, port) = split_host_port(address)?;
        let username = auth
            .map(|auth| auth.split_once(':').map_or(auth, |(user, _)| user))
            .filter(|user| !user.is_empty())
            .map(str::to_string);
        if auth
            .and_then(|auth| auth.split_once(':'))
            .is_some_and(|(_, password)| !password.is_empty())
        {
            return Err(
                "proxy URL must not contain a password; use the secure proxy-password field".into(),
            );
        }
        let password = proxy_secret
            .filter(|secret| !secret.is_empty())
            .map(str::to_string);
        if password.is_some() && username.is_none() {
            return Err("proxy username is required in the proxy URL".into());
        }
        Ok(Some(Self {
            kind,
            host,
            port,
            username,
            password,
        }))
    }
}

fn split_host_port(value: &str) -> Result<(String, u16), String> {
    let value = value.trim_end_matches('/');
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| "invalid bracketed proxy host".to_string())?;
        let port = tail
            .strip_prefix(':')
            .ok_or_else(|| "proxy port is required".to_string())?;
        (host, port)
    } else {
        value
            .rsplit_once(':')
            .ok_or_else(|| "proxy port is required".to_string())?
    };
    let port = port
        .parse::<u16>()
        .map_err(|_| "invalid proxy port".to_string())?;
    if host.is_empty() || port == 0 {
        return Err("invalid proxy host or port".into());
    }
    Ok((host.to_string(), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_authenticated_proxy() {
        let parsed = ProxyConfig::parse("socks5://alice@127.0.0.1:1080", Some("secret"))
            .unwrap()
            .unwrap();
        assert_eq!(parsed.kind, ProxyKind::Socks5);
        assert_eq!(parsed.username.as_deref(), Some("alice"));
        assert_eq!(parsed.port, 1080);
        assert_eq!(parsed.password.as_deref(), Some("secret"));
    }

    #[test]
    fn rejects_inline_proxy_password() {
        assert!(ProxyConfig::parse("http://alice:secret@proxy:8080", None).is_err());
    }

    #[test]
    fn rejects_empty_profile_fields() {
        let profile = SshProfile {
            id: String::new(),
            name: String::new(),
            host: String::new(),
            port: 22,
            username: String::new(),
            auth_method: SshAuthMethod::Password,
            identity_file: None,
            proxy_url: None,
            keepalive_seconds: 30,
            reconnect_enabled: false,
            reconnect_max_attempts: 5,
            root_path: None,
        };
        assert!(profile.validate().is_err());
    }
}
