//! 当前进程唯一 SSH Runtime 的连接、健康监督、重连与资源生命周期协调。
//!
//! 所有状态迁移由本模块串行发布；启动提示允许首个 PTY 合并 root 探测，raw 读取
//! SFTP 独立预热。业务入站流量抑制重复保活，旧 workspace 的迟到失败不能覆盖新连接。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use super::host_key::HostKeyVerifier;
use super::models::{
    ConnectRequest, ForegroundIntent, RemoteRuntimeSnapshot, SshHealthSnapshot, SshTrafficSnapshot,
    TunnelConfig, TunnelEvent, TunnelEventKind, TunnelInfo,
};
use super::session::{ExecOutput, RemoteWorkspace, TransportProbeOutcome};
use super::traffic::SshTrafficMeter;
use super::tunnel::{TunnelFailure, TunnelManager};

const HEALTH_MONITOR_TICK: Duration = Duration::from_secs(15);
const IDLE_PROBE_AGE: Duration = Duration::from_secs(30);
const MAX_RTT_AGE: Duration = Duration::from_secs(60);
const WAKE_PROBE_AGE: Duration = Duration::from_secs(5);
const TRANSPORT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const TRANSPORT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const CONNECT_SUPERSEDED: &str = "SSH connection attempt was superseded";

fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(u64::from(attempt.saturating_sub(1).min(5)))
}

#[derive(Clone)]
struct RuntimeLifecycle {
    id: u64,
    cancellation: CancellationToken,
}

/// 已发布 connecting、等待配置和凭据准备完成的连接意图。
pub(crate) struct ReservedConnect {
    profile_id: String,
    lifecycle: RuntimeLifecycle,
}

struct RuntimeData {
    snapshot: RemoteRuntimeSnapshot,
    workspace: Option<Arc<RemoteWorkspace>>,
    lifecycle: RuntimeLifecycle,
}

/// 协调当前进程唯一 SSH Runtime 及其派生资源。
pub struct RemoteManager {
    runtime: RwLock<RuntimeData>,
    connect_lock: Mutex<()>,
    foreground_intent: Arc<Mutex<Option<ForegroundIntent>>>,
    prepared_terminal: Mutex<Option<super::terminal::PreparedTerminal>>,
    prepared_terminal_priority: AtomicBool,
    foreground_filesystem_priority: Arc<AtomicBool>,
    next_version: AtomicU64,
    next_epoch: AtomicU64,
    next_lifecycle: AtomicU64,
    traffic: Arc<SshTrafficMeter>,
    pub host_keys: Arc<HostKeyVerifier>,
    tunnels: TunnelManager,
}

impl Default for RemoteManager {
    fn default() -> Self {
        let path = crate::modules::app_data::directory(crate::modules::app_data::Directory::Ssh)
            .expect("Terax SSH data directory is unavailable")
            .join("known_hosts");
        Self {
            runtime: RwLock::new(RuntimeData {
                snapshot: RemoteRuntimeSnapshot::Idle { version: 0 },
                workspace: None,
                lifecycle: RuntimeLifecycle {
                    id: 0,
                    cancellation: CancellationToken::new(),
                },
            }),
            connect_lock: Mutex::new(()),
            foreground_intent: Arc::new(Mutex::new(None)),
            prepared_terminal: Mutex::new(None),
            prepared_terminal_priority: AtomicBool::new(false),
            foreground_filesystem_priority: Arc::new(AtomicBool::new(false)),
            next_version: AtomicU64::new(1),
            next_epoch: AtomicU64::new(1),
            next_lifecycle: AtomicU64::new(1),
            traffic: Arc::new(SshTrafficMeter::default()),
            host_keys: Arc::new(HostKeyVerifier::new(path)),
            tunnels: TunnelManager::default(),
        }
    }
}

