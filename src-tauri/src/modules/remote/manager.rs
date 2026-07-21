use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::RwLock;

use super::host_key::HostKeyVerifier;
use super::models::{
    ConnectRequest, ConnectionInfo, ConnectionStatus, SshProfile, TunnelConfig, TunnelEvent,
    TunnelEventKind, TunnelInfo,
};
use super::session::{ExecOutput, RemoteWorkspace};
use super::tunnel::{TunnelFailure, TunnelManager};

pub struct RemoteManager {
    workspaces: RwLock<HashMap<String, Arc<RemoteWorkspace>>>,
    statuses: RwLock<HashMap<String, ConnectionInfo>>,
    connect_locks: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub host_keys: Arc<HostKeyVerifier>,
    tunnels: TunnelManager,
}

impl Default for RemoteManager {
    fn default() -> Self {
        let path = crate::modules::app_data::directory(crate::modules::app_data::Directory::Ssh)
            .expect("Terax SSH data directory is unavailable")
            .join("known_hosts");
        Self {
            workspaces: RwLock::new(HashMap::new()),
            statuses: RwLock::new(HashMap::new()),
            connect_locks: StdMutex::new(HashMap::new()),
            host_keys: Arc::new(HostKeyVerifier::new(path)),
            tunnels: TunnelManager::default(),
        }
    }
}

