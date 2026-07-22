//! SSH 配置、连接和隧道的跨进程数据模型。
//!
//! 本模块定义写入共享 SSH profile 存储的持久化隧道，以及仅在当前
//! Workspace 进程中有效的运行时隧道信息。持久化 ID 与运行时 ID 分离，
//! 避免窗口重启后将旧的网络资源标识误作有效状态。

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

fn default_tunnel_enabled() -> bool {
    true
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
/// 可由多个 Workspace 进程共享的 SSH 连接配置。
///
/// `tunnels` 仅保存持久化定义和启用意图，实际 socket 与流量状态由当前进程管理。
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
    #[serde(default)]
    pub tunnels: Vec<SshTunnel>,
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
        if !(1..=20).contains(&self.reconnect_max_attempts) {
            return Err("SSH reconnect attempts must be between 1 and 20".into());
        }
        Ok(())
    }

    /// 返回当前连接成功后应自动启动的隧道配置。
    ///
    /// 关闭项保留在 profile 中以供后续编辑，但不会占用本地或远端端口。
    pub fn enabled_tunnel_configs(&self) -> Vec<TunnelConfig> {
        self.tunnels
            .iter()
            .filter(|tunnel| tunnel.enabled)
            .map(|tunnel| tunnel.config(&self.id))
            .collect()
    }
}

/// SSH profile 中持久化的一条隧道配置。
///
/// `id` 在配置保存后保持不变，用于将启动后的运行时状态关联回这条配置。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnel {
    pub id: String,
    #[serde(default = "default_tunnel_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub name: String,
    pub kind: TunnelKind,
    #[serde(default)]
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
}

impl SshTunnel {
    /// 转换为当前 SSH profile 可直接启动的运行时配置。
    pub fn config(&self, profile_id: &str) -> TunnelConfig {
        TunnelConfig {
            config_id: self.id.clone(),
            profile_id: profile_id.to_string(),
            name: self.name.clone(),
            kind: self.kind,
            bind_host: self.bind_host.clone(),
            bind_port: self.bind_port,
            target_host: self.target_host.clone(),
            target_port: self.target_port,
        }
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// 启动隧道所需的当前 profile 运行时配置。
///
/// `config_id` 对应持久化配置，`profile_id` 限定当前 SSH Workspace，二者均不等同于运行时 ID。
pub struct TunnelConfig {
    pub config_id: String,
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
/// 当前进程中一条隧道的可观测状态。
///
/// `id` 只用于停止或更新此进程内的资源，`config_id` 用于关联持久化列表项。
pub struct TunnelInfo {
    pub id: u64,
    pub config_id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub status: TunnelStatus,
    pub bind_host: String,
    pub bind_port: u16,
    pub requested_bind_port: u16,
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
    fn rejects_profile_values_outside_the_supported_contract() {
        let mut profile = SshProfile {
            id: "profile-1".into(),
            name: "server".into(),
            host: "example.com".into(),
            port: 22,
            username: "alice".into(),
            auth_method: SshAuthMethod::Password,
            identity_file: None,
            proxy_url: None,
            keepalive_seconds: 30,
            reconnect_enabled: false,
            reconnect_max_attempts: 5,
            root_path: None,
            tunnels: Vec::new(),
        };

        profile.host = "example .com".into();
        assert_eq!(
            profile.validate().unwrap_err(),
            "SSH host is required and cannot contain whitespace"
        );
        profile.host = "example.com".into();
        for attempts in [0, 21] {
            profile.reconnect_max_attempts = attempts;
            assert_eq!(
                profile.validate().unwrap_err(),
                "SSH reconnect attempts must be between 1 and 20"
            );
        }
    }

    #[test]
    fn profile_tunnel_defaults_to_enabled_and_only_enabled_configs_start() {
        let profile: SshProfile = serde_json::from_value(serde_json::json!({
            "id": "profile-1",
            "name": "server",
            "host": "example.com",
            "username": "alice",
            "authMethod": "agent",
            "tunnels": [
                {
                    "id": "tunnel-db",
                    "kind": "local",
                    "bindHost": "127.0.0.1",
                    "bindPort": 5432,
                    "targetHost": "db.internal",
                    "targetPort": 5432
                },
                {
                    "id": "tunnel-off",
                    "enabled": false,
                    "kind": "dynamic",
                    "bindPort": 1080
                }
            ]
        }))
        .unwrap();

        assert!(profile.tunnels[0].enabled);
        assert_eq!(
            profile.enabled_tunnel_configs(),
            vec![TunnelConfig {
                config_id: "tunnel-db".into(),
                profile_id: "profile-1".into(),
                name: "".into(),
                kind: TunnelKind::Local,
                bind_host: "127.0.0.1".into(),
                bind_port: 5432,
                target_host: "db.internal".into(),
                target_port: 5432,
            }]
        );
    }
}
