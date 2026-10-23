//! SSH 配置、连接健康、服务器能力、流量和隧道的跨进程数据模型。
//!
//! 本模块定义写入共享 SSH profile 存储的持久化隧道，以及仅在当前
//! Workspace 进程中有效的运行时隧道信息。持久化 ID 与运行时 ID 分离，
//! 避免窗口重启后将旧的网络资源标识误作有效状态。

use crate::modules::network_proxy::{ProxyConfig, SshProxyMode};
use serde::{Deserialize, Serialize};

fn default_port() -> u16 {
    22
}

fn default_reconnect_attempts() -> u32 {
    2
}

fn default_tunnel_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// SSH profile 支持的认证方式。
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
    #[serde(default)]
    pub proxy_mode: SshProxyMode,
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
    /// 校验进入原生 SSH 边界的持久化连接参数。
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
        if self.proxy_mode == SshProxyMode::Custom {
            crate::modules::network_proxy::ProxyConfig::parse(
                self.proxy_url.as_deref().unwrap_or(""),
                None,
            )?;
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

    /// 返回决定 Workspace 进程身份的不可变 SSH endpoint。
    pub fn endpoint_key(&self) -> String {
        format!(
            "ssh:{}:{}:{}",
            self.host.to_ascii_lowercase(),
            self.port,
            self.username
        )
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

/// 建立 Runtime 所需的 profile 与仅驻留内存的凭据。
#[derive(Clone, Debug)]
pub struct ConnectRequest {
    pub profile: SshProfile,
    pub secret: Option<String>,
    /// 仅当前生命周期使用的代理密码，不代替每次连接时读取的持久化凭据。
    pub proxy_secret_override: Option<String>,
}

impl ConnectRequest {
    /// 重连仅刷新代理字段；一次性密码只可复用到同一代理身份，不能携带到新出口。
    pub fn refresh_proxy(&mut self, latest: &SshProfile) -> Result<(), String> {
        if self.profile.id != latest.id {
            return Err("SSH reconnect profile identity changed".into());
        }
        let keep_override = self.proxy_secret_override.is_some()
            && self.profile.proxy_mode == SshProxyMode::Custom
            && latest.proxy_mode == SshProxyMode::Custom
            && ProxyConfig::parse(self.profile.proxy_url.as_deref().unwrap_or(""), None)?
                .credential_account()
                == ProxyConfig::parse(latest.proxy_url.as_deref().unwrap_or(""), None)?
                    .credential_account();
        if !keep_override {
            self.proxy_secret_override = None;
        }
        self.profile.proxy_mode = latest.proxy_mode;
        self.profile.proxy_url = latest.proxy_url.clone();
        Ok(())
    }
}

/// 当前应用进程经 SSH transport 传输的累计字节数。
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTrafficSnapshot {
    pub uploaded_bytes: u64,
    pub downloaded_bytes: u64,
}

/// 当前 SSH epoch 中一个已回退任务及其稳定原因。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTaskFallback {
    pub task: String,
    pub reason: String,
}

/// 当前进程 SSH transport 的低频 RTT 与内部任务降级状态。
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshHealthSnapshot {
    pub epoch: Option<u64>,
    pub rtt_ms: Option<u64>,
    pub sampled_at: Option<u64>,
    pub file_write_fallback: bool,
    pub task_fallbacks: Vec<SshTaskFallback>,
}

/// SSH 能力探测、功能后端和命令检查共用的状态等级。
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshCapabilityState {
    /// 当前 epoch 尚未完成探测。
    #[default]
    Unknown,
    /// 探测正在后台执行。
    Checking,
    /// 首选服务端快速路径可用。
    Ready,
    /// 功能可用，但正在使用次级或 SFTP 后端。
    Fallback,
    /// 当前连接没有安全可用的实现。
    Unavailable,
}

/// 实际命令及参数组合的就绪状态。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshCommandCapabilityState {
    Ready,
    Missing,
    Unsupported,
}

/// 一个实际命令及所需参数组合的探测结果。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandCapability {
    pub id: String,
    pub command: String,
    pub state: SshCommandCapabilityState,
    pub detail: Option<String>,
}

/// 一个用户可感知 SSH 功能的后端选择结果。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshFeatureCapability {
    pub id: String,
    pub state: SshCapabilityState,
    pub backend: Option<String>,
    pub commands: Vec<String>,
}

/// 当前 SSH epoch 的统一服务器能力快照。
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshCapabilitySnapshot {
    pub epoch: Option<u64>,
    pub state: SshCapabilityState,
    pub checked_at: Option<u64>,
    pub commands: Vec<SshCommandCapability>,
    pub features: Vec<SshFeatureCapability>,
}

/// 前端凭据对话框对本次连接提供的临时覆盖值。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialOverride {
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub proxy_secret: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
/// 启动阶段需要优先准备的前台资源。
pub enum ForegroundIntent {
    Terminal {
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        blocks: bool,
    },
    Explorer,
    None,
}

