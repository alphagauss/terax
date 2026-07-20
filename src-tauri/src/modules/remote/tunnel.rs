//! Local, remote and dynamic SSH forwarding.
//!
//! Local/Dynamic forwarding is adapted from meatshell `forward.rs`; lifecycle
//! and public DTO separation follows CrabPort's tunnel crate.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex as AsyncMutex, RwLock};

use super::models::{TunnelConfig, TunnelInfo, TunnelKind, TunnelStatus};
use super::session::RemoteWorkspace;

#[derive(Clone, Debug)]
pub struct LocalTarget {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Default)]
pub struct RemoteForwardRegistry {
    inner: Arc<Mutex<HashMap<(String, u32), LocalTarget>>>,
}

impl RemoteForwardRegistry {
    pub fn insert(&self, address: String, port: u32, target: LocalTarget) {
        self.inner.lock().unwrap().insert((address, port), target);
    }

    pub fn remove(&self, address: &str, port: u32) {
        self.inner
            .lock()
            .unwrap()
            .remove(&(address.to_string(), port));
    }

    pub fn lookup(&self, address: &str, port: u32) -> Option<LocalTarget> {
        let inner = self.inner.lock().unwrap();
        if let Some(target) = inner.get(&(address.to_string(), port)) {
            return Some(target.clone());
        }
        // Some servers normalize the requested bind address before reporting
        // it back. Fall back by port only when that port identifies one target;
        // choosing arbitrarily would misroute two same-port remote forwards.
        let mut matches = inner
            .iter()
            .filter(|((_, value), _)| *value == port)
            .map(|(_, target)| target);
        let target = matches.next()?;
        matches.next().is_none().then(|| target.clone())
    }
}

struct TunnelRuntime {
    info: TunnelInfo,
    config: TunnelConfig,
    bytes: Arc<AtomicU64>,
    task: Option<JoinHandle<()>>,
}

pub struct TunnelManager {
    next_id: AtomicU64,
    tunnels: RwLock<HashMap<u64, TunnelRuntime>>,
    operation_lock: AsyncMutex<()>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            tunnels: RwLock::new(HashMap::new()),
            operation_lock: AsyncMutex::new(()),
        }
    }
}

impl TunnelManager {
    pub async fn start(
        &self,
        workspace: Arc<RemoteWorkspace>,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, String> {
        let _operation = self.operation_lock.lock().await;
        self.start_unlocked(workspace, config).await
    }

    async fn start_unlocked(
        &self,
        workspace: Arc<RemoteWorkspace>,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, String> {
        validate(&config)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let bytes = Arc::new(AtomicU64::new(0));
        let mut info = TunnelInfo {
            id,
            profile_id: config.profile_id.clone(),
            name: config.name.clone(),
            kind: config.kind,
            status: TunnelStatus::Starting,
            bind_host: normalized_bind(&config.bind_host).to_string(),
            bind_port: config.bind_port,
            target_host: config.target_host.clone(),
            target_port: config.target_port,
            bytes: 0,
            error: None,
        };

        let task = match config.kind {
            TunnelKind::Local => {
                let listener = bind_listener(&info.bind_host, info.bind_port).await?;
                info.bind_port = listener.local_addr().map_err(|e| e.to_string())?.port();
                let workspace = workspace.clone();
                let target_host = config.target_host.clone();
                let target_port = config.target_port;
                let bytes = bytes.clone();
                Some(tauri::async_runtime::spawn(async move {
                    while let Ok((mut inbound, peer)) = listener.accept().await {
                        let workspace = workspace.clone();
                        let target_host = target_host.clone();
                        let bytes = bytes.clone();
                        tauri::async_runtime::spawn(async move {
                            let channel = {
                                let handle = workspace.handle.lock().await;
                                handle
                                    .channel_open_direct_tcpip(
                                        target_host,
                                        target_port as u32,
                                        peer.ip().to_string(),
                                        peer.port() as u32,
                                    )
                                    .await
                            };
                            if let Ok(channel) = channel {
                                let mut remote = channel.into_stream();
                                if let Ok((up, down)) =
                                    tokio::io::copy_bidirectional(&mut inbound, &mut remote).await
                                {
                                    bytes.fetch_add(up + down, Ordering::Relaxed);
                                }
                            }
                        });
                    }
                }))
            }
            TunnelKind::Dynamic => {
                let listener = bind_listener(&info.bind_host, info.bind_port).await?;
                info.bind_port = listener.local_addr().map_err(|e| e.to_string())?.port();
                let workspace = workspace.clone();
                let bytes = bytes.clone();
                Some(tauri::async_runtime::spawn(async move {
                    while let Ok((inbound, peer)) = listener.accept().await {
                        let workspace = workspace.clone();
                        let bytes = bytes.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Ok(count) = socks5_serve(workspace, inbound, peer).await {
                                bytes.fetch_add(count, Ordering::Relaxed);
                            }
                        });
                    }
                }))
            }
            TunnelKind::Remote => {
                let port = {
                    let handle = workspace.handle.lock().await;
                    handle
                        .tcpip_forward(info.bind_host.clone(), info.bind_port as u32)
                        .await
                        .map_err(|e| format!("start remote forward: {e}"))?
                };
                let actual = if info.bind_port == 0 {
                    u16::try_from(port).map_err(|_| {
                        format!("server returned invalid remote-forward port {port}")
                    })?
                } else {
                    info.bind_port
                };
                info.bind_port = actual;
                workspace.remote_forwards.insert(
                    info.bind_host.clone(),
                    actual as u32,
                    LocalTarget {
                        host: config.target_host.clone(),
                        port: config.target_port,
                    },
                );
                None
            }
        };
        info.status = TunnelStatus::Active;
        self.tunnels.write().await.insert(
            id,
            TunnelRuntime {
                info: info.clone(),
                config,
                bytes,
                task,
            },
        );
        Ok(info)
    }