impl RemoteManager {
    /// 更新启动阶段唯一的前台资源提示。
    pub async fn set_foreground_intent(&self, intent: ForegroundIntent) {
        let accepting = matches!(
            self.runtime.read().await.snapshot,
            RemoteRuntimeSnapshot::Idle { .. } | RemoteRuntimeSnapshot::Connecting { .. }
        );
        if accepting {
            self.foreground_filesystem_priority
                .store(intent != ForegroundIntent::None, Ordering::Release);
            *self.foreground_intent.lock().await = Some(intent);
        }
    }

    /// 破坏式建立当前进程唯一的 SSH Runtime。
    ///
    /// 已有 workspace 会先被完整关闭。新连接完成 root 探测即可发布 `connected`，
    /// 文件系统并行预热；失败后保持 `disconnected`，不会回退复用旧 transport。
    pub async fn connect(
        self: &Arc<Self>,
        request: ConnectRequest,
        app: tauri::AppHandle,
    ) -> Result<RemoteRuntimeSnapshot, String> {
        let reserved = self.reserve_connect(&request.profile.id, &app).await?;
        self.connect_reserved(request, reserved, app).await
    }

    /// 在读取可能阻塞的系统凭据前发布连接状态，避免前端重复发起自动连接。
    pub(crate) async fn reserve_connect(
        &self,
        profile_id: &str,
        app: &tauri::AppHandle,
    ) -> Result<ReservedConnect, String> {
        let lifecycle = self.begin_lifecycle().await;
        if !self.publish_connecting(app, &lifecycle, profile_id).await {
            return Err(CONNECT_SUPERSEDED.into());
        }
        Ok(ReservedConnect {
            profile_id: profile_id.to_string(),
            lifecycle,
        })
    }

    /// 使用已发布的连接意图建立 transport，并在预处理失败时收敛状态。
    pub(crate) async fn connect_reserved(
        self: &Arc<Self>,
        request: ConnectRequest,
        reserved: ReservedConnect,
        app: tauri::AppHandle,
    ) -> Result<RemoteRuntimeSnapshot, String> {
        let ReservedConnect {
            profile_id,
            lifecycle,
        } = reserved;
        let _guard = self.connect_lock.lock().await;
        if !self.is_lifecycle_current(lifecycle.id).await {
            return Err(CONNECT_SUPERSEDED.into());
        }
        self.stop_current(&app).await;
        let result = self.connect_locked(request, &lifecycle, &app).await;
        if let Err(error) = &result {
            if error != CONNECT_SUPERSEDED && self.is_lifecycle_current(lifecycle.id).await {
                self.publish_disconnected(&app, &lifecycle, &profile_id, error.clone())
                    .await;
            }
        }
        result
    }

    /// 结束仍是当前意图的预处理失败连接。
    pub(crate) async fn reject_reserved(
        &self,
        reserved: &ReservedConnect,
        app: &tauri::AppHandle,
        error: String,
    ) {
        if self.is_lifecycle_current(reserved.lifecycle.id).await {
            self.publish_disconnected(app, &reserved.lifecycle, &reserved.profile_id, error)
                .await;
        }
    }

