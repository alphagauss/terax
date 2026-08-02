//! 当前进程唯一 SSH Runtime 的连接、重连与资源生命周期协调。
//!
//! 所有状态迁移由本模块串行发布；新 transport 通过 shell、Workspace root 与 SFTP
//! 探测后才获得新 epoch。旧 workspace 的迟到失败只能结束自身，不能覆盖新连接。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use super::host_key::HostKeyVerifier;
use super::models::{
    ConnectRequest, RemoteRuntimeSnapshot, TunnelConfig, TunnelEvent, TunnelEventKind, TunnelInfo,
};
use super::session::{ExecOutput, RemoteWorkspace};
use super::tunnel::{TunnelFailure, TunnelManager};

const TRANSPORT_PROBE_INTERVAL: Duration = Duration::from_secs(2);
const TRANSPORT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const TRANSPORT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const CONNECT_SUPERSEDED: &str = "SSH connection attempt was superseded";

#[derive(Clone)]
struct RuntimeLifecycle {
    id: u64,
    cancellation: CancellationToken,
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
    next_version: AtomicU64,
    next_epoch: AtomicU64,
    next_lifecycle: AtomicU64,
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
            next_version: AtomicU64::new(1),
            next_epoch: AtomicU64::new(1),
            next_lifecycle: AtomicU64::new(1),
            host_keys: Arc::new(HostKeyVerifier::new(path)),
            tunnels: TunnelManager::default(),
        }
    }
}

impl RemoteManager {
    /// 破坏式建立当前进程唯一的 SSH Runtime。
    ///
    /// 已有 workspace 会先被完整关闭。新连接必须完成 root 与 SFTP 探测才能发布
    /// `connected`，失败后保持 `disconnected`，不会回退复用旧 transport。
    pub async fn connect(
        self: &Arc<Self>,
        request: ConnectRequest,
        app: tauri::AppHandle,
    ) -> Result<RemoteRuntimeSnapshot, String> {
        let lifecycle = self.begin_lifecycle().await;
        if !self
            .publish_connecting(&app, &lifecycle, &request.profile.id)
            .await
        {
            return Err(CONNECT_SUPERSEDED.into());
        }
        let _guard = self.connect_lock.lock().await;
        if !self.is_lifecycle_current(lifecycle.id).await {
            return Err(CONNECT_SUPERSEDED.into());
        }
        self.stop_current(&app).await;
        let profile_id = request.profile.id.clone();
        let result = self.connect_locked(request, &lifecycle, &app).await;
        if let Err(error) = &result {
            if error != CONNECT_SUPERSEDED && self.is_lifecycle_current(lifecycle.id).await {
                self.publish_disconnected(&app, &lifecycle, &profile_id, error.clone())
                    .await;
            }
        }
        result
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
        );
        let workspace = match tokio::select! {
            _ = lifecycle.cancellation.cancelled() => return Err(CONNECT_SUPERSEDED.into()),
            result = connect => result,
        } {
            Ok(workspace) => workspace,
            Err(error) => return Err(error),
        };

        if !self.is_lifecycle_current(lifecycle.id).await {
            workspace.disconnect().await;
            return Err(CONNECT_SUPERSEDED.into());
        }

        let home = workspace.home().await;
        let sftp_probe = super::sftp::stat(&workspace, &home);
        let sftp_result = tokio::select! {
            _ = lifecycle.cancellation.cancelled() => {
                workspace.disconnect().await;
                return Err(CONNECT_SUPERSEDED.into());
            }
            result = sftp_probe => result,
        };
        if let Err(error) = sftp_result {
            workspace.disconnect().await;
            if !self.is_lifecycle_current(lifecycle.id).await {
                return Err(CONNECT_SUPERSEDED.into());
            }
            let error = format!("initialize SSH filesystem at {home}: {error}");
            return Err(error);
        }

        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
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
            workspace.disconnect().await;
            return Err(CONNECT_SUPERSEDED.into());
        }
        self.tunnels.activate_profile_epoch(&profile_id, epoch);
        let _ = app.emit("terax://ssh-runtime", snapshot.clone());
        self.spawn_monitor(workspace.clone(), epoch, lifecycle.clone(), app.clone());
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

    /// 关闭并移除当前 epoch 的 workspace 与隧道。
    async fn stop_current(&self, app: &tauri::AppHandle) {
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
                tokio::time::sleep(TRANSPORT_PROBE_INTERVAL).await;
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                if lifecycle.cancellation.is_cancelled()
                    || !manager.is_current(&workspace, epoch, lifecycle.id).await
                {
                    return;
                }
                if !workspace.probe_transport(TRANSPORT_PROBE_TIMEOUT).await {
                    manager
                        .handle_transport_closed(workspace, epoch, lifecycle, &app)
                        .await;
                    return;
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
                _ = tokio::time::sleep(Duration::from_secs((attempt as u64).min(5))) => {}
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

    /// 返回与当前 connected 快照一致的 workspace，其他阶段一律拒绝。
    pub async fn workspace(&self, profile_id: &str) -> Result<Arc<RemoteWorkspace>, String> {
        Ok(self.workspace_with_epoch(profile_id).await?.0)
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
        self.workspace(profile_id)
            .await?
            .exec(command, cwd, timeout)
            .await
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
        RemoteManager, TRANSPORT_CLEANUP_TIMEOUT, TRANSPORT_PROBE_INTERVAL, TRANSPORT_PROBE_TIMEOUT,
    };
    use std::time::Duration;

    #[test]
    fn silent_transport_failure_is_detected_within_five_seconds() {
        assert!(TRANSPORT_PROBE_INTERVAL + TRANSPORT_PROBE_TIMEOUT <= Duration::from_secs(5));
        assert!(TRANSPORT_CLEANUP_TIMEOUT <= Duration::from_secs(1));
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
}