    pub async fn stop(
        &self,
        id: u64,
        workspace: Option<Arc<RemoteWorkspace>>,
    ) -> Result<Option<TunnelInfo>, String> {
        let _operation = self.operation_lock.lock().await;
        self.stop_unlocked(id, workspace).await
    }

    async fn stop_unlocked(
        &self,
        id: u64,
        workspace: Option<Arc<RemoteWorkspace>>,
    ) -> Result<Option<TunnelInfo>, String> {
        let Some(mut runtime) = self.tunnels.write().await.remove(&id) else {
            return Ok(None);
        };
        if let Some(task) = runtime.task.take() {
            task.abort();
        }
        if runtime.info.kind == TunnelKind::Remote {
            if let Some(workspace) = workspace {
                workspace
                    .remote_forwards
                    .remove(&runtime.info.bind_host, runtime.info.bind_port as u32);
                let handle = workspace.handle.lock().await;
                let _ = handle
                    .cancel_tcpip_forward(
                        runtime.info.bind_host.clone(),
                        runtime.info.bind_port as u32,
                    )
                    .await;
            }
        }
        Ok(Some(runtime.info))
    }

    pub async fn list(&self, profile_id: Option<&str>) -> Vec<TunnelInfo> {
        let tunnels = self.tunnels.read().await;
        let mut result: Vec<_> = tunnels
            .values()
            .filter(|runtime| profile_id.is_none_or(|id| runtime.info.profile_id == id))
            .map(|runtime| {
                let mut info = runtime.info.clone();
                info.bytes = runtime.bytes.load(Ordering::Relaxed);
                info
            })
            .collect();
        result.sort_by_key(|info| info.id);
        result
    }

    pub async fn active_configs(&self, profile_id: &str) -> Vec<TunnelConfig> {
        self.tunnels
            .read()
            .await
            .values()
            .filter(|runtime| runtime.info.profile_id == profile_id)
            .map(|runtime| runtime.config.clone())
            .collect()
    }

    pub async fn config(&self, id: u64) -> Option<TunnelConfig> {
        self.tunnels
            .read()
            .await
            .get(&id)
            .map(|runtime| runtime.config.clone())
    }

    pub async fn info(&self, id: u64) -> Option<TunnelInfo> {
        self.tunnels.read().await.get(&id).map(|runtime| {
            let mut info = runtime.info.clone();
            info.bytes = runtime.bytes.load(Ordering::Relaxed);
            info
        })
    }