    /// 在调用方已持有连接锁时建立一个新 epoch。
    async fn connect_locked(
        self: &Arc<Self>,
        request: ConnectRequest,
        lifecycle: &RuntimeLifecycle,
        app: &tauri::AppHandle,
    ) -> Result<RemoteRuntimeSnapshot, String> {
        if !self.is_lifecycle_current(lifecycle.id).await {
            return Err(CONNECT_SUPERSEDED.into());
        }
        let profile_id = request.profile.id.clone();
        let tunnel_configs = request.profile.enabled_tunnel_configs();

        let connect = RemoteWorkspace::connect(
            request,
            app.clone(),
            self.host_keys.clone(),
            lifecycle.cancellation.clone(),
            self.foreground_intent.clone(),
            self.foreground_filesystem_priority.clone(),
            self.traffic.clone(),
        );
        let connected = match tokio::select! {
            _ = lifecycle.cancellation.cancelled() => return Err(CONNECT_SUPERSEDED.into()),
            result = connect => result,
        } {
            Ok(connected) => connected,
            Err(error) => return Err(error),
        };
        let super::session::WorkspaceConnect {
            workspace,
            prepared_terminal,
        } = connected;

        if !self.is_lifecycle_current(lifecycle.id).await {
            if let Some(prepared) = prepared_terminal {
                prepared.close().await;
            }
            workspace.disconnect().await;
            return Err(CONNECT_SUPERSEDED.into());
        }

        let home = workspace.home().await;
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        workspace.set_runtime_epoch(epoch);
        let snapshot = RemoteRuntimeSnapshot::Connected {
            version: self.version(),
            epoch,
            profile_id: profile_id.clone(),
            home,
        };
        let installed = {
            let mut runtime = self.runtime.write().await;
            if runtime.lifecycle.id != lifecycle.id {
                false
            } else {
                runtime.workspace = Some(workspace.clone());
                runtime.snapshot = snapshot.clone();
                true
            }
        };
        if !installed {
            if let Some(prepared) = prepared_terminal {
                prepared.close().await;
            }
            workspace.disconnect().await;
            return Err(CONNECT_SUPERSEDED.into());
        }
        *self.foreground_intent.lock().await = None;
        let has_prepared_terminal = prepared_terminal.is_some();
        let previous = {
            let mut slot = self.prepared_terminal.lock().await;
            std::mem::replace(&mut *slot, prepared_terminal)
        };
        if let Some(previous) = previous {
            previous.close().await;
        }
        self.prepared_terminal_priority
            .store(has_prepared_terminal, Ordering::Release);
        self.tunnels.activate_profile_epoch(&profile_id, epoch);
        let _ = app.emit("terax://ssh-runtime", snapshot.clone());
        Self::emit_health(app, workspace.health_snapshot(epoch));
        self.spawn_monitor(workspace.clone(), epoch, lifecycle.clone(), app.clone());
        if has_prepared_terminal {
            self.spawn_prepared_terminal_expiry(workspace.clone(), epoch, lifecycle.id);
        }
        self.spawn_tunnel_start(
            profile_id,
            workspace,
            epoch,
            lifecycle.id,
            tunnel_configs,
            app.clone(),
        );
        Ok(snapshot)
    }

