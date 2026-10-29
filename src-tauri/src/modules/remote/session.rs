//! SSH transport、认证、远端环境探测与命令执行。
//!
//! 每个 Remote Workspace 复用一条 transport，并为终端、SFTP、命令和隧道打开独立
//! channel。激活终端可在同一 PTY 中确认 Workspace root；两类 SFTP 从认证完成后预热，
//! 文件保存可在上传期间预开提交 channel，所有 session 经统一额度准入，
//! transport 失败和 RTT 统一进入进程级健康监督器。
//! 命令与 channel 生命周期参考 Eussh 的 `ssh/session.rs`，认证、代理与远程转发行为
//! 补充参考 meatshell。

use crate::modules::network_proxy::{self, ProxyConfig, SshProxyMode};
use crate::modules::secrets::{self, SecretsState};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

use russh::client::{self, Handle, Handler, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect, Sig};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::channels::{SessionChannel, SessionChannels};
use super::health::SshTransportHealth;
use super::host_key::HostKeyVerifier;
use super::models::{
    ConnectRequest, ForegroundIntent, SshAuthMethod, SshCapabilitySnapshot, SshHealthSnapshot,
    SshProfile, SshTaskFallback,
};
use super::remote_fs::RemoteFs;
use super::tasks::{RemoteTaskRuntime, TaskKind};
use super::traffic::{CountingSshStream, SshTrafficMeter};
use super::tunnel::{copy_bidirectional_counted, RemoteForwardRegistry};

const MAX_EXEC_OUTPUT: usize = 16 * 1024 * 1024;
pub(crate) const EXEC_CANCELLED_ERROR: &str = "remote command cancelled";

/// 处理 SSH 客户端事件、主机密钥确认和远端转发请求。
pub struct ClientHandler {
    pub app: tauri::AppHandle,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub host_keys: Arc<HostKeyVerifier>,
    pub(super) remote_forwards: RemoteForwardRegistry,
    pub cancellation: CancellationToken,
    host_key_rejected: Arc<AtomicBool>,
    health: Arc<SshTransportHealth>,
    pub(crate) channels: Arc<SessionChannels>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        key: &PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let host_keys = self.host_keys.clone();
        let app = self.app.clone();
        let profile_id = self.profile_id.clone();
        let host = self.host.clone();
        let port = self.port;
        let key = key.clone();
        let cancellation = self.cancellation.clone();
        let host_key_rejected = self.host_key_rejected.clone();
        async move {
            let accepted = host_keys
                .check(&app, &profile_id, &host, port, &key, &cancellation)
                .await;
            if !accepted && !cancellation.is_cancelled() {
                host_key_rejected.store(true, Ordering::Release);
            }
            Ok(accepted)
        }
    }

    fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<Self::Error>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let health = self.health.clone();
        self.channels.disconnect();
        async move {
            health.mark_failed();
            match reason {
                russh::client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
                russh::client::DisconnectReason::Error(error) => Err(error),
            }
        }
    }

    async fn channel_close(
        &mut self,
        channel: russh::ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.channels.closed(channel.into());
        Ok(())
    }

    async fn channel_open_failure(
        &mut self,
        channel: russh::ChannelId,
        reason: russh::ChannelOpenFailure,
        description: &str,
        _language: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::warn!("SSH_SESSION event=server_rejected connection={} profile={} channel={channel} reason={reason:?} description={description:?}", self.channels.connection, self.profile_id);
        Ok(())
    }

    fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let target = self
            .remote_forwards
            .lookup(connected_address, connected_port);
        let connected_address = connected_address.to_string();
        async move {
            if let Some(target) = target {
                let connections = target.connections.clone();
                connections.spawn(async move {
                    match tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await
                    {
                        Ok(mut socket) => {
                            let mut stream = channel.into_stream();
                            let _ =
                                copy_bidirectional_counted(&mut socket, &mut stream, target.bytes)
                                    .await;
                        }
                        Err(error) => log::warn!(
                            "remote tunnel target {}:{} failed: {error}",
                            target.host,
                            target.port
                        ),
                    }
                });
            } else {
                log::warn!(
                    "received unregistered remote forward {connected_address}:{connected_port}"
                );
            }
            Ok(())
        }
    }
}

/// 一条已认证 SSH transport 及其可复用凭据和派生 channel 状态。
pub struct RemoteWorkspace {
    pub profile: SshProfile,
    pub handle: Arc<Handle<ClientHandler>>,
    pub(super) remote_forwards: RemoteForwardRegistry,
    pub(crate) remote_fs: RemoteFs,
    home: RwLock<String>,
    login_home: RwLock<String>,
    secret: Zeroizing<String>,
    proxy_secret_override: Option<Zeroizing<String>>,
    health: Arc<SshTransportHealth>,
    pub(crate) channels: Arc<SessionChannels>,
    probe_lock: Mutex<()>,
    pub(crate) tasks: Arc<RemoteTaskRuntime>,
    runtime_epoch: AtomicU64,
    app: tauri::AppHandle,
}

/// 一次统一 transport 健康检查的结果。
pub(crate) enum TransportProbeOutcome {
    Fresh,
    Sampled,
    Failed,
}

/// 完成认证与前台探测后的 Workspace 资源。
pub struct WorkspaceConnect {
    pub workspace: Arc<RemoteWorkspace>,
    pub prepared_terminal: Option<super::terminal::PreparedTerminal>,
}

/// 建连失败原因及前端是否应立即请求新凭据。
pub(crate) struct ConnectFailure {
    pub message: String,
    pub credentials_required: bool,
    pub retryable: bool,
}

