//! Local, remote and dynamic SSH forwarding.
//!
//! Local/Dynamic forwarding is adapted from meatshell `forward.rs`; lifecycle
//! and public DTO separation follows CrabPort's tunnel crate.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex as AsyncMutex, RwLock};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::models::{TunnelConfig, TunnelInfo, TunnelKind, TunnelStatus};
use super::session::RemoteWorkspace;

#[derive(Clone, Debug)]
pub(super) struct LocalTarget {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) bytes: Arc<AtomicU64>,
    pub(super) connections: TunnelConnections,
}

#[derive(Clone, Default)]
pub(super) struct RemoteForwardRegistry {
    inner: Arc<Mutex<HashMap<(String, u32), LocalTarget>>>,
}

impl RemoteForwardRegistry {
    pub(super) fn insert(&self, address: String, port: u32, target: LocalTarget) {
        self.inner.lock().unwrap().insert((address, port), target);
    }

    pub(super) fn remove(&self, address: &str, port: u32) {
        self.inner
            .lock()
            .unwrap()
            .remove(&(address.to_string(), port));
    }

    pub(super) fn lookup(&self, address: &str, port: u32) -> Option<LocalTarget> {
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

#[derive(Clone, Debug)]
pub(super) struct TunnelConnections {
    cancel: CancellationToken,
    tasks: TaskTracker,
    accepting: Arc<Mutex<bool>>,
}

impl Default for TunnelConnections {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            tasks: TaskTracker::new(),
            accepting: Arc::new(Mutex::new(true)),
        }
    }
}

impl TunnelConnections {
    pub(super) fn spawn<F>(&self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let accepting = self.accepting.lock().unwrap();
        if !*accepting {
            return;
        }
        let cancel = self.cancel.clone();
        let _task = self.tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                _ = task => {}
            }
        });
    }

    async fn cancelled(&self) {
        self.cancel.cancelled().await;
    }

    fn cancel(&self) {
        let mut accepting = self.accepting.lock().unwrap();
        *accepting = false;
        self.cancel.cancel();
        self.tasks.close();
    }

    async fn wait(&self) {
        self.tasks.wait().await;
    }
}

struct CountingStream<S> {
    inner: S,
    bytes: Arc<AtomicU64>,
}

impl<S> CountingStream<S> {
    fn new(inner: S, bytes: Arc<AtomicU64>) -> Self {
        Self { inner, bytes }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for CountingStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for CountingStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(written)) = &result {
            self.bytes.fetch_add(*written as u64, Ordering::Relaxed);
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub(super) async fn copy_bidirectional_counted<A, B>(
    left: &mut A,
    right: &mut B,
    bytes: Arc<AtomicU64>,
) -> io::Result<(u64, u64)>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let mut left = CountingStream::new(left, bytes.clone());
    let mut right = CountingStream::new(right, bytes);
    tokio::io::copy_bidirectional(&mut left, &mut right).await
}

#[derive(Clone, Debug)]
pub(super) struct TunnelFailure {
    pub(super) info: Option<TunnelInfo>,
    pub(super) message: String,
}

impl TunnelFailure {
    pub(super) fn new(info: Option<TunnelInfo>, message: impl Into<String>) -> Self {
        Self {
            info,
            message: message.into(),
        }
    }
}

struct TunnelRuntime {
    info: TunnelInfo,
    config: TunnelConfig,
    bytes: Arc<AtomicU64>,
    connections: TunnelConnections,
    task: Option<JoinHandle<()>>,
}

pub(super) struct TunnelManager {
    next_id: AtomicU64,
    tunnels: RwLock<HashMap<u64, TunnelRuntime>>,
    operation_lock: AsyncMutex<()>,
}

pub(super) struct ProfileTunnelRestart {
    pub(super) stopped: Vec<TunnelInfo>,
    pub(super) started: Vec<Result<TunnelInfo, TunnelFailure>>,
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
    pub(super) async fn start(
        &self,
        workspace: Arc<RemoteWorkspace>,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        validate(&config).map_err(|message| TunnelFailure::new(None, message))?;
        let _operation = self.operation_lock.lock().await;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.start_with_id_unlocked(id, workspace, config).await
    }