    /// 关闭未被首个前端 PTY 接管的预启动终端，避免页面切换后保留远端 shell。
    fn spawn_prepared_terminal_expiry(
        self: &Arc<Self>,
        workspace: Arc<RemoteWorkspace>,
        epoch: u64,
        lifecycle_id: u64,
    ) {
        let manager = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let Some(manager) = manager.upgrade() else {
                return;
            };
            if !manager.is_current(&workspace, epoch, lifecycle_id).await {
                return;
            }
            let prepared = manager.prepared_terminal.lock().await.take();
            if let Some(prepared) = prepared {
                prepared.close().await;
            }
        });
    }

    /// 关闭并移除当前 epoch 的 workspace 与隧道。
    async fn stop_current(&self, app: &tauri::AppHandle) {
        self.prepared_terminal_priority
            .store(false, Ordering::Release);
        let prepared = self.prepared_terminal.lock().await.take();
        if let Some(prepared) = prepared {
            prepared.close().await;
        }
        let workspace = self.runtime.write().await.workspace.take();
        let Some(workspace) = workspace else {
            return;
        };
        let profile_id = workspace.profile.id.clone();
        self.tunnels.deactivate_profile_epoch(&profile_id, None);
        let stopped_tunnels = tokio::time::timeout(
            TRANSPORT_CLEANUP_TIMEOUT,
            self.tunnels.stop_profile(&profile_id, workspace.clone()),
        )
        .await
        .unwrap_or_else(|_| {
            log::warn!("timed out while cleaning up SSH tunnels for {profile_id}");
            Vec::new()
        });
        for tunnel in stopped_tunnels {
            Self::emit_tunnel_event(
                app,
                TunnelEventKind::Stopped,
                &profile_id,
                Some(tunnel),
                None,
            );
        }
        workspace.disconnect().await;
    }

    /// 在连接发布后启动持久化隧道；epoch 已变化时直接丢弃旧任务。
    fn spawn_tunnel_start(
        self: &Arc<Self>,
        profile_id: String,
        workspace: Arc<RemoteWorkspace>,
        epoch: u64,
        lifecycle_id: u64,
        configs: Vec<TunnelConfig>,
        app: tauri::AppHandle,
    ) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if !manager.is_current(&workspace, epoch, lifecycle_id).await {
                return;
            }
            if manager
                .foreground_filesystem_priority
                .load(Ordering::Acquire)
            {
                workspace.wait_for_foreground_filesystem().await;
            }
            let started = manager
                .tunnels
                .start_profile(workspace.clone(), configs, epoch)
                .await;
            if !manager.is_current(&workspace, epoch, lifecycle_id).await {
                manager.tunnels.stop_epoch(epoch, workspace).await;
                return;
            }
            Self::emit_tunnel_start(&app, &profile_id, started);
        });
    }

    /// 监听当前 transport 结束，并在同一连接锁内执行唯一的自动重连流程。
    fn spawn_monitor(
        self: &Arc<Self>,
        workspace: Arc<RemoteWorkspace>,
        epoch: u64,
        lifecycle: RuntimeLifecycle,
        app: tauri::AppHandle,
    ) {
        let manager = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let failed = tokio::select! {
                    _ = lifecycle.cancellation.cancelled() => return,
                    _ = workspace.transport_failed() => true,
                    _ = tokio::time::sleep(HEALTH_MONITOR_TICK) => false,
                };
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                if lifecycle.cancellation.is_cancelled()
                    || !manager.is_current(&workspace, epoch, lifecycle.id).await
                {
                    return;
                }
                if failed {
                    manager
                        .handle_transport_closed(workspace, epoch, lifecycle, &app)
                        .await;
                    return;
                }
                if !workspace.health_probe_due(IDLE_PROBE_AGE, MAX_RTT_AGE) {
                    continue;
                }
                match workspace
                    .probe_transport_if_stale(Duration::ZERO, TRANSPORT_PROBE_TIMEOUT)
                    .await
                {
                    TransportProbeOutcome::Fresh => {}
                    TransportProbeOutcome::Sampled => {
                        if manager.is_current(&workspace, epoch, lifecycle.id).await {
                            Self::emit_health(&app, workspace.health_snapshot(epoch));
                            workspace.prepare_file_helper_channel();
                        }
                    }
                    TransportProbeOutcome::Failed => {
                        manager
                            .handle_transport_closed(workspace, epoch, lifecycle, &app)
                            .await;
                        return;
                    }
                }
            }
        });
    }

    /// 失效当前 epoch，并按 profile 策略串行尝试全新连接。
    async fn handle_transport_closed(
        self: &Arc<Self>,
        workspace: Arc<RemoteWorkspace>,
        epoch: u64,
        lifecycle: RuntimeLifecycle,
        app: &tauri::AppHandle,
    ) {
        let guard = tokio::select! {
            _ = lifecycle.cancellation.cancelled() => return,
            guard = self.connect_lock.lock() => guard,
        };
        if !self.is_current(&workspace, epoch, lifecycle.id).await {
            return;
        }

        let profile = workspace.profile.clone();
        let profile_id = profile.id.clone();
        let request = workspace.reconnect_request();
        let published = if profile.reconnect_enabled {
            self.publish_reconnecting(app, &lifecycle, &profile_id)
                .await
        } else {
            self.publish_disconnected(app, &lifecycle, &profile_id, "SSH connection closed".into())
                .await
        };
        if !published {
            return;
        }
        self.tunnels
            .deactivate_profile_epoch(&profile_id, Some(epoch));
        let failed_tunnels = tokio::time::timeout(
            TRANSPORT_CLEANUP_TIMEOUT,
            self.tunnels
                .fail_profile(&profile_id, &workspace.remote_forwards),
        )
        .await
        .unwrap_or_else(|_| {
            log::warn!("timed out while invalidating SSH tunnels for {profile_id}");
            Vec::new()
        });
        for tunnel in failed_tunnels {
            Self::emit_tunnel_event(
                app,
                TunnelEventKind::Failed,
                &profile_id,
                Some(tunnel),
                None,
            );
        }
        workspace.disconnect().await;
        drop(guard);

        if !profile.reconnect_enabled {
            return;
        }
        for attempt in 1..=profile.reconnect_max_attempts {
            tokio::select! {
                _ = lifecycle.cancellation.cancelled() => return,
                _ = tokio::time::sleep(reconnect_delay(attempt)) => {}
            }
            let guard = tokio::select! {
                _ = lifecycle.cancellation.cancelled() => return,
                guard = self.connect_lock.lock() => guard,
            };
            let result = self.connect_locked(request.clone(), &lifecycle, app).await;
            drop(guard);
            if lifecycle.cancellation.is_cancelled() {
                return;
            }
            match result {
                Ok(_) => return,
                Err(error) if error == CONNECT_SUPERSEDED => return,
                Err(error) => {
                    log::warn!("SSH reconnect attempt {attempt} failed: {error}");
                    if attempt == profile.reconnect_max_attempts {
                        self.publish_disconnected(app, &lifecycle, &profile_id, error)
                            .await;
                    }
                }
            }
        }
    }

    async fn is_current(
        &self,
        workspace: &Arc<RemoteWorkspace>,
        epoch: u64,
        lifecycle_id: u64,
    ) -> bool {
        let runtime = self.runtime.read().await;
        runtime.lifecycle.id == lifecycle_id
            && matches!(
                runtime.snapshot,
                RemoteRuntimeSnapshot::Connected {
                    epoch: current_epoch,
                    ..
                } if current_epoch == epoch
            )
            && runtime
                .workspace
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, workspace))
    }

    /// 启动新的显式连接意图，并立即取消旧 epoch 的监控和自动重连。
    async fn begin_lifecycle(&self) -> RuntimeLifecycle {
        let lifecycle = RuntimeLifecycle {
            id: self.next_lifecycle.fetch_add(1, Ordering::Relaxed),
            cancellation: CancellationToken::new(),
        };
        let mut runtime = self.runtime.write().await;
        runtime.lifecycle.cancellation.cancel();
        runtime.lifecycle = lifecycle.clone();
        lifecycle
    }

    async fn is_lifecycle_current(&self, lifecycle_id: u64) -> bool {
        self.runtime.read().await.lifecycle.id == lifecycle_id
    }

    fn version(&self) -> u64 {
        self.next_version.fetch_add(1, Ordering::Relaxed)
    }

    /// 发布一次连接尝试，确保旧 Runtime 在耗时清理期间也不会显示为可用。
    async fn publish_connecting(
        &self,
        app: &tauri::AppHandle,
        lifecycle: &RuntimeLifecycle,
        profile_id: &str,
    ) -> bool {
        let snapshot = RemoteRuntimeSnapshot::Connecting {
            version: self.version(),
            profile_id: profile_id.to_string(),
        };
        let published = {
            let mut runtime = self.runtime.write().await;
            if runtime.lifecycle.id != lifecycle.id {
                false
            } else {
                runtime.snapshot = snapshot.clone();
                true
            }
        };
        if published {
            let _ = app.emit("terax://ssh-runtime", snapshot);
        }
        published
    }

    /// 发布自动重连进度，并移除已经失效的旧 workspace。
    async fn publish_reconnecting(
        &self,
        app: &tauri::AppHandle,
        lifecycle: &RuntimeLifecycle,
        profile_id: &str,
    ) -> bool {
        let snapshot = RemoteRuntimeSnapshot::Reconnecting {
            version: self.version(),
            profile_id: profile_id.to_string(),
        };
        let published = {
            let mut runtime = self.runtime.write().await;
            if runtime.lifecycle.id != lifecycle.id {
                false
            } else {
                runtime.workspace = None;
                runtime.snapshot = snapshot.clone();
                true
            }
        };
        if published {
            let _ = app.emit("terax://ssh-runtime", snapshot);
        }
        published
    }

    /// 发布最终断开状态，并移除已失效的 workspace。
    async fn publish_disconnected(
        &self,
        app: &tauri::AppHandle,
        lifecycle: &RuntimeLifecycle,
        profile_id: &str,
        reason: String,
    ) -> bool {
        let snapshot = RemoteRuntimeSnapshot::Disconnected {
            version: self.version(),
            profile_id: profile_id.to_string(),
            reason,
        };
        let published = {
            let mut runtime = self.runtime.write().await;
            if runtime.lifecycle.id != lifecycle.id {
                false
            } else {
                runtime.workspace = None;
                runtime.snapshot = snapshot.clone();
                true
            }
        };
        if !published {
            return false;
        }
        let _ = app.emit("terax://ssh-runtime", snapshot);
        true
    }

    /// 关闭当前 Runtime 并回到无连接的初始状态。
    pub async fn disconnect(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let lifecycle = self.begin_lifecycle().await;
        let snapshot = RemoteRuntimeSnapshot::Idle {
            version: self.version(),
        };
        {
            let mut runtime = self.runtime.write().await;
            if runtime.lifecycle.id != lifecycle.id {
                return Ok(());
            }
            runtime.snapshot = snapshot.clone();
        }
        let _ = app.emit("terax://ssh-runtime", snapshot);
        let _guard = self.connect_lock.lock().await;
        if !self.is_lifecycle_current(lifecycle.id).await {
            return Ok(());
        }
        self.stop_current(app).await;
        Ok(())
    }

    /// 返回当前权威状态快照。
    pub async fn snapshot(&self) -> RemoteRuntimeSnapshot {
        self.runtime.read().await.snapshot.clone()
    }

    /// 返回当前应用进程累计的 SSH transport 收发字节。
    pub fn traffic_snapshot(&self) -> SshTrafficSnapshot {
        self.traffic.snapshot()
    }

    /// 返回当前 connected epoch 的低频 SSH RTT 快照。
    pub async fn health_snapshot(&self) -> SshHealthSnapshot {
        let runtime = self.runtime.read().await;
        match (&runtime.snapshot, &runtime.workspace) {
            (RemoteRuntimeSnapshot::Connected { epoch, .. }, Some(workspace)) => {
                workspace.health_snapshot(*epoch)
            }
            _ => SshHealthSnapshot::default(),
        }
    }

    /// 窗口重新激活时立即确认长时间未探活的 transport，并复用统一重连流程。
    pub async fn wake(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
    ) -> Result<RemoteRuntimeSnapshot, String> {
        let current = {
            let runtime = self.runtime.read().await;
            match (&runtime.snapshot, &runtime.workspace) {
                (RemoteRuntimeSnapshot::Connected { epoch, .. }, Some(workspace)) => {
                    Some((workspace.clone(), *epoch, runtime.lifecycle.clone()))
                }
                _ => None,
            }
        };
        let Some((workspace, epoch, lifecycle)) = current else {
            return Ok(self.snapshot().await);
        };
        match workspace
            .probe_transport_if_stale(WAKE_PROBE_AGE, TRANSPORT_PROBE_TIMEOUT)
            .await
        {
            TransportProbeOutcome::Fresh => {}
            TransportProbeOutcome::Sampled => {
                if self.is_current(&workspace, epoch, lifecycle.id).await {
                    Self::emit_health(app, workspace.health_snapshot(epoch));
                    workspace.prepare_file_helper_channel();
                }
            }
            TransportProbeOutcome::Failed => {
                self.handle_transport_closed(workspace, epoch, lifecycle, app)
                    .await;
            }
        }
        Ok(self.snapshot().await)
    }

    /// 返回与当前 connected 快照一致的 workspace，其他阶段一律拒绝。
    pub async fn workspace(&self, profile_id: &str) -> Result<Arc<RemoteWorkspace>, String> {
        Ok(self.workspace_with_epoch(profile_id).await?.0)
    }

    /// 取出与首次前端 PTY 请求一致的预启动终端。
    pub async fn take_prepared_terminal(
        &self,
        profile_id: &str,
        cwd: Option<&str>,
        blocks: bool,
    ) -> Option<super::terminal::PreparedTerminal> {
        let mut slot = self.prepared_terminal.lock().await;
        if slot
            .as_ref()
            .is_some_and(|prepared| prepared.matches(profile_id, cwd, blocks))
        {
            slot.take()
        } else {
            None
        }
    }

    /// 返回后续终端是否需要让 Explorer 首目录先完成。
    pub fn should_gate_background_terminal(&self) -> bool {
        self.prepared_terminal_priority.load(Ordering::Acquire)
    }

    /// 原子返回当前 workspace 及其连接代际，供新建资源绑定正确 epoch。
    async fn workspace_with_epoch(
        &self,
        profile_id: &str,
    ) -> Result<(Arc<RemoteWorkspace>, u64), String> {
        let runtime = self.runtime.read().await;
        match (&runtime.snapshot, &runtime.workspace) {
            (
                RemoteRuntimeSnapshot::Connected {
                    profile_id: connected_profile,
                    epoch,
                    ..
                },
                Some(workspace),
            ) if connected_profile == profile_id && workspace.profile.id == profile_id => {
                Ok((workspace.clone(), *epoch))
            }
            _ => Err(format!("SSH profile {profile_id} is not connected")),
        }
    }

    /// 返回当前已连接 workspace 的可用根目录。
    pub async fn home(&self, profile_id: &str) -> Result<String, String> {
        Ok(self.workspace(profile_id).await?.home().await)
    }

    /// 在当前已连接 workspace 中执行一次有界远端命令。
    pub async fn exec(
        &self,
        profile_id: &str,
        command: &str,
        cwd: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutput, String> {
        let workspace = self.workspace(profile_id).await?;
        if self.foreground_filesystem_priority.load(Ordering::Acquire) {
            workspace.wait_for_foreground_filesystem().await;
        }
        workspace.exec(command, cwd, timeout).await
    }

    /// 将一条手动隧道绑定到当前 Runtime epoch 后启动。
    pub(super) async fn start_tunnel(
        &self,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        let (workspace, epoch) = self
            .workspace_with_epoch(&config.profile_id)
            .await
            .map_err(|message| TunnelFailure::new(None, message))?;
        self.tunnels.start(workspace, config, epoch).await
    }

    pub(super) async fn tunnel_info(&self, id: u64) -> Option<TunnelInfo> {
        self.tunnels.info(id).await
    }

    pub(super) async fn list_tunnels(&self, profile_id: &str) -> Vec<TunnelInfo> {
        self.tunnels.list(profile_id).await
    }

    /// 在当前 Runtime epoch 中原子替换一条隧道。
    pub(super) async fn update_tunnel(
        &self,
        id: u64,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        let (workspace, epoch) = self
            .workspace_with_epoch(&config.profile_id)
            .await
            .map_err(|message| TunnelFailure::new(None, message))?;
        self.tunnels.replace(id, workspace, config, epoch).await
    }

    /// 停止并移除一条当前进程内的隧道。
    pub(super) async fn stop_tunnel(&self, id: u64) -> Result<Option<TunnelInfo>, TunnelFailure> {
        let Some(info) = self.tunnels.info(id).await else {
            return Ok(None);
        };
        let workspace = self.workspace(&info.profile_id).await.ok();
        self.tunnels.stop(id, workspace).await
    }

    pub fn emit_tunnel_event(
        app: &tauri::AppHandle,
        kind: TunnelEventKind,
        profile_id: &str,
        tunnel: Option<TunnelInfo>,
        message: Option<String>,
    ) {
        let _ = app.emit(
            "terax://ssh-tunnel",
            TunnelEvent {
                kind,
                profile_id: profile_id.to_string(),
                tunnel,
                message,
            },
        );
    }

    fn emit_health(app: &tauri::AppHandle, snapshot: SshHealthSnapshot) {
        let _ = app.emit("terax://ssh-health", snapshot);
    }

    fn emit_tunnel_start(
        app: &tauri::AppHandle,
        profile_id: &str,
        started_profile: super::tunnel::ProfileTunnelStart,
    ) {
        for tunnel in started_profile.stopped {
            Self::emit_tunnel_event(
                app,
                TunnelEventKind::Stopped,
                profile_id,
                Some(tunnel),
                None,
            );
        }
        for result in started_profile.started {
            match result {
                Ok(tunnel) => Self::emit_tunnel_event(
                    app,
                    TunnelEventKind::Started,
                    profile_id,
                    Some(tunnel),
                    None,
                ),
                Err(error) => Self::emit_tunnel_event(
                    app,
                    TunnelEventKind::Failed,
                    profile_id,
                    error.info,
                    Some(error.message),
                ),
            }
        }
    }
}

