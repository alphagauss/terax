//! SSH 连接、transport 健康与流量、终端和隧道的 Tauri command 适配层。
//!
//! 文件传输命令由 transfers 子系统统一提供，本模块不保留可绕过任务管理器的入口。

use crate::modules::workspace_process::WorkspaceProcessState;
use crate::modules::{secrets, secrets::SecretsState};

use super::manager::RemoteState;
use super::models::{
    ConnectRequest, CredentialOverride, ForegroundIntent, ImportedHost, RemoteRuntimeSnapshot,
    SshAuthMethod, SshHealthSnapshot, SshProfile, SshTrafficSnapshot, TunnelConfig,
    TunnelEventKind, TunnelInfo,
};

const SSH_SECRET_SERVICE: &str = "terax-ssh";

/// 将 profile、单次凭据覆盖或系统密钥链合并为内存连接请求。
fn connect_request(
    profile: SshProfile,
    credentials: Option<CredentialOverride>,
    app: &tauri::AppHandle,
    secrets_state: &SecretsState,
) -> Result<ConnectRequest, String> {
    let (secret, proxy_secret) = match credentials {
        Some(credentials) => (
            credentials.secret.filter(|value| !value.is_empty()),
            credentials.proxy_secret.filter(|value| !value.is_empty()),
        ),
        None => {
            let secret = if profile.auth_method == SshAuthMethod::Agent {
                None
            } else {
                secrets::get(app, secrets_state, SSH_SECRET_SERVICE, &profile.id)?
                    .filter(|value| !value.is_empty())
            };
            let proxy_secret = if profile
                .proxy_url
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                secrets::get(
                    app,
                    secrets_state,
                    SSH_SECRET_SERVICE,
                    &format!("{}:proxy", profile.id),
                )?
                .filter(|value| !value.is_empty())
            } else {
                None
            };
            (secret, proxy_secret)
        }
    };
    Ok(ConnectRequest {
        profile,
        secret,
        proxy_secret,
    })
}

/// 使用持久化 profile 和密钥链内容建立一次连接。
pub(crate) async fn connect_saved_profile(
    state: &RemoteState,
    workspace: &WorkspaceProcessState,
    secrets_state: &SecretsState,
    app: tauri::AppHandle,
    profile_id: String,
    credentials: Option<CredentialOverride>,
) -> Result<RemoteRuntimeSnapshot, String> {
    let profile = super::profile::load(&profile_id)?;
    profile.validate()?;
    workspace.assert_ssh_runtime_owner(&profile)?;
    let request = connect_request(profile, credentials, &app, secrets_state)?;
    state.manager.connect(request, app).await
}