impl ConnectFailure {
    fn transport(message: String, host_key_rejected: bool) -> Self {
        if host_key_rejected {
            message.into()
        } else {
            Self::retryable(message)
        }
    }

    fn retryable(message: String) -> Self {
        Self {
            message,
            credentials_required: false,
            retryable: true,
        }
    }

    fn credentials(message: String) -> Self {
        Self {
            message,
            credentials_required: true,
            retryable: false,
        }
    }
}

impl From<String> for ConnectFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            credentials_required: false,
            retryable: false,
        }
    }
}

impl From<&str> for ConnectFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl RemoteWorkspace {
    /// 资源回收请求按连接合并，前端只处理当前 epoch 的隐藏空闲终端。
    pub(crate) fn request_session_reclaim(&self) -> bool {
        if self.channels.request_reclaim() {
            log::info!(
                "SSH_SESSION event=terminal_reclaim_requested connection={} epoch={}",
                self.channels.connection,
                self.epoch()
            );
            return tauri::Emitter::emit(&self.app, "terax://ssh-session-pressure", self.epoch())
                .is_ok();
        }
        false
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.runtime_epoch.load(Ordering::Acquire)
    }

    pub(crate) async fn open_session(
        &self,
        purpose: &'static str,
    ) -> Result<SessionChannel, String> {
        self.channels.open(self, purpose).await
    }

    /// 建立 SSH transport，并确认远端 Linux、bash 与 Workspace root。
    ///
    /// SFTP 与环境探测并行预热，但只由首次文件请求观察其结果，避免文件子系统阻塞终端。
    pub(super) async fn connect(
        request: ConnectRequest,
        app: tauri::AppHandle,
        host_keys: Arc<HostKeyVerifier>,
        cancellation: CancellationToken,
        foreground_intent: Arc<Mutex<Option<ForegroundIntent>>>,
        foreground_filesystem_priority: Arc<AtomicBool>,
        traffic: Arc<SshTrafficMeter>,
    ) -> Result<WorkspaceConnect, ConnectFailure> {
        let started_at = Instant::now();
        request.profile.validate()?;
        let profile = request.profile;
        let requested_root = profile
            .root_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("~")
            .to_string();
        let root_assignment = workspace_root_assignment(&requested_root)?;
        let secret = Zeroizing::new(request.secret.unwrap_or_default());
        let proxy_secret_override = request.proxy_secret_override.map(Zeroizing::new);
        let proxy = match profile.proxy_mode {
            SshProxyMode::Inherit => network_proxy::resolve_mode(
                &app.state::<secrets::SecretsState>(),
                network_proxy::ProxyMode::Inherit,
            )
            .await?
            .for_ssh(&profile.host, profile.port),
            SshProxyMode::Direct => None,
            SshProxyMode::Shared => Some(network_proxy::shared_proxy(
                &app.state::<secrets::SecretsState>(),
            )?),
            SshProxyMode::Custom => {
                // 未明确覆盖的密码每次建连重新读取，保存或清除凭据后不使用旧快照。
                let saved = if proxy_secret_override.is_none() {
                    secrets::get_value(
                        &app.state::<SecretsState>(),
                        super::profile::SECRET_SERVICE,
                        &format!("{}:proxy", profile.id),
                    )?
                } else {
                    None
                };
                Some(ProxyConfig::parse(
                    profile.proxy_url.as_deref().unwrap_or(""),
                    proxy_secret_override
                        .as_deref()
                        .map(String::as_str)
                        .or(saved.as_deref()),
                )?)
            }
        };

        // Keep russh's real client identifier. Advertising OpenSSH makes an
        // OpenSSH server enable private channel extensions such as
        // eow@openssh.com that russh does not implement.
        let config = Arc::new(client_config());

        let remote_forwards = RemoteForwardRegistry::default();
        let mut channels = Arc::new(SessionChannels::default());
        let host_key_rejected = Arc::new(AtomicBool::new(false));
        let handler =
            |health: Arc<SshTransportHealth>, channels: Arc<SessionChannels>| ClientHandler {
                app: app.clone(),
                profile_id: profile.id.clone(),
                host: profile.host.clone(),
                port: profile.port,
                host_keys: host_keys.clone(),
                remote_forwards: remote_forwards.clone(),
                cancellation: cancellation.clone(),
                host_key_rejected: host_key_rejected.clone(),
                health,
                channels,
            };
        let mut health = Arc::new(SshTransportHealth::new());
        let mut handle = connect_transport(
            &profile,
            proxy.as_ref(),
            config.clone(),
            handler(health.clone(), channels.clone()),
            traffic.clone(),
            health.clone(),
        )
        .await?;
        let transport_ready_at = Instant::now();

        if authenticate_primary(&mut handle, &profile, secret.as_str()).await?
            == PrimaryAuthResult::KeyboardInteractiveRequired
        {
            // Several servers and russh versions do not reliably continue
            // keyboard-interactive after a rejected password request. Match
            // meatshell's behavior and retry that method on a fresh transport.
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "Retry keyboard-interactive authentication",
                    "en",
                )
                .await;
            handle = {
                health = Arc::new(SshTransportHealth::new());
                channels = Arc::new(SessionChannels::default());
                connect_transport(
                    &profile,
                    proxy.as_ref(),
                    config,
                    handler(health.clone(), channels.clone()),
                    traffic,
                    health.clone(),
                )
                .await?
            };
            if !authenticate_keyboard_interactive(&mut handle, &profile.username, secret.as_str())
                .await?
            {
                return Err(ConnectFailure::credentials(
                    "SSH server rejected the supplied credentials".into(),
                ));
            }
        }
        let auth_ready_at = Instant::now();
        let workspace = Arc::new(Self {
            profile,
            handle: Arc::new(handle),
            remote_forwards,
            remote_fs: RemoteFs::default(),
            home: RwLock::new("/".into()),
            login_home: RwLock::new("/".into()),
            secret,
            proxy_secret_override,
            health,
            channels,
            probe_lock: Mutex::new(()),
            tasks: Arc::new(RemoteTaskRuntime::default()),
            runtime_epoch: AtomicU64::new(0),
            app: app.clone(),
        });
        let intent = foreground_intent
            .lock()
            .await
            .clone()
            .unwrap_or(ForegroundIntent::None);
        let prime_filesystem = intent != ForegroundIntent::None
            || foreground_filesystem_priority.load(Ordering::Acquire);
        if prime_filesystem {
            let read_filesystem = workspace.clone();
            tauri::async_runtime::spawn(async move {
                let started_at = Instant::now();
                match super::sftp::warm_read_session(&read_filesystem).await {
                    Ok(_) => log::info!(
                        "SSH read filesystem ready profile={} sftp_ms={}",
                        read_filesystem.profile.id,
                        started_at.elapsed().as_millis()
                    ),
                    Err(error) => {
                        if !read_filesystem.is_closed() {
                            log::warn!(
                                "SSH read filesystem warmup failed profile={}: {error}",
                                read_filesystem.profile.id
                            );
                        }
                    }
                }
            });
        }