static GLOBAL_MANAGER: OnceLock<Arc<RemoteManager>> = OnceLock::new();

/// 返回应用进程注册的唯一 RemoteManager。
pub fn global_manager() -> Result<Arc<RemoteManager>, String> {
    GLOBAL_MANAGER
        .get()
        .cloned()
        .ok_or_else(|| "Remote SSH manager is not initialized".to_string())
}

#[derive(Clone)]
/// 暴露给 Tauri command 的共享 SSH Runtime 状态。
pub struct RemoteState {
    pub manager: Arc<RemoteManager>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            manager: GLOBAL_MANAGER
                .get_or_init(|| Arc::new(RemoteManager::default()))
                .clone(),
        }
    }
}

/// 为同步文件系统边界执行一次有超时的远端命令。
pub fn exec_blocking(
    profile_id: &str,
    command: &str,
    cwd: Option<&str>,
    timeout: Duration,
) -> Result<ExecOutput, String> {
    let manager = global_manager()?;
    tauri::async_runtime::block_on(manager.exec(profile_id, command, cwd, timeout))
}

#[cfg(test)]
mod tests {
    use super::{
        reconnect_delay, RemoteManager, HEALTH_MONITOR_TICK, IDLE_PROBE_AGE,
        TRANSPORT_CLEANUP_TIMEOUT, TRANSPORT_PROBE_TIMEOUT,
    };
    use crate::modules::remote::models::ForegroundIntent;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    #[test]
    fn idle_transport_is_probed_within_a_bounded_window() {
        assert!(
            IDLE_PROBE_AGE + HEALTH_MONITOR_TICK + TRANSPORT_PROBE_TIMEOUT
                <= Duration::from_secs(50)
        );
        assert!(TRANSPORT_CLEANUP_TIMEOUT <= Duration::from_secs(1));
    }

