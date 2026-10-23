//! 内置网络连接的显式代理配置与路由解析。
//!
//! 路由按稳定连接身份保存，每次请求读取最新配置；系统模式只读取静态代理，不继承环境代理。
//! 共享代理是用户信任的网络出口，凭据仅在原生层读取，不进入普通配置或请求 IPC。

use serde::{Deserialize, Serialize};

use crate::modules::{secrets, shared_store};

mod system;

/// 全局默认出口，系统模式不执行 PAC 或自动发现。
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GlobalProxyMode {
    #[default]
    System,
    Shared,
    Direct,
}

/// 连接显式选择的出口，缺失设置表示跟随全局设置。
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    #[default]
    Inherit,
    Direct,
    Shared,
}

/// SSH 可以在共享出口之外指定服务器专用代理。
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshProxyMode {
    #[default]
    Inherit,
    Direct,
    Shared,
    Custom,
}

/// HTTP 调用只声明所属连接，不允许通过 IPC 传入代理凭据。
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NetworkTarget {
    Direct,
    Provider { id: String },
    Channel { id: String },
    Speech { id: String },
    Markdown,
}

impl NetworkTarget {
    /// 将封闭目标类型转换成连接级设置键，限制无界或无效身份输入。
    fn key(&self) -> Result<Option<String>, String> {
        let (prefix, id) = match self {
            Self::Direct => return Ok(None),
            Self::Markdown => return Ok(Some("network.markdown".into())),
            Self::Provider { id } => ("provider", id),
            Self::Channel { id } => ("channel", id),
            Self::Speech { id } => ("speech", id),
        };
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
            return Err("invalid network connection identity".into());
        }
        Ok(Some(format!("network.{prefix}:{id}")))
    }
}

/// 协议传输共用的代理地址与仅驻留内存的认证数据。
#[derive(Clone)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// 单次请求持有出口快照；系统规则在重定向时仍按实际目标选择代理。
pub enum ResolvedRoute {
    Direct,
    Proxy(ProxyConfig),
    System(system::SystemProxy),
}

impl ResolvedRoute {
    pub fn apply(&self, builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder, String> {
        match self {
            Self::Direct => Ok(builder.no_proxy()),
            Self::Proxy(proxy) => proxy.apply(builder),
            Self::System(proxy) => proxy.apply(builder),
        }
    }

    /// SSH 优先使用系统 SOCKS，再通过系统 HTTPS 或 HTTP 代理建立 CONNECT 隧道。
    pub fn for_ssh(&self, host: &str, port: u16) -> Option<ProxyConfig> {
        match self {
            Self::Direct => None,
            Self::Proxy(proxy) => Some(proxy.clone()),
            Self::System(proxy) => proxy.for_destination("ssh", host, port).cloned(),
        }
    }
}

impl ProxyMode {
    fn effective(self, global: GlobalProxyMode) -> GlobalProxyMode {
        match self {
            Self::Inherit => global,
            Self::Direct => GlobalProxyMode::Direct,
            Self::Shared => GlobalProxyMode::Shared,
        }
    }
}

/// SOCKS5 统一由代理解析目标域名，HTTP 与 HTTPS 使用 CONNECT 或转发。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyKind {
    Socks5,
    Http,
    Https,
}

impl ProxyConfig {
    /// 严格解析代理 URL；密码只接受独立秘密字段，错误不包含输入地址。
    pub fn parse(value: &str, secret: Option<&str>) -> Result<Self, String> {
        if value.len() > 2048 {
            return Err("proxy URL is too long".into());
        }
        let url = reqwest::Url::parse(value.trim()).map_err(|_| "invalid proxy URL")?;
        let kind = match url.scheme() {
            "socks5" | "socks5h" => ProxyKind::Socks5,
            "http" => ProxyKind::Http,
            "https" => ProxyKind::Https,
            _ => return Err("unsupported proxy protocol".into()),
        };
        if url.password().is_some()
            || !matches!(url.path(), "" | "/")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("proxy URL cannot contain a password, path, query or fragment".into());
        }
        let host = url
            .host_str()
            .ok_or("proxy host is required")?
            .trim_matches(['[', ']'])
            .to_string();
        let port = url
            .port_or_known_default()
            .filter(|port| *port > 0)
            .ok_or("proxy port is required")?;
        let username = if url.username().is_empty() {
            None
        } else {
            Some(
                percent_encoding::percent_decode_str(url.username())
                    .decode_utf8()
                    .map_err(|_| "invalid proxy username")?
                    .into_owned(),
            )
        };
        let password = secret.filter(|value| !value.is_empty()).map(str::to_string);
        if password.is_some() && username.is_none() {
            return Err("proxy username is required when using a password".into());
        }
        Ok(Self {
            kind,
            host,
            port,
            username,
            password,
        })
    }

    /// 构造不包含用户信息的传输地址，认证通过客户端专用接口注入。
    pub fn endpoint(&self) -> String {
        let scheme = match self.kind {
            ProxyKind::Socks5 => "socks5h",
            ProxyKind::Http => "http",
            ProxyKind::Https => "https",
        };
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{scheme}://{host}:{}", self.port)
    }

    /// 凭据绑定规范出口与用户名，地址保存和密码更新交错时不会向其他代理泄露密码。
    pub fn credential_account(&self) -> String {
        use sha2::{Digest, Sha256};
        let identity = serde_json::to_vec(&(self.endpoint(), &self.username))
            .expect("proxy credential identity contains only strings");
        format!("proxy:{:x}", Sha256::digest(identity))
    }

    /// 设置唯一显式代理，客户端始终关闭自动环境代理。
    pub fn apply(&self, builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder, String> {
        let mut proxy =
            reqwest::Proxy::all(self.endpoint()).map_err(|_| "invalid proxy endpoint")?;
        if let Some(username) = &self.username {
            proxy = proxy.basic_auth(username, self.password.as_deref().unwrap_or(""));
        }
        Ok(builder.no_proxy().proxy(proxy))
    }
}