        let probe_started_at = Instant::now();
        let foreground = match intent {
            ForegroundIntent::Terminal { cwd, blocks } => {
                match super::terminal::prepare(
                    workspace.clone(),
                    &root_assignment,
                    &requested_root,
                    cwd,
                    blocks,
                )
                .await
                {
                    Ok((prepared, probe)) => Ok((probe, Some(prepared))),
                    Err(error) => {
                        log::warn!(
                            "prepared SSH terminal failed profile={}: {error}",
                            workspace.profile.id
                        );
                        detect_workspace(&workspace, &root_assignment, &requested_root)
                            .await
                            .map_err(|mut probe_error| {
                                probe_error.message = format!(
                                    "{error}; fallback workspace probe failed: {}",
                                    probe_error.message
                                );
                                probe_error
                            })
                            .map(|probe| (probe, None))
                    }
                }
            }
            ForegroundIntent::Explorer | ForegroundIntent::None => {
                detect_workspace(&workspace, &root_assignment, &requested_root)
                    .await
                    .map(|probe| (probe, None))
            }
        };
        let (probe, prepared_terminal) = match foreground {
            Ok(foreground) => foreground,
            Err(error) => {
                workspace.disconnect().await;
                return Err(error);
            }
        };
        let probe_elapsed = probe_started_at.elapsed();
        *workspace.login_home.write().await = probe.login_home;
        *workspace.home.write().await = probe.root.clone();
        if prime_filesystem {
            let primed_workspace = workspace.clone();
            let primed_root = probe.root;
            tauri::async_runtime::spawn(async move {
                let _ = primed_workspace
                    .remote_fs
                    .read_dir(primed_workspace.clone(), primed_root, true)
                    .await;
            });
        }
        let ready_at = Instant::now();
        log::info!(
            "SSH Runtime ready profile={} transport_ms={} auth_ms={} probe_ms={} total_ms={}",
            workspace.profile.id,
            transport_ready_at.duration_since(started_at).as_millis(),
            auth_ready_at.duration_since(transport_ready_at).as_millis(),
            probe_elapsed.as_millis(),
            ready_at.duration_since(started_at).as_millis()
        );
        Ok(WorkspaceConnect {
            workspace,
            prepared_terminal,
        })
    }

    /// 每次自动重连读取最新代理设置，其余 Workspace 连接参数保持当前生命周期快照。
    pub fn reconnect_request(&self) -> Result<ConnectRequest, String> {
        let mut request = ConnectRequest {
            profile: self.profile.clone(),
            secret: (!self.secret.is_empty()).then(|| self.secret.to_string()),
            proxy_secret_override: self
                .proxy_secret_override
                .as_ref()
                .map(|secret| secret.to_string()),
        };
        request.refresh_proxy(&super::profile::load(&self.profile.id)?)?;
        Ok(request)
    }

    /// 返回已校验的 Workspace root。
    pub async fn home(&self) -> String {
        self.home.read().await.clone()
    }

    /// 返回远端账户登录 Home。
    pub async fn login_home(&self) -> String {
        self.login_home.read().await.clone()
    }

    /// 标记当前连接的内部任务失效，并立即发布绑定 epoch 的健康快照。
    pub(crate) fn mark_task_unavailable(
        self: &Arc<Self>,
        task: TaskKind,
        reason: impl Into<String>,
    ) {
        if self.tasks.mark_unavailable(task, reason) {
            let epoch = self.runtime_epoch.load(Ordering::Acquire);
            if epoch != 0 {
                let _ = tauri::Emitter::emit(
                    &self.app,
                    "terax://ssh-health",
                    self.health_snapshot(epoch),
                );
                self.emit_capability_snapshot();
            }
        }
    }

    /// 安装 manager 分配的 epoch，使降级提示不会污染后续连接。
    pub(crate) fn set_runtime_epoch(&self, epoch: u64) {
        self.runtime_epoch.store(epoch, Ordering::Release);
    }

    /// 返回绑定当前连接 epoch 的统一服务器能力快照。
    pub(crate) fn capability_snapshot(&self) -> SshCapabilitySnapshot {
        let mut snapshot = self
            .tasks
            .capability_snapshot(self.runtime_epoch.load(Ordering::Acquire));
        super::tasks::capability_probe::overlay_runtime_fallbacks(
            &mut snapshot,
            &self.tasks.unavailable_tasks(),
        );
        snapshot
    }

    /// 发布当前 epoch 的能力状态，旧连接事件由前端按 epoch 丢弃。
    pub(crate) fn emit_capability_snapshot(&self) {
        let snapshot = self.capability_snapshot();
        if snapshot.epoch.is_some() {
            let _ = tauri::Emitter::emit(&self.app, "terax://ssh-capabilities", snapshot);
        }
    }

    /// 等待 Explorer 首个目录完成，供非前台资源避免争抢启动 transport。
    pub async fn wait_for_foreground_filesystem(&self) {
        self.remote_fs.wait_for_first_directory().await;
    }

    /// 判断 transport 是否已被探活永久失效或底层 session 已关闭。
    pub fn is_closed(&self) -> bool {
        self.health.is_failed() || self.handle.is_closed()
    }

    /// 返回当前 epoch 的进程级 SSH RTT 快照。
    pub(crate) fn health_snapshot(&self, epoch: u64) -> SshHealthSnapshot {
        let mut snapshot = self.health.snapshot(epoch);
        snapshot.file_write_fallback = [
            TaskKind::FileWriteChecked,
            TaskKind::FileWriteMissing,
            TaskKind::FileWriteOverwrite,
        ]
        .into_iter()
        .any(|task| self.tasks.is_unavailable(task));
        snapshot.task_fallbacks = self
            .tasks
            .unavailable_tasks()
            .into_iter()
            .map(|(task, reason)| SshTaskFallback { task, reason })
            .collect();
        snapshot
    }

    /// 判断统一监督器是否需要发送空闲保活或 RTT 采样。
    pub(crate) fn health_probe_due(&self, idle_age: Duration, max_rtt_age: Duration) -> bool {
        self.health.probe_due(idle_age, max_rtt_age)
    }

    /// 等待底层 transport 明确关闭或被业务边界确认失效。
    pub(crate) async fn transport_failed(&self) {
        self.health.failed().await;
    }

    /// 将明确的连接级错误上报给唯一重连监督器。
    pub(crate) fn report_transport_failure(&self) {
        self.health.mark_failed();
    }

    /// 探活记录仍新鲜时直接复用结果，否则串行执行一次真实 ping。
    pub(crate) async fn probe_transport_if_stale(
        &self,
        max_age: Duration,
        timeout: Duration,
    ) -> TransportProbeOutcome {
        let _guard = self.probe_lock.lock().await;
        if self.health.is_failed() {
            return TransportProbeOutcome::Failed;
        }
        if max_age > Duration::ZERO && self.health.is_fresh(max_age) {
            return TransportProbeOutcome::Fresh;
        }
        let started_at = Instant::now();
        let healthy = tokio::time::timeout(timeout, async {
            !self.handle.is_closed()
                && self.handle.send_ping().await.is_ok()
                && !self.handle.is_closed()
        })
        .await
        .unwrap_or(false);
        if !healthy {
            self.health.mark_failed();
            TransportProbeOutcome::Failed
        } else {
            self.health.record_probe(started_at.elapsed());
            TransportProbeOutcome::Sampled
        }
    }

    /// 在固定截止时间内尽力关闭旧 transport，不允许失效连接阻塞新 epoch。
    pub async fn disconnect(&self) {
        self.health.mark_failed();
        self.channels.disconnect();
        // SFTP 可能正在初始化并持有锁，关闭 transport 不能反过来等待它。
        let sftp = self
            .remote_fs
            .session
            .try_lock()
            .ok()
            .and_then(|mut session| session.take());
        let read_sftp = self
            .remote_fs
            .read_session
            .try_lock()
            .ok()
            .and_then(|mut session| session.take());
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            if let Some(sftp) = sftp {
                let _ = sftp.close().await;
            }
            if let Some(sftp) = read_sftp {
                let _ = sftp.session.close_session();
            }
            let _ = self
                .handle
                .disconnect(Disconnect::ByApplication, "Terax workspace closed", "en")
                .await;
        })
        .await;
    }

    /// 打开独立 channel 执行命令，并限制运行时间和输出大小。
    pub async fn exec(
        &self,
        command: &str,
        cwd: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutput, String> {
        let command = build_exec_command(command, cwd)?;
        let channel = self.open_exec_channel().await?;
        run_exec_channel(channel, command, timeout).await
    }

    /// 预开一个尚未发送命令的 session channel。
    ///
    /// 调用方必须在不再使用时执行命令或关闭 channel，避免长期占用服务端资源。
    pub(crate) async fn open_exec_channel(&self) -> Result<SessionChannel, String> {
        self.open_session("exec").await
    }

    /// 在已打开的 session channel 上执行一次命令。
    ///
    /// 文件保存用它把 channel 建立往返隐藏在临时文件上传期间；命令仍只在上传和
    /// `fsync` 成功后发送，不能提前观察或替换未完成的临时文件。
    pub(crate) async fn exec_on_channel(
        &self,
        channel: SessionChannel,
        command: &str,
        cwd: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutput, String> {
        let command = build_exec_command(command, cwd)?;
        run_exec_channel(channel, command, timeout).await
    }

    /// 在预开的 channel 上执行一次带标准输入的命令，并使用调用方提供的输出上限。
    ///
    /// 文件加速器在 exec 请求后立即发送完整长度帧和 EOF，SSH channel 自身负责窗口
    /// 背压。命令一旦发送，后续错误必须被调用方视为结果可能不明确。
    pub(crate) async fn exec_on_channel_with_input(
        &self,
        channel: SessionChannel,
        command: &str,
        input: Vec<u8>,
        timeout: Duration,
        max_output: usize,
    ) -> Result<ExecOutput, String> {
        let command = build_exec_command(command, None)?;
        run_exec_channel_with_input(channel, command, Some(input), timeout, max_output, None).await
    }

    /// 执行可取消的内部只读任务，取消后主动关闭所属 channel。
    pub(crate) async fn exec_task_on_channel_cancellable(
        &self,
        channel: SessionChannel,
        command: &str,
        input: Vec<u8>,
        timeout: Duration,
        max_output: usize,
        cancellation: &CancellationToken,
    ) -> Result<ExecOutput, String> {
        let command = build_exec_command(command, None)?;
        run_exec_channel_with_input(
            channel,
            command,
            Some(input),
            timeout,
            max_output,
            Some(cancellation),
        )
        .await
    }
}

/// 构造一次远端命令，保持工作目录参数的既有转义规则。
fn build_exec_command(command: &str, cwd: Option<&str>) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("empty remote command".into());
    }
    Ok(match cwd.filter(|cwd| !cwd.trim().is_empty()) {
        Some(cwd) => format!("cd -- {} && {command}", shell_quote(cwd)),
        None => command.to_string(),
    })
}