    pub async fn replace(
        &self,
        id: u64,
        workspace: Arc<RemoteWorkspace>,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, String> {
        validate(&config)?;
        let _operation = self.operation_lock.lock().await;
        let previous = self
            .config(id)
            .await
            .ok_or_else(|| format!("SSH tunnel {id} was not found"))?;
        if previous.profile_id != config.profile_id {
            return Err("SSH tunnel profile cannot be changed".into());
        }
        self.stop_unlocked(id, Some(workspace.clone())).await?;
        match self.start_unlocked(workspace.clone(), config).await {
            Ok(tunnel) => Ok(tunnel),
            Err(error) => match self.start_unlocked(workspace, previous).await {
                Ok(_) => Err(format!("{error}. The previous tunnel was restored.")),
                Err(restore_error) => Err(format!(
                    "{error}. The previous tunnel could not be restored: {restore_error}"
                )),
            },
        }
    }

    pub async fn stop_profile(
        &self,
        profile_id: &str,
        workspace: Arc<RemoteWorkspace>,
    ) -> Vec<TunnelInfo> {
        let _operation = self.operation_lock.lock().await;
        let ids: Vec<u64> = self
            .tunnels
            .read()
            .await
            .iter()
            .filter_map(|(id, runtime)| (runtime.info.profile_id == profile_id).then_some(*id))
            .collect();
        let mut stopped = Vec::new();
        for id in ids {
            if let Ok(Some(info)) = self.stop_unlocked(id, Some(workspace.clone())).await {
                stopped.push(info);
            }
        }
        stopped
    }
}

fn validate(config: &TunnelConfig) -> Result<(), String> {
    if config.profile_id.trim().is_empty() {
        return Err("tunnel profile is required".into());
    }
    if config.name.trim().is_empty() {
        return Err("tunnel name is required".into());
    }
    if config.bind_host.trim().chars().any(char::is_whitespace) {
        return Err("tunnel bind host cannot contain whitespace".into());
    }
    if config.kind != TunnelKind::Dynamic
        && (config.target_host.trim().is_empty() || config.target_port == 0)
    {
        return Err("tunnel target host and port are required".into());
    }
    Ok(())
}

fn normalized_bind(bind: &str) -> &str {
    if bind.trim().is_empty() {
        "127.0.0.1"
    } else {
        bind.trim()
    }
}

async fn bind_listener(host: &str, port: u16) -> Result<TcpListener, String> {
    TcpListener::bind((host, port))
        .await
        .map_err(|e| format!("bind {host}:{port}: {e}"))
}

async fn socks5_serve(
    workspace: Arc<RemoteWorkspace>,
    mut inbound: TcpStream,
    peer: SocketAddr,
) -> Result<u64, String> {
    let mut greeting = [0u8; 2];
    inbound
        .read_exact(&mut greeting)
        .await
        .map_err(|e| e.to_string())?;
    if greeting[0] != 5 {
        return Err("not a SOCKS5 client".into());
    }
    let mut methods = vec![0; greeting[1] as usize];
    inbound
        .read_exact(&mut methods)
        .await
        .map_err(|e| e.to_string())?;
    if !methods.contains(&0) {
        let _ = inbound.write_all(&[5, 0xff]).await;
        return Err("SOCKS5 client did not offer no-authentication mode".into());
    }
    inbound
        .write_all(&[5, 0])
        .await
        .map_err(|e| e.to_string())?;

    let mut request = [0u8; 4];
    inbound
        .read_exact(&mut request)
        .await
        .map_err(|e| e.to_string())?;
    if request[0] != 5 || request[1] != 1 {
        let _ = inbound.write_all(&socks_reply(7)).await;
        return Err("unsupported SOCKS command".into());
    }
    let host = match request[3] {
        1 => {
            let mut address = [0; 4];
            inbound
                .read_exact(&mut address)
                .await
                .map_err(|e| e.to_string())?;
            Ipv4Addr::from(address).to_string()
        }
        4 => {
            let mut address = [0; 16];
            inbound
                .read_exact(&mut address)
                .await
                .map_err(|e| e.to_string())?;
            Ipv6Addr::from(address).to_string()
        }
        3 => {
            let mut length = [0; 1];
            inbound
                .read_exact(&mut length)
                .await
                .map_err(|e| e.to_string())?;
            let mut domain = vec![0; length[0] as usize];
            inbound
                .read_exact(&mut domain)
                .await
                .map_err(|e| e.to_string())?;
            String::from_utf8(domain).map_err(|_| "invalid SOCKS domain".to_string())?
        }
        _ => {
            let _ = inbound.write_all(&socks_reply(8)).await;
            return Err("unsupported SOCKS address type".into());
        }
    };
    let mut port = [0; 2];
    inbound
        .read_exact(&mut port)
        .await
        .map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(port);
    let channel = {
        let handle = workspace.handle.lock().await;
        handle
            .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
            .await
            .map_err(|e| e.to_string())?
    };
    inbound
        .write_all(&socks_reply(0))
        .await
        .map_err(|e| e.to_string())?;
    let mut remote = channel.into_stream();
    let (up, down) = tokio::io::copy_bidirectional(&mut inbound, &mut remote)
        .await
        .map_err(|e| e.to_string())?;
    Ok(up + down)
}

fn socks_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(kind: TunnelKind) -> TunnelConfig {
        TunnelConfig {
            profile_id: "ssh-prod".to_string(),
            name: "App".to_string(),
            kind,
            bind_host: "127.0.0.1".to_string(),
            bind_port: 3000,
            target_host: "app.internal".to_string(),
            target_port: 8080,
        }
    }

    #[test]
    fn dynamic_tunnels_do_not_need_a_target() {
        let mut tunnel = config(TunnelKind::Dynamic);
        tunnel.target_host.clear();
        tunnel.target_port = 0;
        assert!(validate(&tunnel).is_ok());
    }

    #[test]
    fn forwarding_tunnels_need_a_target_and_name() {
        let mut tunnel = config(TunnelKind::Local);
        tunnel.target_port = 0;
        assert!(validate(&tunnel).is_err());
        tunnel.target_port = 8080;
        tunnel.name.clear();
        assert!(validate(&tunnel).is_err());
    }
}