impl RemoteManager {
    pub async fn connect(
        self: &Arc<Self>,
        request: ConnectRequest,
        app: tauri::AppHandle,
    ) -> Result<ConnectionInfo, String> {
        let profile_id = request.profile.id.clone();
        let connect_lock = self.connect_lock(&profile_id);
        let _connect_guard = connect_lock.lock().await;
        self.set_status(
            &app,
            ConnectionInfo {
                profile_id: profile_id.clone(),
                status: ConnectionStatus::Connecting,
                home: None,
                message: None,
            },
        )
        .await;

        // Keep the previous workspace registered until the replacement has
        // authenticated successfully. This preserves reconnect credentials and
        // tunnel configs across a failed attempt instead of turning one network
        // hiccup into a permanently disconnected workspace.
        let previous = self.workspaces.read().await.get(&profile_id).cloned();
        let saved_tunnels = self.tunnels.active_configs(&profile_id).await;

        let workspace =
            match RemoteWorkspace::connect(request, app.clone(), self.host_keys.clone()).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    let previous_is_open = match previous.as_ref() {
                        Some(previous) => !previous.is_closed().await,
                        None => false,
                    };
                    let previous_home = match previous.as_ref() {
                        Some(previous) if previous_is_open => Some(previous.home().await),
                        _ => None,
                    };
                    let message = if previous_is_open {
                        format!(
                        "Reconnect failed; the previous SSH connection is still active: {error}"
                    )
                    } else {
                        error.clone()
                    };
                    self.set_status(
                        &app,
                        ConnectionInfo {
                            profile_id,
                            status: if previous_is_open {
                                ConnectionStatus::Connected
                            } else {
                                ConnectionStatus::Error
                            },
                            home: previous_home,
                            message: Some(message),
                        },
                    )
                    .await;
                    return Err(error);
                }
            };
        let home = workspace.home().await;
        if let Some(previous) = previous.as_ref() {
            for tunnel in self
                .tunnels
                .stop_profile(&profile_id, previous.clone())
                .await
            {
                Self::emit_tunnel_event(
                    &app,
                    TunnelEventKind::Stopped,
                    &profile_id,
                    Some(tunnel),
                    None,
                );
            }
        }
        self.workspaces
            .write()
            .await
            .insert(profile_id.clone(), workspace.clone());
        if let Some(previous) = previous {
            previous.disconnect().await;
        }
        let info = ConnectionInfo {
            profile_id: profile_id.clone(),
            status: ConnectionStatus::Connected,
            home: Some(home),
            message: None,
        };
        self.set_status(&app, info.clone()).await;

        for config in saved_tunnels {
            match self.tunnels.start(workspace.clone(), config).await {
                Ok(tunnel) => Self::emit_tunnel_event(
                    &app,
                    TunnelEventKind::Started,
                    &profile_id,
                    Some(tunnel),
                    None,
                ),
                Err(error) => {
                    log::warn!("failed to restore SSH tunnel: {}", error.message);
                    Self::emit_tunnel_event(
                        &app,
                        TunnelEventKind::Failed,
                        &profile_id,
                        error.info,
                        Some(error.message),
                    );
                }
            }
        }
        self.spawn_monitor(workspace, app);
        Ok(info)
    }

    fn connect_lock(&self, profile_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .connect_locks
            .lock()
            .expect("SSH connect lock poisoned");
        locks
            .entry(profile_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn spawn_monitor(self: &Arc<Self>, workspace: Arc<RemoteWorkspace>, app: tauri::AppHandle) {
        let manager = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                if !manager.is_current(&workspace).await {
                    return;
                }
                if !workspace.is_closed().await {
                    continue;
                }
                let profile = workspace.profile.clone();
                manager
                    .set_status(
                        &app,
                        ConnectionInfo {
                            profile_id: profile.id.clone(),
                            status: ConnectionStatus::Disconnected,
                            home: Some(workspace.home().await),
                            message: Some("SSH connection closed".into()),
                        },
                    )
                    .await;
                if !profile.reconnect_enabled {
                    return;
                }
                let request = workspace.reconnect_request();
                for attempt in 1..=profile.reconnect_max_attempts.max(1) {
                    if !manager.is_current(&workspace).await {
                        return;
                    }
                    manager
                        .set_status(
                            &app,
                            ConnectionInfo {
                                profile_id: profile.id.clone(),
                                status: ConnectionStatus::Reconnecting,
                                home: Some(workspace.home().await),
                                message: Some(format!(
                                    "Reconnect attempt {attempt}/{}",
                                    profile.reconnect_max_attempts.max(1)
                                )),
                            },
                        )
                        .await;
                    tokio::time::sleep(Duration::from_secs((attempt as u64).min(5))).await;
                    match manager.connect(request.clone(), app.clone()).await {
                        Ok(_) => return,
                        Err(error) => log::warn!("SSH reconnect attempt {attempt} failed: {error}"),
                    }
                }
                return;
            }
        });
    }

    async fn is_current(&self, workspace: &Arc<RemoteWorkspace>) -> bool {
        self.workspaces
            .read()
            .await
            .get(&workspace.profile.id)
            .is_some_and(|current| Arc::ptr_eq(current, workspace))
    }

    pub async fn reconnect(
        self: &Arc<Self>,
        profile_id: &str,
        app: tauri::AppHandle,
    ) -> Result<ConnectionInfo, String> {
        let request = self.workspace(profile_id).await?.reconnect_request();
        self.connect(request, app).await
    }

    pub async fn disconnect(&self, profile_id: &str, app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(workspace) = self.workspaces.write().await.remove(profile_id) {
            for tunnel in self
                .tunnels
                .stop_profile(profile_id, workspace.clone())
                .await
            {
                Self::emit_tunnel_event(
                    app,
                    TunnelEventKind::Stopped,
                    profile_id,
                    Some(tunnel),
                    None,
                );
            }
            workspace.disconnect().await;
        }
        self.set_status(
            app,
            ConnectionInfo {
                profile_id: profile_id.to_string(),
                status: ConnectionStatus::Disconnected,
                home: None,
                message: None,
            },
        )
        .await;
        Ok(())
    }

    pub async fn workspace(&self, profile_id: &str) -> Result<Arc<RemoteWorkspace>, String> {
        self.workspaces
            .read()
            .await
            .get(profile_id)
            .cloned()
            .ok_or_else(|| format!("SSH profile {profile_id} is not connected"))
    }

    pub async fn home(&self, profile_id: &str) -> Result<String, String> {
        Ok(self.workspace(profile_id).await?.home().await)
    }

    pub async fn status(&self, profile_id: &str) -> ConnectionInfo {
        self.statuses
            .read()
            .await
            .get(profile_id)
            .cloned()
            .unwrap_or(ConnectionInfo {
                profile_id: profile_id.to_string(),
                status: ConnectionStatus::Disconnected,
                home: None,
                message: None,
            })
    }

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

    pub(super) async fn start_tunnel(
        &self,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        let workspace = self
            .workspace(&config.profile_id)
            .await
            .map_err(|message| TunnelFailure::new(None, message))?;
        self.tunnels.start(workspace, config).await
    }

    pub(super) async fn tunnel_info(&self, id: u64) -> Option<TunnelInfo> {
        self.tunnels.info(id).await
    }

    pub(super) async fn list_tunnels(&self, profile_id: &str) -> Vec<TunnelInfo> {
        self.tunnels.list(profile_id).await
    }

    pub(super) async fn update_tunnel(
        &self,
        id: u64,
        config: TunnelConfig,
    ) -> Result<TunnelInfo, TunnelFailure> {
        let workspace = self
            .workspace(&config.profile_id)
            .await
            .map_err(|message| TunnelFailure::new(None, message))?;
        self.tunnels.replace(id, workspace, config).await
    }

    pub(super) async fn stop_tunnel(&self, id: u64) -> Result<Option<TunnelInfo>, TunnelFailure> {
        let info = self.tunnels.info(id).await;
        let workspace = match info {
            Some(info) => self.workspace(&info.profile_id).await.ok(),
            None => None,
        };
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

    async fn set_status(&self, app: &tauri::AppHandle, info: ConnectionInfo) {
        self.statuses
            .write()
            .await
            .insert(info.profile_id.clone(), info.clone());
        let _ = app.emit("terax://ssh-status", info);
    }
}

static GLOBAL_MANAGER: OnceLock<Arc<RemoteManager>> = OnceLock::new();

pub fn global_manager() -> Result<Arc<RemoteManager>, String> {
    GLOBAL_MANAGER
        .get()
        .cloned()
        .ok_or_else(|| "Remote SSH manager is not initialized".to_string())
}

#[derive(Clone)]
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

pub fn exec_blocking(
    profile_id: &str,
    command: &str,
    cwd: Option<&str>,
    timeout: Duration,
) -> Result<ExecOutput, String> {
    let manager = global_manager()?;
    tauri::async_runtime::block_on(manager.exec(profile_id, command, cwd, timeout))
}

#[allow(dead_code)]
pub fn profile_from_workspace(workspace: &Arc<RemoteWorkspace>) -> SshProfile {
    workspace.profile.clone()
}