/// 启动期先发布 connecting，再读取系统凭据并建立连接。
pub(crate) async fn connect_startup_profile(
    state: &RemoteState,
    workspace: &WorkspaceProcessState,
    secrets_state: &SecretsState,
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<RemoteRuntimeSnapshot, String> {
    let reserved = state.manager.reserve_connect(&profile_id, &app).await?;
    let request = match (|| {
        let profile = super::profile::load(&profile_id)?;
        profile.validate()?;
        workspace.assert_ssh_runtime_owner(&profile)?;
        connect_request(profile, None, &app, secrets_state)
    })() {
        Ok(request) => request,
        Err(error) => {
            state
                .manager
                .reject_reserved(&reserved, &app, error.clone())
                .await;
            return Err(error);
        }
    };
    state.manager.connect_reserved(request, reserved, app).await
}

#[tauri::command]
/// 建立当前 SSH Workspace 唯一 Runtime，并返回权威快照。
pub async fn ssh_runtime_connect(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    secrets_state: tauri::State<'_, SecretsState>,
    app: tauri::AppHandle,
    profile_id: String,
    credentials: Option<CredentialOverride>,
) -> Result<RemoteRuntimeSnapshot, String> {
    connect_saved_profile(
        &state,
        &workspace,
        &secrets_state,
        app,
        profile_id,
        credentials,
    )
    .await
}

#[tauri::command]
/// 取消连接或恢复流程并释放当前 Runtime。
pub async fn ssh_runtime_disconnect(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.manager.disconnect(&app).await
}

#[tauri::command]
/// 返回当前 Runtime 的权威状态快照。
pub async fn ssh_runtime_snapshot(
    state: tauri::State<'_, RemoteState>,
) -> Result<RemoteRuntimeSnapshot, String> {
    Ok(state.manager.snapshot().await)
}

#[tauri::command]
/// 返回当前应用进程累计的 SSH transport 收发字节。
pub fn ssh_traffic_snapshot(state: tauri::State<'_, RemoteState>) -> SshTrafficSnapshot {
    state.manager.traffic_snapshot()
}

#[tauri::command]
/// 返回当前 connected epoch 最近一次低频 SSH RTT 样本。
pub async fn ssh_health_snapshot(
    state: tauri::State<'_, RemoteState>,
) -> Result<SshHealthSnapshot, String> {
    Ok(state.manager.health_snapshot().await)
}

#[tauri::command]
/// 窗口激活时确认当前 transport，必要时立即进入统一重连流程。
pub async fn ssh_runtime_wake(
    state: tauri::State<'_, RemoteState>,
    app: tauri::AppHandle,
) -> Result<RemoteRuntimeSnapshot, String> {
    state.manager.wake(&app).await
}

#[tauri::command]
/// 提交本地恢复状态中的前台资源，不触发新的连接生命周期。
pub async fn ssh_runtime_set_foreground(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    intent: ForegroundIntent,
) -> Result<(), String> {
    if workspace.bootstrap().env.ssh_profile_id().is_none() {
        return Err("foreground SSH intent requires an SSH Workspace".to_string());
    }
    if let ForegroundIntent::Terminal { cwd: Some(cwd), .. } = &intent {
        super::session::validate_remote_path(cwd)?;
    }
    state.manager.set_foreground_intent(intent).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_confirm_host_key(
    state: tauri::State<'_, RemoteState>,
    request_id: String,
    accepted: bool,
    remember: bool,
) -> Result<(), String> {
    state
        .manager
        .host_keys
        .confirm(&request_id, accepted, remember)
        .await
}

#[tauri::command]
/// 返回事件桥注册前已经产生的主机密钥提示。
pub async fn ssh_pending_host_key(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
) -> Result<Option<super::host_key::HostKeyPrompt>, String> {
    let profile_id = workspace
        .bootstrap()
        .env
        .ssh_profile_id()
        .ok_or_else(|| "host-key prompts require an SSH Workspace".to_string())?;
    Ok(state.manager.host_keys.pending_prompt(profile_id).await)
}

#[tauri::command]
pub async fn ssh_import_config() -> Result<Vec<ImportedHost>, String> {
    Ok(super::ssh_config::parse_default())
}

#[tauri::command]
pub async fn ssh_tunnel_start(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    app: tauri::AppHandle,
    config: TunnelConfig,
) -> Result<TunnelInfo, String> {
    workspace.assert_ssh_tunnel_owner(&config.profile_id)?;
    let profile_id = config.profile_id.clone();
    match state.manager.start_tunnel(config).await {
        Ok(tunnel) => {
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Started,
                &profile_id,
                Some(tunnel.clone()),
                None,
            );
            Ok(tunnel)
        }
        Err(error) => {
            let message = error.message;
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Failed,
                &profile_id,
                error.info,
                Some(message.clone()),
            );
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    app: tauri::AppHandle,
    id: u64,
) -> Result<(), String> {
    let Some(existing) = state.manager.tunnel_info(id).await else {
        return Ok(());
    };
    workspace.assert_ssh_tunnel_owner(&existing.profile_id)?;
    match state.manager.stop_tunnel(id).await {
        Ok(Some(tunnel)) => {
            let profile_id = tunnel.profile_id.clone();
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Stopped,
                &profile_id,
                Some(tunnel),
                None,
            );
        }
        Ok(None) => {}
        Err(error) => {
            let message = error.message;
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Failed,
                &existing.profile_id,
                error.info,
                Some(message.clone()),
            );
            return Err(message);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_tunnel_update(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    app: tauri::AppHandle,
    id: u64,
    config: TunnelConfig,
) -> Result<TunnelInfo, String> {
    let Some(existing) = state.manager.tunnel_info(id).await else {
        return Err(format!("SSH tunnel {id} was not found"));
    };
    workspace.assert_ssh_tunnel_owner(&existing.profile_id)?;
    if config.profile_id != existing.profile_id {
        return Err("SSH tunnel profile cannot be changed".into());
    }
    match state.manager.update_tunnel(id, config).await {
        Ok(tunnel) => {
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Updated,
                &tunnel.profile_id,
                Some(tunnel.clone()),
                None,
            );
            Ok(tunnel)
        }
        Err(error) => {
            let message = error.message;
            super::manager::RemoteManager::emit_tunnel_event(
                &app,
                TunnelEventKind::Failed,
                &existing.profile_id,
                error.info,
                Some(message.clone()),
            );
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn ssh_tunnel_list(
    state: tauri::State<'_, RemoteState>,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    profile_id: String,
) -> Result<Vec<TunnelInfo>, String> {
    workspace.assert_ssh_tunnel_owner(&profile_id)?;
    Ok(state.manager.list_tunnels(&profile_id).await)
}