    #[test]
    fn reconnect_attempts_start_immediately_then_back_off() {
        assert_eq!(reconnect_delay(1), Duration::ZERO);
        assert_eq!(reconnect_delay(2), Duration::from_secs(1));
        assert_eq!(reconnect_delay(7), Duration::from_secs(5));
    }

    #[tokio::test]
    async fn newer_explicit_intent_cancels_the_previous_runtime_lifecycle() {
        let manager = RemoteManager::default();
        let first = manager.begin_lifecycle().await;
        let second = manager.begin_lifecycle().await;

        assert!(first.cancellation.is_cancelled());
        assert!(!second.cancellation.is_cancelled());
        assert!(!manager.is_lifecycle_current(first.id).await);
        assert!(manager.is_lifecycle_current(second.id).await);
    }

    #[tokio::test]
    async fn filesystem_priority_survives_consuming_the_startup_intent() {
        let manager = RemoteManager::default();
        manager
            .set_foreground_intent(ForegroundIntent::Explorer)
            .await;
        *manager.foreground_intent.lock().await = None;

        assert!(manager
            .foreground_filesystem_priority
            .load(Ordering::Acquire));

        manager.set_foreground_intent(ForegroundIntent::None).await;
        assert!(!manager
            .foreground_filesystem_priority
            .load(Ordering::Acquire));
    }
}
