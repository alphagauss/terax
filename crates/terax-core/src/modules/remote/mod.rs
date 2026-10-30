//! SSH Runtime、远端文件系统、终端和隧道的原生实现。
//!
//! 当前 Workspace 进程独占一条 transport；profile、凭据和连接状态均由 Rust 管理，
//! WebView 只提交稳定 profile ID 或一次性凭据覆盖值。

pub(crate) mod channels;
pub(crate) mod file_service;
mod health;
pub mod host_key;
pub mod manager;
pub mod models;
pub(crate) mod mutation_service;
pub mod profile;
mod proxy;
mod remote_fs;
pub mod session;
pub mod sftp;
pub mod ssh_config;
pub(crate) mod tasks;
pub mod terminal;
mod traffic;
pub(crate) mod tree_service;
pub mod tunnel;

pub use manager::RemoteState;

/// SSH 宿主提供事件出口与共享秘密存储，重连时仍读取最新凭据。
#[derive(Clone)]
pub struct RemoteHost {
    pub events: crate::events::EventSink,
    pub secrets: crate::modules::secrets::SecretsState,
}

/// 显式刷新当前连接的服务器能力，仍使用连接级缓存和事件出口。
pub async fn probe_capabilities(
    workspace: &std::sync::Arc<session::RemoteWorkspace>,
    refresh: bool,
) -> Result<models::SshCapabilitySnapshot, String> {
    tasks::capability_probe::probe(workspace, refresh).await
}