    async fn start_with_id_unlocked(
        &self,
        id: u64,
        workspace: Arc<RemoteWorkspace>,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        let bytes = Arc::new(AtomicU64::new(0));
        let connections = TunnelConnections::default();
        let mut info = TunnelInfo {
            id,
            profile_id: config.profile_id.clone(),
            name: config.name.clone(),
            kind: config.kind,
            status: TunnelStatus::Active,
            bind_host: normalized_bind(&config.bind_host).to_string(),
            bind_port: config.bind_port,
            requested_bind_port: config.bind_port,
            target_host: config.target_host.clone(),
            target_port: config.target_port,
            bytes: 0,
            error: None,
        };

        let activation: Result<Option<JoinHandle<()>>, String> = async {
            Ok(match config.kind {
                TunnelKind::Local => {
                    let listener = bind_listener(&info.bind_host, info.bind_port).await?;
                    info.bind_port = listener.local_addr().map_err(|e| e.to_string())?.port();
                    let workspace = workspace.clone();
                    let target_host = config.target_host.clone();
                    let target_port = config.target_port;
                    let bytes = bytes.clone();
                    let connections = connections.clone();
                    Some(tauri::async_runtime::spawn(async move {
                        loop {
                            let accepted = tokio::select! {
                                _ = connections.cancelled() => break,
                                accepted = listener.accept() => accepted,
                            };
                            let Ok((mut inbound, peer)) = accepted else {
                                break;
                            };
                            let workspace = workspace.clone();
                            let target_host = target_host.clone();
                            let bytes = bytes.clone();
                            connections.spawn(async move {
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
                                    let _ = copy_bidirectional_counted(
                                        &mut inbound,
                                        &mut remote,
                                        bytes,
                                    )
                                    .await;
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
                    let connections = connections.clone();
                    Some(tauri::async_runtime::spawn(async move {
                        loop {
                            let accepted = tokio::select! {
                                _ = connections.cancelled() => break,
                                accepted = listener.accept() => accepted,
                            };
                            let Ok((inbound, peer)) = accepted else {
                                break;
                            };
                            let workspace = workspace.clone();
                            let bytes = bytes.clone();
                            connections.spawn(async move {
                                let _ = socks5_serve(workspace, inbound, peer, bytes).await;
                            });
                        }
                    }))
                }
                TunnelKind::Remote => {
                    let actual = {
                        let handle = workspace.handle.lock().await;
                        let port = handle
                            .tcpip_forward(info.bind_host.clone(), info.bind_port as u32)
                            .await
                            .map_err(|e| format!("start remote forward: {e}"))?;
                        if info.bind_port == 0 {
                            match u16::try_from(port).ok().filter(|port| *port != 0) {
                                Some(port) => port,
                                None => {
                                    let message = format!(
                                        "server returned invalid remote-forward port {port}"
                                    );
                                    if let Err(error) = handle
                                        .cancel_tcpip_forward(info.bind_host.clone(), port)
                                        .await
                                    {
                                        log::warn!("{message}; cleanup failed: {error}");
                                    }
                                    return Err(message);
                                }
                            }
                        } else {
                            info.bind_port
                        }
                    };
                    info.bind_port = actual;
                    workspace.remote_forwards.insert(
                        info.bind_host.clone(),
                        actual as u32,
                        LocalTarget {
                            host: config.target_host.clone(),
                            port: config.target_port,
                            bytes: bytes.clone(),
                            connections: connections.clone(),
                        },
                    );
                    None
                }
            })
        }
        .await;

        let task = match activation {
            Ok(task) => task,
            Err(message) => {
                info.status = TunnelStatus::Failed;
                info.error = Some(message.clone());
                self.insert_runtime(id, info.clone(), config, bytes, connections, None)
                    .await;
                return Err(TunnelFailure::new(Some(info), message));
            }
        };
        self.insert_runtime(id, info.clone(), config, bytes, connections, task)
            .await;
        Ok(info)
    }

    async fn insert_runtime(
        &self,
        id: u64,
        info: TunnelInfo,
        config: TunnelConfig,
        bytes: Arc<AtomicU64>,
        connections: TunnelConnections,
        task: Option<JoinHandle<()>>,
    ) {
        self.tunnels.write().await.insert(
            id,
            TunnelRuntime {
                info,
                config,
                bytes,
                connections,
                task,
            },
        );
    }

    pub(super) async fn stop(
        &self,
        id: u64,
        workspace: Option<Arc<RemoteWorkspace>>,
    ) -> Result<Option<TunnelInfo>, TunnelFailure> {
        let _operation = self.operation_lock.lock().await;
        self.stop_unlocked(id, workspace, true).await
    }

    async fn stop_unlocked(
        &self,
        id: u64,
        workspace: Option<Arc<RemoteWorkspace>>,
        require_remote_cancel: bool,
    ) -> Result<Option<TunnelInfo>, TunnelFailure> {
        let Some(current) = self.info_unlocked(id).await else {
            return Ok(None);
        };

        if current.kind == TunnelKind::Remote && current.status == TunnelStatus::Active {
            if let Some(workspace) = workspace.as_ref() {
                if !workspace.is_closed().await {
                    let result = {
                        let handle = workspace.handle.lock().await;
                        handle
                            .cancel_tcpip_forward(
                                current.bind_host.clone(),
                                current.bind_port as u32,
                            )
                            .await
                    };
                    if let Err(error) = result {
                        let message = format!("stop remote forward: {error}");
                        if require_remote_cancel {
                            let info = self.record_error(id, &message).await;
                            return Err(TunnelFailure::new(info, message));
                        }
                        log::warn!("{message}");
                    }
                }
            }
        }

        let Some(mut runtime) = self.tunnels.write().await.remove(&id) else {
            return Ok(None);
        };
        if runtime.info.kind == TunnelKind::Remote {
            if let Some(workspace) = workspace {
                workspace
                    .remote_forwards
                    .remove(&runtime.info.bind_host, runtime.info.bind_port as u32);
            }
        }
        runtime.connections.cancel();
        if let Some(task) = runtime.task.take() {
            let _ = task.await;
        }
        runtime.connections.wait().await;
        let mut info = runtime_info(&runtime);
        info.status = TunnelStatus::Closed;
        info.error = None;
        Ok(Some(info))
    }

    async fn record_error(&self, id: u64, message: &str) -> Option<TunnelInfo> {
        self.tunnels.write().await.get_mut(&id).map(|runtime| {
            runtime.info.error = Some(message.to_string());
            runtime_info(runtime)
        })
    }

    pub(super) async fn list(&self, profile_id: &str) -> Vec<TunnelInfo> {
        let _operation = self.operation_lock.lock().await;
        self.list_unlocked(profile_id).await
    }

    async fn list_unlocked(&self, profile_id: &str) -> Vec<TunnelInfo> {
        let tunnels = self.tunnels.read().await;
        let mut result: Vec<_> = tunnels
            .values()
            .filter(|runtime| runtime.info.profile_id == profile_id)
            .map(runtime_info)
            .collect();
        result.sort_by_key(|info| info.id);
        result
    }

    #[cfg(test)]
    async fn active_configs(&self, profile_id: &str) -> Vec<TunnelConfig> {
        let _operation = self.operation_lock.lock().await;
        self.active_configs_unlocked(profile_id).await
    }

    #[cfg(test)]
    async fn active_configs_unlocked(&self, profile_id: &str) -> Vec<TunnelConfig> {
        self.tunnels
            .read()
            .await
            .values()
            .filter(|runtime| {
                runtime.info.profile_id == profile_id && runtime.info.status == TunnelStatus::Active
            })
            .map(|runtime| runtime.config.clone())
            .collect()
    }

    pub(super) async fn info(&self, id: u64) -> Option<TunnelInfo> {
        let _operation = self.operation_lock.lock().await;
        self.info_unlocked(id).await
    }

    async fn info_unlocked(&self, id: u64) -> Option<TunnelInfo> {
        self.tunnels.read().await.get(&id).map(runtime_info)
    }

    pub(super) async fn replace(
        &self,
        id: u64,
        workspace: Arc<RemoteWorkspace>,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        let _operation = self.operation_lock.lock().await;
        let (previous, current) = {
            let tunnels = self.tunnels.read().await;
            let runtime = tunnels.get(&id).ok_or_else(|| {
                TunnelFailure::new(None, format!("SSH tunnel {id} was not found"))
            })?;
            (runtime.config.clone(), runtime_info(runtime))
        };
        validate(&config).map_err(|message| TunnelFailure::new(Some(current.clone()), message))?;
        if previous.profile_id != config.profile_id {
            return Err(TunnelFailure::new(
                Some(current),
                "SSH tunnel profile cannot be changed",
            ));
        }
        let mut operations = ManagerReplaceOperations {
            manager: self,
            workspace,
            id,
        };
        replace_with_rollback(&mut operations, previous, config).await
    }

    pub(super) async fn stop_profile(
        &self,
        profile_id: &str,
        workspace: Arc<RemoteWorkspace>,
    ) -> Vec<TunnelInfo> {
        let _operation = self.operation_lock.lock().await;
        self.stop_profile_unlocked(profile_id, workspace).await
    }

    async fn stop_profile_unlocked(
        &self,
        profile_id: &str,
        workspace: Arc<RemoteWorkspace>,
    ) -> Vec<TunnelInfo> {
        let ids: Vec<u64> = self
            .tunnels
            .read()
            .await
            .iter()
            .filter_map(|(id, runtime)| (runtime.info.profile_id == profile_id).then_some(*id))
            .collect();
        let mut stopped = Vec::new();
        for id in ids {
            match self.stop_unlocked(id, Some(workspace.clone()), false).await {
                Ok(Some(info)) => stopped.push(info),
                Ok(None) => {}
                Err(error) => log::warn!("failed to stop SSH tunnel: {}", error.message),
            }
        }
        stopped
    }

    pub(super) async fn restart_profile(
        &self,
        profile_id: &str,
        previous: Arc<RemoteWorkspace>,
        replacement: Arc<RemoteWorkspace>,
    ) -> ProfileTunnelRestart {
        let _operation = self.operation_lock.lock().await;
        let active: Vec<_> = self
            .tunnels
            .read()
            .await
            .iter()
            .filter(|(_, runtime)| {
                runtime.info.profile_id == profile_id && runtime.info.status == TunnelStatus::Active
            })
            .map(|(id, runtime)| (*id, runtime.config.clone()))
            .collect();
        let stopped = self.stop_profile_unlocked(profile_id, previous).await;
        let mut started = Vec::with_capacity(active.len());
        for (id, config) in active {
            started.push(
                self.start_with_id_unlocked(id, replacement.clone(), config)
                    .await,
            );
        }
        ProfileTunnelRestart { stopped, started }
    }
}

fn runtime_info(runtime: &TunnelRuntime) -> TunnelInfo {
    let mut info = runtime.info.clone();
    info.bytes = runtime.bytes.load(Ordering::Relaxed);
    info
}

trait ReplaceOperations {
    fn stop(&mut self) -> impl Future<Output = Result<TunnelInfo, TunnelFailure>>;
    fn start(
        &mut self,
        config: TunnelConfig,
    ) -> impl Future<Output = Result<TunnelInfo, TunnelFailure>>;
}

struct ManagerReplaceOperations<'a> {
    manager: &'a TunnelManager,
    workspace: Arc<RemoteWorkspace>,
    id: u64,
}

impl ReplaceOperations for ManagerReplaceOperations<'_> {
    async fn stop(&mut self) -> Result<TunnelInfo, TunnelFailure> {
        self.manager
            .stop_unlocked(self.id, Some(self.workspace.clone()), true)
            .await?
            .ok_or_else(|| {
                TunnelFailure::new(None, format!("SSH tunnel {} was not found", self.id))
            })
    }

    async fn start(&mut self, config: TunnelConfig) -> Result<TunnelInfo, TunnelFailure> {
        self.manager
            .start_with_id_unlocked(self.id, self.workspace.clone(), config)
            .await
    }
}

async fn replace_with_rollback<O: ReplaceOperations>(
    operations: &mut O,
    previous: TunnelConfig,
    replacement: TunnelConfig,
) -> Result<TunnelInfo, TunnelFailure> {
    operations.stop().await?;
    match operations.start(replacement).await {
        Ok(info) => Ok(info),
        Err(replacement_error) => match operations.start(previous).await {
            Ok(info) => Err(TunnelFailure::new(
                Some(info),
                format!(
                    "{}. The previous tunnel was restored.",
                    replacement_error.message
                ),
            )),
            Err(restore_error) => Err(TunnelFailure::new(
                restore_error.info,
                format!(
                    "{}. The previous tunnel could not be restored: {}",
                    replacement_error.message, restore_error.message
                ),
            )),
        },
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
    if config.kind != TunnelKind::Dynamic {
        if config.target_host.trim().is_empty()
            || config.target_host.chars().any(char::is_whitespace)
        {
            return Err("tunnel target host is required and cannot contain whitespace".into());
        }
        if config.target_port == 0 {
            return Err("tunnel target port is required".into());
        }
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
    bytes: Arc<AtomicU64>,
) -> Result<(), String> {
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
    copy_bidirectional_counted(&mut inbound, &mut remote, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn socks_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;

    use super::*;
    use tokio::sync::oneshot;

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

    fn info(id: u64, config: &TunnelConfig, status: TunnelStatus) -> TunnelInfo {
        TunnelInfo {
            id,
            profile_id: config.profile_id.clone(),
            name: config.name.clone(),
            kind: config.kind,
            status,
            bind_host: config.bind_host.clone(),
            bind_port: config.bind_port,
            requested_bind_port: config.bind_port,
            target_host: config.target_host.clone(),
            target_port: config.target_port,
            bytes: 0,
            error: None,
        }
    }

    enum StartOutcome {
        Active,
        Failed(&'static str),
    }

    struct FakeReplaceOperations {
        id: u64,
        current: TunnelConfig,
        stop_error: Option<&'static str>,
        starts: VecDeque<StartOutcome>,
        started_configs: Vec<TunnelConfig>,
    }

    impl ReplaceOperations for FakeReplaceOperations {
        async fn stop(&mut self) -> Result<TunnelInfo, TunnelFailure> {
            if let Some(message) = self.stop_error.take() {
                return Err(TunnelFailure::new(
                    Some(info(self.id, &self.current, TunnelStatus::Active)),
                    message,
                ));
            }
            Ok(info(self.id, &self.current, TunnelStatus::Closed))
        }

        async fn start(&mut self, config: TunnelConfig) -> Result<TunnelInfo, TunnelFailure> {
            self.started_configs.push(config.clone());
            match self.starts.pop_front().expect("missing fake start outcome") {
                StartOutcome::Active => Ok(info(self.id, &config, TunnelStatus::Active)),
                StartOutcome::Failed(message) => {
                    let mut failed = info(self.id, &config, TunnelStatus::Failed);
                    failed.error = Some(message.to_string());
                    Err(TunnelFailure::new(Some(failed), message))
                }
            }
        }
    }

    #[tokio::test]
    async fn failed_update_restores_the_previous_config_with_the_same_id() {
        let previous = config(TunnelKind::Local);
        let mut replacement = previous.clone();
        replacement.bind_port = 4000;
        let mut operations = FakeReplaceOperations {
            id: 7,
            current: previous.clone(),
            stop_error: None,
            starts: VecDeque::from([
                StartOutcome::Failed("replacement failed"),
                StartOutcome::Active,
            ]),
            started_configs: Vec::new(),
        };

        let failure = replace_with_rollback(&mut operations, previous.clone(), replacement.clone())
            .await
            .unwrap_err();

        assert_eq!(operations.started_configs, vec![replacement, previous]);
        let restored = failure.info.expect("restored tunnel info");
        assert_eq!(restored.id, 7);
        assert_eq!(restored.status, TunnelStatus::Active);
        assert_eq!(restored.requested_bind_port, 3000);
        assert!(failure.message.contains("previous tunnel was restored"));
    }

    #[tokio::test]
    async fn failed_update_keeps_the_previous_config_visible_when_restore_fails() {
        let previous = config(TunnelKind::Remote);
        let mut replacement = previous.clone();
        replacement.target_port = 9090;
        let mut operations = FakeReplaceOperations {
            id: 11,
            current: previous.clone(),
            stop_error: None,
            starts: VecDeque::from([
                StartOutcome::Failed("replacement failed"),
                StartOutcome::Failed("restore failed"),
            ]),
            started_configs: Vec::new(),
        };

        let failure = replace_with_rollback(&mut operations, previous.clone(), replacement)
            .await
            .unwrap_err();

        let failed = failure.info.expect("failed previous tunnel info");
        assert_eq!(failed.id, 11);
        assert_eq!(failed.status, TunnelStatus::Failed);
        assert_eq!(failed.target_port, previous.target_port);
        assert!(failure.message.contains("could not be restored"));
    }

    #[tokio::test]
    async fn stop_failure_aborts_update_before_starting_replacement() {
        let previous = config(TunnelKind::Remote);
        let mut replacement = previous.clone();
        replacement.target_port = 9090;
        let mut operations = FakeReplaceOperations {
            id: 13,
            current: previous.clone(),
            stop_error: Some("cancel denied"),
            starts: VecDeque::from([StartOutcome::Active]),
            started_configs: Vec::new(),
        };

        let failure = replace_with_rollback(&mut operations, previous, replacement)
            .await
            .unwrap_err();

        assert!(operations.started_configs.is_empty());
        assert_eq!(failure.info.unwrap().status, TunnelStatus::Active);
        assert_eq!(failure.message, "cancel denied");
    }

    #[tokio::test]
    async fn traffic_is_counted_before_the_forwarded_streams_close() {
        let bytes = Arc::new(AtomicU64::new(0));
        let (mut left_client, mut left_tunnel) = tokio::io::duplex(64);
        let (mut right_tunnel, mut right_client) = tokio::io::duplex(64);
        let copy_bytes = bytes.clone();
        let copy = tokio::spawn(async move {
            copy_bidirectional_counted(&mut left_tunnel, &mut right_tunnel, copy_bytes).await
        });

        left_client.write_all(b"hello").await.unwrap();
        let mut forwarded = [0; 5];
        right_client.read_exact(&mut forwarded).await.unwrap();
        assert_eq!(&forwarded, b"hello");
        assert_eq!(bytes.load(Ordering::Relaxed), 5);

        right_client.write_all(b"ok").await.unwrap();
        let mut returned = [0; 2];
        left_client.read_exact(&mut returned).await.unwrap();
        assert_eq!(&returned, b"ok");
        assert_eq!(bytes.load(Ordering::Relaxed), 7);
        assert!(!copy.is_finished());

        drop(left_client);
        drop(right_client);
        copy.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn failed_tunnels_remain_visible_but_are_not_restored_on_reconnect() {
        let manager = TunnelManager::default();
        let active = config(TunnelKind::Local);
        let mut failed = active.clone();
        failed.name = "failed".into();
        failed.bind_port = 3001;
        manager
            .insert_runtime(
                1,
                info(1, &active, TunnelStatus::Active),
                active.clone(),
                Arc::new(AtomicU64::new(0)),
                TunnelConnections::default(),
                None,
            )
            .await;
        manager
            .insert_runtime(
                2,
                info(2, &failed, TunnelStatus::Failed),
                failed,
                Arc::new(AtomicU64::new(0)),
                TunnelConnections::default(),
                None,
            )
            .await;

        assert_eq!(manager.list("ssh-prod").await.len(), 2);
        assert_eq!(manager.active_configs("ssh-prod").await, vec![active]);
    }

    #[tokio::test]
    async fn cancelling_connections_waits_for_existing_tasks_and_rejects_late_tasks() {
        let connections = TunnelConnections::default();
        let (started_tx, started_rx) = oneshot::channel();
        let (mut peer, mut stream) = tokio::io::duplex(16);
        connections.spawn(async move {
            let _ = started_tx.send(());
            let mut byte = [0; 1];
            let _ = stream.read(&mut byte).await;
        });
        started_rx.await.unwrap();

        connections.cancel();
        connections.wait().await;

        let mut byte = [0; 1];
        assert_eq!(peer.read(&mut byte).await.unwrap(), 0);
        assert!(connections.tasks.is_empty());

        let ran = Arc::new(AtomicBool::new(false));
        let late_ran = ran.clone();
        connections.spawn(async move {
            late_ran.store(true, Ordering::Relaxed);
        });
        tokio::task::yield_now().await;
        assert!(!ran.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn list_waits_for_the_current_tunnel_operation() {
        let manager = Arc::new(TunnelManager::default());
        let active = config(TunnelKind::Local);
        manager
            .insert_runtime(
                1,
                info(1, &active, TunnelStatus::Active),
                active,
                Arc::new(AtomicU64::new(0)),
                TunnelConnections::default(),
                None,
            )
            .await;
        let operation = manager.operation_lock.lock().await;
        let reader_manager = manager.clone();
        let reader = tokio::spawn(async move { reader_manager.list("ssh-prod").await });
        tokio::task::yield_now().await;

        assert!(!reader.is_finished());
        drop(operation);
        assert_eq!(reader.await.unwrap().len(), 1);
    }
}