/// 在已打开的 channel 上发送命令，并有界收集完成状态和输出。
async fn run_exec_channel(
    channel: SessionChannel,
    command: String,
    timeout: Duration,
) -> Result<ExecOutput, String> {
    run_exec_channel_with_input(channel, command, None, timeout, MAX_EXEC_OUTPUT, None).await
}

/// 发送命令和可选标准输入，并有界收集完成状态与输出。
async fn run_exec_channel_with_input(
    mut channel: SessionChannel,
    command: String,
    input: Option<Vec<u8>>,
    timeout: Duration,
    max_output: usize,
    cancellation: Option<&CancellationToken>,
) -> Result<ExecOutput, String> {
    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|error| format!("start remote command: {error}"))?;
    if let Some(input) = input {
        channel
            .data_bytes(input)
            .await
            .map_err(|error| format!("write remote command input: {error}"))?;
        channel
            .eof()
            .await
            .map_err(|error| format!("finish remote command input: {error}"))?;
    }
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        let _ = channel.close().await;
        return Err(EXEC_CANCELLED_ERROR.into());
    }

    let run = async {
        let mut output = ExecOutput::default();
        let mut completion = ExecCompletion::default();
        loop {
            let Some(message) = channel.wait().await else {
                break;
            };
            if collect_exec_message_bounded(&mut output, &mut completion, message, max_output) {
                // EOF 锁定完整输出，退出状态锁定命令结果。主动关闭可避开部分
                // 高延迟服务端迟发 Close 的额外等待。
                let _ = channel.close().await;
                break;
            }
        }
        output
    };
    let outcome = if let Some(cancellation) = cancellation {
        tokio::select! {
            _ = cancellation.cancelled() => None,
            result = tokio::time::timeout(timeout, run) => Some(result),
        }
    } else {
        Some(tokio::time::timeout(timeout, run).await)
    };
    match outcome {
        Some(Ok(output)) => Ok(output),
        Some(Err(_)) => {
            let _ = channel.close().await;
            Ok(ExecOutput {
                timed_out: true,
                ..ExecOutput::default()
            })
        }
        None => {
            let _ = channel.close().await;
            Err(EXEC_CANCELLED_ERROR.into())
        }
    }
}