/// 当前进程唯一 SSH Runtime 的权威状态快照。
///
/// `version` 在每次状态迁移时递增，前端据此拒绝迟到事件；`epoch` 只在新 transport
/// 完整通过 shell 与 Workspace root 探测后递增，用于失效旧的终端和文件请求。
/// `reconnecting` 表示快速自动恢复，`disconnected` 表示当前不可用；网络故障时仍可低频重试。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RemoteRuntimeSnapshot {
    Idle {
        version: u64,
    },
    Connecting {
        version: u64,
        profile_id: String,
    },
    Reconnecting {
        version: u64,
        profile_id: String,
    },
    Connected {
        version: u64,
        epoch: u64,
        profile_id: String,
        home: String,
    },
    Disconnected {
        version: u64,
        profile_id: String,
        reason: String,
        credentials_required: bool,
    },
}

impl RemoteRuntimeSnapshot {
    /// 返回快照的单调版本号。
    pub fn version(&self) -> u64 {
        match self {
            Self::Idle { version }
            | Self::Connecting { version, .. }
            | Self::Reconnecting { version, .. }
            | Self::Connected { version, .. }
            | Self::Disconnected { version, .. } => *version,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// 从 OpenSSH 配置中读取的一条可导入主机记录。
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_refreshes_only_network_settings_and_scopes_temporary_credentials() {
        let profile: SshProfile = serde_json::from_value(serde_json::json!({
            "id": "server", "name": "Server", "host": "original.example", "port": 22,
            "username": "original-user", "authMethod": "password", "rootPath": "/workspace",
            "proxyMode": "custom", "proxyUrl": "http://alice@proxy.example:8080"
        }))
        .unwrap();
        let mut request = ConnectRequest {
            profile: profile.clone(),
            secret: Some("login-secret".into()),
            proxy_secret_override: Some("temporary-proxy-secret".into()),
        };
        let mut latest = profile;
        latest.host = "changed.example".into();
        latest.username = "changed-user".into();
        latest.root_path = Some("/other".into());
        latest.proxy_url = Some("http://alice@proxy.example:8080/".into());
        request.refresh_proxy(&latest).unwrap();
        assert_eq!(
            request.proxy_secret_override.as_deref(),
            Some("temporary-proxy-secret")
        );
        latest.proxy_url = Some("http://alice@new-proxy.example:8080".into());
        request.refresh_proxy(&latest).unwrap();
        assert!(request.proxy_secret_override.is_none());
        assert_eq!(request.profile.proxy_url, latest.proxy_url);
        assert_eq!(request.profile.host, "original.example");
        assert_eq!(request.profile.username, "original-user");
        assert_eq!(request.profile.root_path.as_deref(), Some("/workspace"));
        assert_eq!(request.secret.as_deref(), Some("login-secret"));
        latest.proxy_mode = SshProxyMode::Shared;
        latest.proxy_url = None;
        request.refresh_proxy(&latest).unwrap();
        assert_eq!(request.profile.proxy_mode, SshProxyMode::Shared);
        latest.proxy_mode = SshProxyMode::Direct;
        request.refresh_proxy(&latest).unwrap();
        assert_eq!(request.profile.proxy_mode, SshProxyMode::Direct);
        latest.proxy_mode = SshProxyMode::Inherit;
        request.refresh_proxy(&latest).unwrap();
        assert_eq!(request.profile.proxy_mode, SshProxyMode::Inherit);
        assert_eq!(request.profile.host, "original.example");
    }

    #[test]
    fn foreground_terminal_intent_uses_the_ipc_contract() {
        let intent: ForegroundIntent = serde_json::from_value(serde_json::json!({
            "kind": "terminal",
            "cwd": "/srv/project",
            "blocks": true
        }))
        .unwrap();

        assert_eq!(
            intent,
            ForegroundIntent::Terminal {
                cwd: Some("/srv/project".to_string()),
                blocks: true
            }
        );
    }

    #[test]
    fn runtime_snapshot_serializes_one_monotonic_state_contract() {
        let snapshot = RemoteRuntimeSnapshot::Connected {
            version: 7,
            epoch: 3,
            profile_id: "server".into(),
            home: "/home/alice".into(),
        };

        assert_eq!(snapshot.version(), 7);
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            serde_json::json!({
                "phase": "connected",
                "version": 7,
                "epoch": 3,
                "profileId": "server",
                "home": "/home/alice"
            })
        );

        assert_eq!(
            serde_json::to_value(RemoteRuntimeSnapshot::Reconnecting {
                version: 8,
                profile_id: "server".into(),
            })
            .unwrap(),
            serde_json::json!({
                "phase": "reconnecting",
                "version": 8,
                "profileId": "server"
            })
        );

        assert_eq!(
            serde_json::to_value(RemoteRuntimeSnapshot::Disconnected {
                version: 9,
                profile_id: "server".into(),
                reason: "authentication failed".into(),
                credentials_required: true,
            })
            .unwrap(),
            serde_json::json!({
                "phase": "disconnected",
                "version": 9,
                "profileId": "server",
                "reason": "authentication failed",
                "credentialsRequired": true
            })
        );
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
            proxy_mode: crate::modules::network_proxy::SshProxyMode::Direct,
            reconnect_enabled: false,
            reconnect_max_attempts: 2,
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
    fn credential_override_preserves_explicit_missing_values() {
        let credentials: CredentialOverride = serde_json::from_value(serde_json::json!({
            "secret": null,
            "proxySecret": "proxy-password"
        }))
        .unwrap();

        assert!(credentials.secret.is_none());
        assert_eq!(credentials.proxy_secret.as_deref(), Some("proxy-password"));
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

        assert_eq!(profile.reconnect_max_attempts, 2);
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