/// 使用宿主提供的秘密存储解析共享出口，不继承环境代理。
pub fn shared_proxy(state: &secrets::SecretsState) -> Result<ProxyConfig, String> {
    let url = shared_store::read_value::<String>("settings", "network.proxyUrl")?
        .filter(|value| !value.trim().is_empty())
        .ok_or("shared proxy is not configured")?;
    let mut proxy = ProxyConfig::parse(&url, None)?;
    if proxy.username.is_some() {
        proxy.password = secrets::get_value(state, "terax-network", &proxy.credential_account())?
            .filter(|value| !value.is_empty());
    }
    Ok(proxy)
}

/// 按连接身份读取最新出口配置，供桌面和无界面 HTTP 服务共用。
pub async fn resolve(
    state: &secrets::SecretsState,
    target: &NetworkTarget,
) -> Result<ResolvedRoute, String> {
    let Some(key) = target.key()? else {
        return Ok(ResolvedRoute::Direct);
    };
    let mode = shared_store::read_value::<ProxyMode>("settings", &key)?.unwrap_or_default();
    resolve_mode(state, mode).await
}

/// SSH 与 HTTP 共用全局解析，显式覆盖不读取无关的全局设置。
pub async fn resolve_mode(
    state: &secrets::SecretsState,
    mode: ProxyMode,
) -> Result<ResolvedRoute, String> {
    let global = if mode == ProxyMode::Inherit {
        shared_store::read_value::<GlobalProxyMode>("settings", "network.mode")?.unwrap_or_default()
    } else {
        GlobalProxyMode::Direct
    };
    match mode.effective(global) {
        GlobalProxyMode::Direct => Ok(ResolvedRoute::Direct),
        GlobalProxyMode::Shared => shared_proxy(state).map(ResolvedRoute::Proxy),
        GlobalProxyMode::System => system::read().await.map(ResolvedRoute::System),
    }
}

/// 保存前验证共享地址并返回凭据账户标识，秘密不会经此入口返回前端。
pub fn network_validate_proxy(url: String) -> Result<String, String> {
    ProxyConfig::parse(&url, None).map(|proxy| proxy.credential_account())
}

/// 供设置窗口恢复焦点时刷新目录缓存，不返回系统代理地址或凭据。
pub async fn network_system_proxy_revision() -> Result<String, String> {
    system::read().await.map(|proxy| proxy.revision())
}

/// 通用共享存储写入也必须通过校验，防止绕过设置页把秘密写入普通配置。
pub(crate) fn validate_setting(key: &str, value: &serde_json::Value) -> Result<(), String> {
    if key == "mode" {
        serde_json::from_value::<GlobalProxyMode>(value.clone())
            .map_err(|_| "invalid global network proxy mode".to_string())?;
        return Ok(());
    }
    if key == "proxyUrl" {
        let url = value.as_str().ok_or("proxy URL must be a string")?;
        if !url.is_empty() {
            ProxyConfig::parse(url, None)?;
        }
        return Ok(());
    }
    if key != "markdown"
        && !["provider:", "channel:", "speech:"].iter().any(|prefix| {
            key.strip_prefix(prefix).is_some_and(|id| {
                !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
            })
        })
    {
        return Err("invalid network setting key".into());
    }
    serde_json::from_value::<ProxyMode>(value.clone())
        .map_err(|_| "invalid network proxy mode".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_routes_override_every_global_mode_and_missing_routes_inherit() {
        for global in [
            GlobalProxyMode::System,
            GlobalProxyMode::Shared,
            GlobalProxyMode::Direct,
        ] {
            assert_eq!(ProxyMode::default().effective(global), global);
            assert_eq!(ProxyMode::Direct.effective(global), GlobalProxyMode::Direct);
            assert_eq!(ProxyMode::Shared.effective(global), GlobalProxyMode::Shared);
        }
        assert_eq!(SshProxyMode::default(), SshProxyMode::Inherit);
        assert!(validate_setting("mode", &serde_json::json!("system")).is_ok());
        assert!(validate_setting("provider:one", &serde_json::json!("inherit")).is_ok());
        assert!(validate_setting("mode", &serde_json::json!("inherit")).is_err());
        assert!(validate_setting("provider:one", &serde_json::json!("system")).is_err());
    }

    #[test]
    fn credentials_are_scoped_to_the_proxy_endpoint_not_the_current_password() {
        let first = ProxyConfig::parse("http://alice@proxy.example:8080", Some("first")).unwrap();
        let rotated =
            ProxyConfig::parse("http://alice@proxy.example:8080/", Some("rotated")).unwrap();
        let other = ProxyConfig::parse("http://alice@other.example:8080", Some("first")).unwrap();
        assert_eq!(first.credential_account(), rotated.credential_account());
        assert_ne!(first.credential_account(), other.credential_account());
    }

    #[test]
    fn proxy_configuration_rejects_inline_secrets_and_non_endpoints() {
        for url in [
            "http://alice:secret@localhost:8080",
            "http://localhost:8080/path",
            "http://localhost:8080?x=y",
            "ftp://localhost:21",
        ] {
            assert!(ProxyConfig::parse(url, None).is_err());
        }
        let proxy = ProxyConfig::parse("socks5://alice@[::1]:1080", Some("secret")).unwrap();
        assert_eq!(proxy.endpoint(), "socks5h://[::1]:1080");
        assert_eq!(proxy.password.as_deref(), Some("secret"));
        assert!(ProxyConfig::parse("http://localhost:8080", Some("secret")).is_err());
    }
}