#[derive(Default)]
struct ExecCompletion {
    eof: bool,
    exited: bool,
}

/// 收集一次性命令输出，并在收到最终退出状态或 Close 时结束等待。
#[cfg(test)]
fn collect_exec_message(
    output: &mut ExecOutput,
    completion: &mut ExecCompletion,
    message: ChannelMsg,
) -> bool {
    collect_exec_message_bounded(output, completion, message, MAX_EXEC_OUTPUT)
}

/// 按调用方上限收集一次性命令消息。
fn collect_exec_message_bounded(
    output: &mut ExecOutput,
    completion: &mut ExecCompletion,
    message: ChannelMsg,
    max_output: usize,
) -> bool {
    match message {
        ChannelMsg::Data { data } => {
            append_bounded(&mut output.stdout, &data, &mut output.truncated, max_output);
            return false;
        }
        ChannelMsg::ExtendedData { data, .. } => {
            append_bounded(&mut output.stderr, &data, &mut output.truncated, max_output);
            return false;
        }
        ChannelMsg::ExitStatus { exit_status } => {
            output.exit_code = Some(exit_status as i32);
            completion.exited = true;
        }
        ChannelMsg::ExitSignal { signal_name, .. } => {
            output.exit_code = Some(signal_exit_code(&signal_name));
            completion.exited = true;
        }
        ChannelMsg::Eof => completion.eof = true,
        ChannelMsg::Close => return true,
        _ => return false,
    }
    completion.eof && completion.exited
}

fn client_config() -> client::Config {
    client::Config {
        nodelay: true,
        ..Default::default()
    }
}

async fn connect_transport(
    profile: &SshProfile,
    proxy: Option<&ProxyConfig>,
    config: Arc<client::Config>,
    handler: ClientHandler,
    traffic: Arc<SshTrafficMeter>,
    health: Arc<SshTransportHealth>,
) -> Result<Handle<ClientHandler>, ConnectFailure> {
    let host_keys = handler.host_keys.clone();
    let host_key_rejected = handler.host_key_rejected.clone();
    let stream = tokio::time::timeout(
        Duration::from_secs(15),
        super::proxy::connect(proxy, &profile.host, profile.port),
    )
    .await
    .map_err(|_| ConnectFailure::retryable("SSH TCP connection timed out".into()))?
    .map_err(|e| {
        let message = format!("SSH TCP connection failed: {e}");
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            message.into()
        } else {
            ConnectFailure::retryable(message)
        }
    })?;
    let stream = CountingSshStream::new(stream, traffic, health);
    let error = match tokio::time::timeout(
        Duration::from_secs(20),
        client::connect_stream(config, stream, handler),
    )
    .await
    {
        Ok(Ok(handle)) => return Ok(handle),
        Ok(Err(error)) => format!("SSH handshake failed: {error}"),
        Err(_) => "SSH handshake timed out".into(),
    };
    let pending = host_keys.cancel_pending(&profile.id).await;
    Err(ConnectFailure::transport(
        error,
        host_key_rejected.load(Ordering::Acquire) || pending,
    ))
}

#[derive(Debug)]
pub(crate) struct WorkspaceProbe {
    pub login_home: String,
    pub root: String,
}

/// 构造远端 root 赋值语句，保持既有 `~`、`$HOME` 和相对路径语义。
fn workspace_root_assignment(requested_root: &str) -> Result<String, String> {
    validate_remote_path(requested_root)?;
    let requested_root = requested_root.trim();
    if requested_root.is_empty() || matches!(requested_root, "~" | "$HOME" | "${HOME}") {
        return Ok("requested=\"$HOME\"".to_string());
    }
    for prefix in ["~/", "$HOME/", "${HOME}/"] {
        if let Some(rest) = requested_root.strip_prefix(prefix) {
            return Ok(format!("requested=\"$HOME\"/{}", shell_quote(rest)));
        }
    }
    if requested_root.starts_with('/') {
        Ok(format!("requested={}", shell_quote(requested_root)))
    } else {
        Ok(format!(
            "requested=\"$HOME\"/{}",
            shell_quote(requested_root)
        ))
    }
}

/// 使用一次远端进程确认 Linux、bash、登录 Home 和物理 Workspace root。
async fn detect_workspace(
    workspace: &RemoteWorkspace,
    root_assignment: &str,
    requested_root: &str,
) -> Result<WorkspaceProbe, ConnectFailure> {
    let probe = format!(
        "os=$(uname -s 2>/dev/null) || exit 91; [ \"$os\" = Linux ] || exit 92; [ -n \"$SHELL\" ] && [ \"${{SHELL##*/}}\" = bash ] && [ -x \"$SHELL\" ] && [ -x /bin/bash ] || exit 93; [ -n \"$HOME\" ] || exit 94; {root_assignment}; cd -- \"$requested\" || exit 95; root=$(pwd -P) || exit 95; printf '%s\\000%s\\000%s\\000%s' \"$os\" \"$SHELL\" \"$HOME\" \"$root\""
    );
    let output = workspace
        .exec(&probe, None, Duration::from_secs(10))
        .await
        .map_err(ConnectFailure::retryable)?;
    if output.timed_out {
        return Err(ConnectFailure::retryable(
            "timed out while detecting the remote SSH workspace".into(),
        ));
    }
    if output.exit_code.is_none() {
        return Err(ConnectFailure::retryable(
            "SSH server closed the workspace probe without reporting an exit status".into(),
        ));
    }
    parse_workspace_probe(output, requested_root).map_err(Into::into)
}

/// 解析合并探测结果并锁定绝对、无控制字符的 Home 与 Workspace root。
fn parse_workspace_probe(
    output: ExecOutput,
    requested_root: &str,
) -> Result<WorkspaceProbe, String> {
    if output.timed_out {
        return Err("timed out while detecting the remote SSH workspace".into());
    }
    if output.truncated {
        return Err("remote SSH workspace probe exceeded the size limit".into());
    }
    match output.exit_code {
        Some(0) => {}
        Some(92) => return Err("Remote SSH currently supports Linux hosts only".into()),
        Some(93) => return Err("Remote SSH currently requires bash as the login shell".into()),
        Some(94) => return Err("Remote SSH login did not provide a HOME directory".into()),
        Some(95) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("remote Workspace root is not accessible: {requested_root}")
            } else {
                format!("remote Workspace root is not accessible: {detail}")
            });
        }
        Some(code) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("failed to detect the remote SSH workspace (exit {code})")
            } else {
                format!("failed to detect the remote SSH workspace: {detail}")
            });
        }
        None => {
            return Err(
                "SSH server closed the workspace probe without reporting an exit status".into(),
            )
        }
    }
    parse_workspace_probe_bytes(&output.stdout, requested_root)
}

/// 解析远端探测的四个 NUL 分隔字段。
pub(crate) fn parse_workspace_probe_bytes(
    bytes: &[u8],
    _requested_root: &str,
) -> Result<WorkspaceProbe, String> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    if fields.len() != 4
        || fields[0] != b"Linux"
        || fields[1].is_empty()
        || fields[2].is_empty()
        || fields[3].is_empty()
    {
        return Err("SSH server returned an invalid workspace probe".into());
    }
    let login_home = std::str::from_utf8(fields[2])
        .map_err(|_| "Remote SSH HOME is not valid UTF-8".to_string())?
        .to_string();
    validate_remote_path(&login_home)?;
    if !login_home.starts_with('/') {
        return Err(format!(
            "Remote SSH HOME is not an absolute path: {login_home}"
        ));
    }
    let root = std::str::from_utf8(fields[3])
        .map_err(|_| "remote Workspace root is not valid UTF-8".to_string())?
        .to_string();
    validate_remote_path(&root)?;
    if !root.starts_with('/') {
        return Err(format!(
            "remote Workspace root is not an absolute path: {root}"
        ));
    }
    Ok(WorkspaceProbe { login_home, root })
}

#[derive(Default, Debug)]
/// 一次远端命令执行的有界输出。
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

fn append_bounded(target: &mut Vec<u8>, data: &[u8], truncated: &mut bool, max_output: usize) {
    let remaining = max_output.saturating_sub(target.len());
    if remaining < data.len() {
        *truncated = true;
    }
    target.extend_from_slice(&data[..data.len().min(remaining)]);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrimaryAuthResult {
    Authenticated,
    KeyboardInteractiveRequired,
}

async fn authenticate_primary(
    handle: &mut Handle<ClientHandler>,
    profile: &SshProfile,
    secret: &str,
) -> Result<PrimaryAuthResult, ConnectFailure> {
    let result = match profile.auth_method {
        SshAuthMethod::Password => {
            let password = handle
                .authenticate_password(&profile.username, secret)
                .await
                .map_err(|e| {
                    ConnectFailure::retryable(format!("password authentication failed: {e}"))
                })?;
            return Ok(password_auth_result(password.success()));
        }
        SshAuthMethod::PrivateKey => {
            let path = profile.identity_file.as_deref().unwrap_or_default();
            let expanded = expand_local_home(path);
            let key =
                russh::keys::load_secret_key(&expanded, (!secret.is_empty()).then_some(secret))
                    .map_err(|e| {
                        ConnectFailure::credentials(format!(
                            "load private key {}: {e}",
                            expanded.display()
                        ))
                    })?;
            let hash = key.algorithm().is_rsa().then_some(HashAlg::Sha256);
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle
                .authenticate_publickey(&profile.username, key)
                .await
                .map_err(|e| {
                    ConnectFailure::retryable(format!("public-key authentication failed: {e}"))
                })?
                .success()
        }
        SshAuthMethod::Agent => authenticate_agent(handle, &profile.username)
            .await
            .map_err(|error| {
                if handle.is_closed() {
                    ConnectFailure::retryable(error)
                } else {
                    error.into()
                }
            })?,
    };
    if result {
        Ok(PrimaryAuthResult::Authenticated)
    } else {
        let error = "SSH server rejected the supplied credentials";
        Err(if profile.auth_method == SshAuthMethod::Agent {
            error.into()
        } else {
            ConnectFailure::credentials(error.into())
        })
    }
}

fn password_auth_result(success: bool) -> PrimaryAuthResult {
    if success {
        PrimaryAuthResult::Authenticated
    } else {
        PrimaryAuthResult::KeyboardInteractiveRequired
    }
}

async fn authenticate_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    secret: &str,
) -> Result<bool, ConnectFailure> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| {
            ConnectFailure::retryable(format!("keyboard-interactive authentication failed: {e}"))
        })?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                // Password-only keyboard-interactive servers commonly present
                // one or more password prompts. Reuse the login-page secret for
                // each prompt; true MFA challenges remain rejected rather than
                // silently accepting an unsafe or guessed response.
                if prompts.iter().any(|prompt| {
                    let value = prompt.prompt.to_ascii_lowercase();
                    !value.contains("password") && !value.contains("passphrase")
                }) {
                    return Err(
                        "SSH server requested an interactive MFA response that is not available in this login flow"
                            .into(),
                    );
                }
                response = handle
                    .authenticate_keyboard_interactive_respond(
                        prompts.iter().map(|_| secret.to_string()).collect(),
                    )
                    .await
                    .map_err(|e| {
                        ConnectFailure::retryable(format!(
                            "keyboard-interactive response failed: {e}"
                        ))
                    })?;
            }
        }
    }
}

async fn authenticate_agent_client<S>(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    agent: &mut russh::keys::agent::client::AgentClient<S>,
) -> Result<bool, String>
where
    S: russh::keys::agent::client::AgentStream + Send + Unpin,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("list SSH agent keys: {e}"))?;
    for identity in identities {
        let key = identity.public_key().into_owned();
        let hash = key.algorithm().is_rsa().then_some(HashAlg::Sha256);
        if handle
            .authenticate_publickey_with(username, key, hash, agent)
            .await
            .map_err(|e| format!("SSH agent authentication failed: {e}"))?
            .success()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(unix)]
async fn authenticate_agent(
    handle: &mut Handle<ClientHandler>,
    username: &str,
) -> Result<bool, String> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| format!("connect SSH agent: {e}"))?;
    authenticate_agent_client(handle, username, &mut agent).await
}

#[cfg(windows)]
async fn authenticate_agent(
    handle: &mut Handle<ClientHandler>,
    username: &str,
) -> Result<bool, String> {
    if let Ok(mut agent) =
        russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
    {
        if authenticate_agent_client(handle, username, &mut agent).await? {
            return Ok(true);
        }
    }
    let mut agent = russh::keys::agent::client::AgentClient::connect_pageant()
        .await
        .map_err(|e| format!("connect Pageant: {e}"))?;
    authenticate_agent_client(handle, username, &mut agent).await
}

#[cfg(not(any(unix, windows)))]
async fn authenticate_agent(
    _handle: &mut Handle<ClientHandler>,
    _username: &str,
) -> Result<bool, String> {
    Err("SSH agent authentication is unsupported on this platform".into())
}

pub use crate::modules::shell::quote::shell_quote;

pub(crate) fn signal_exit_code(signal: &Sig) -> i32 {
    128 + match signal {
        Sig::HUP => 1,
        Sig::INT => 2,
        Sig::QUIT => 3,
        Sig::ILL => 4,
        Sig::ABRT => 6,
        Sig::FPE => 8,
        Sig::KILL => 9,
        Sig::USR1 => 10,
        Sig::SEGV => 11,
        Sig::PIPE => 13,
        Sig::ALRM => 14,
        Sig::TERM => 15,
        Sig::Custom(_) => 0,
    }
}

pub fn join_remote(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        return name.to_string();
    }
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

fn expand_local_home(path: &str) -> std::path::PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

pub fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') || path.contains('\r') || path.contains('\n') {
        return Err("invalid remote path".into());
    }
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::{
        build_exec_command, client_config, collect_exec_message, parse_workspace_probe,
        password_auth_result, workspace_root_assignment, ConnectFailure, ExecCompletion,
        ExecOutput, PrimaryAuthResult,
    };
    use bytes::Bytes;
    use russh::ChannelMsg;

    #[test]
    fn background_reconnect_retries_transport_failures_but_stops_for_user_action() {
        assert!(ConnectFailure::transport("network unavailable".into(), false).retryable);
        assert!(!ConnectFailure::transport("host key rejected".into(), true).retryable);
        assert!(!ConnectFailure::credentials("authentication failed".into()).retryable);
        assert!(!ConnectFailure::from("invalid workspace root").retryable);
    }

    #[test]
    fn builds_safe_workspace_root_assignments() {
        assert_eq!(
            workspace_root_assignment("~").unwrap(),
            "requested=\"$HOME\""
        );
        assert_eq!(
            workspace_root_assignment("${HOME}/code").unwrap(),
            "requested=\"$HOME\"/'code'"
        );
        assert_eq!(
            workspace_root_assignment("code").unwrap(),
            "requested=\"$HOME\"/'code'"
        );
        assert_eq!(
            workspace_root_assignment("/srv/code").unwrap(),
            "requested='/srv/code'"
        );
        assert!(workspace_root_assignment("bad\npath").is_err());
    }

    #[test]
    fn rejected_password_requires_fresh_keyboard_interactive_transport() {
        assert_eq!(
            password_auth_result(false),
            PrimaryAuthResult::KeyboardInteractiveRequired
        );
        assert_eq!(password_auth_result(true), PrimaryAuthResult::Authenticated);
    }

    #[test]
    fn client_banner_does_not_impersonate_openssh() {
        let config = client_config();
        let banner = format!("{:?}", config.client_id);
        assert!(!banner.contains("OpenSSH"), "unexpected banner: {banner}");
        assert!(banner.contains("russh"), "unexpected banner: {banner}");
        assert_eq!(config.keepalive_interval, None);
    }

    #[test]
    fn preopened_exec_preserves_command_validation_and_quoting() {
        assert_eq!(
            build_exec_command("printf ok", Some("/srv/a b")).unwrap(),
            "cd -- '/srv/a b' && printf ok"
        );
        assert_eq!(
            build_exec_command("printf ok", Some("  ")).unwrap(),
            "printf ok"
        );
        assert!(build_exec_command("  ", None).is_err());
    }

    #[test]
    fn workspace_probe_requires_valid_absolute_paths() {
        let valid = parse_workspace_probe(
            ExecOutput {
                stdout: b"Linux\0/bin/bash\0/home/me\0/srv/project".to_vec(),
                exit_code: Some(0),
                ..ExecOutput::default()
            },
            "~",
        )
        .unwrap();
        assert_eq!(valid.login_home, "/home/me");
        assert_eq!(valid.root, "/srv/project");

        let trailing_space = parse_workspace_probe(
            ExecOutput {
                stdout: b"Linux\0/bin/bash\0/home/me\0/srv/project ".to_vec(),
                exit_code: Some(0),
                ..ExecOutput::default()
            },
            "~",
        )
        .unwrap();
        assert_eq!(trailing_space.root, "/srv/project ");

        let newline_in_path = parse_workspace_probe(
            ExecOutput {
                stdout: b"Linux\0/bin/bash\0/home/me\0/srv/project\n".to_vec(),
                exit_code: Some(0),
                ..ExecOutput::default()
            },
            "~",
        );
        assert!(newline_in_path.is_err());

        let relative = parse_workspace_probe(
            ExecOutput {
                stdout: b"Linux\0/bin/bash\0/home/me\0project".to_vec(),
                exit_code: Some(0),
                ..ExecOutput::default()
            },
            "~",
        )
        .unwrap_err();
        assert!(relative.contains("absolute"));

        let failed = parse_workspace_probe(
            ExecOutput {
                stderr: b"cd: no such file or directory".to_vec(),
                exit_code: Some(95),
                ..ExecOutput::default()
            },
            "/missing",
        )
        .unwrap_err();
        assert!(failed.contains("no such file"));
    }

    #[test]
    fn exec_completion_does_not_wait_for_server_close() {
        let mut output = ExecOutput::default();
        let mut completion = ExecCompletion::default();

        assert!(!collect_exec_message(
            &mut output,
            &mut completion,
            ChannelMsg::Data {
                data: Bytes::from_static(b"ready")
            }
        ));
        assert!(!collect_exec_message(
            &mut output,
            &mut completion,
            ChannelMsg::Eof
        ));
        assert!(collect_exec_message(
            &mut output,
            &mut completion,
            ChannelMsg::ExitStatus { exit_status: 0 }
        ));
        assert_eq!(output.stdout, b"ready");
        assert_eq!(output.exit_code, Some(0));
    }

    #[test]
    fn exec_completion_accepts_exit_status_before_eof() {
        let mut output = ExecOutput::default();
        let mut completion = ExecCompletion::default();

        assert!(!collect_exec_message(
            &mut output,
            &mut completion,
            ChannelMsg::ExitStatus { exit_status: 7 }
        ));
        assert!(collect_exec_message(
            &mut output,
            &mut completion,
            ChannelMsg::Eof
        ));
        assert_eq!(output.exit_code, Some(7));
    }
}
