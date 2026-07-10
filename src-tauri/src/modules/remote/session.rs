//! Shared SSH transport and remote command execution.
//!
//! The command/channel lifecycle is adapted from Eussh's `ssh/session.rs`; the
//! authentication, proxy and remote-forwarding behavior is supplemented from
//! meatshell. This version keeps one transport per Terax Remote Workspace and
//! opens independent channels for terminals, SFTP, commands and tunnels.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Handler, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect, Sig};
use tokio::sync::{Mutex, RwLock};
use zeroize::Zeroizing;

use super::host_key::HostKeyVerifier;
use super::models::{ConnectRequest, ProxyConfig, SshAuthMethod, SshProfile};
use super::tunnel::RemoteForwardRegistry;

const MAX_EXEC_OUTPUT: usize = 16 * 1024 * 1024;

pub struct ClientHandler {
    pub app: tauri::AppHandle,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub host_keys: Arc<HostKeyVerifier>,
    pub remote_forwards: RemoteForwardRegistry,
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
        async move { Ok(host_keys.check(&app, &profile_id, &host, port, &key).await) }
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
                tauri::async_runtime::spawn(async move {
                    match tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await
                    {
                        Ok(mut socket) => {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
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

pub struct RemoteWorkspace {
    pub profile: SshProfile,
    pub handle: Arc<Mutex<Handle<ClientHandler>>>,
    pub remote_forwards: RemoteForwardRegistry,
    pub(crate) sftp: Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    home: RwLock<String>,
    login_home: RwLock<String>,
    secret: Zeroizing<String>,
    proxy_secret: Zeroizing<String>,
}

impl RemoteWorkspace {
    pub async fn connect(
        request: ConnectRequest,
        app: tauri::AppHandle,
        host_keys: Arc<HostKeyVerifier>,
    ) -> Result<Arc<Self>, String> {
        request.profile.validate()?;
        let profile = request.profile;
        let secret = Zeroizing::new(request.secret.unwrap_or_default());
        let proxy_secret = Zeroizing::new(request.proxy_secret.unwrap_or_default());
        let proxy = ProxyConfig::parse(
            profile.proxy_url.as_deref().unwrap_or(""),
            (!proxy_secret.is_empty()).then_some(proxy_secret.as_str()),
        )?;

        // Keep russh's real client identifier. Advertising OpenSSH makes an
        // OpenSSH server enable private channel extensions such as
        // eow@openssh.com that russh does not implement.
        let config = Arc::new(client_config(profile.keepalive_seconds));

        let remote_forwards = RemoteForwardRegistry::default();
        let mut handle = connect_transport(
            &profile,
            proxy.as_ref(),
            config.clone(),
            app.clone(),
            host_keys.clone(),
            remote_forwards.clone(),
        )
        .await?;

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
            handle = connect_transport(
                &profile,
                proxy.as_ref(),
                config,
                app,
                host_keys,
                remote_forwards.clone(),
            )
            .await?;
            if !authenticate_keyboard_interactive(&mut handle, &profile.username, secret.as_str())
                .await?
            {
                return Err("SSH server rejected the supplied credentials".into());
            }
        }
        let workspace = Arc::new(Self {
            profile,
            handle: Arc::new(Mutex::new(handle)),
            remote_forwards,
            sftp: Mutex::new(None),
            home: RwLock::new("/".into()),
            login_home: RwLock::new("/".into()),
            secret,
            proxy_secret,
        });
        let detected_home = match detect_linux_bash_home(&workspace).await {
            Ok(home) => home,
            Err(error) => {
                workspace.disconnect().await;
                return Err(error);
            }
        };
        *workspace.login_home.write().await = detected_home.clone();
        let requested_root = workspace
            .profile
            .root_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| expand_remote_home(value, &detected_home))
            .unwrap_or(detected_home);
        let root = match super::sftp::canonicalize(&workspace, &requested_root).await {
            Ok(root) => root,
            Err(error) => {
                workspace.disconnect().await;
                return Err(format!("invalid SSH rootPath {requested_root}: {error}"));
            }
        };
        let root_stat = match super::sftp::stat(&workspace, &root).await {
            Ok(stat) => stat,
            Err(error) => {
                workspace.disconnect().await;
                return Err(format!("cannot access SSH rootPath {root}: {error}"));
            }
        };
        if root_stat.kind != super::sftp::RemoteEntryKind::Dir {
            workspace.disconnect().await;
            return Err(format!("SSH rootPath is not a directory: {root}"));
        }
        *workspace.home.write().await = root;
        Ok(workspace)
    }

    pub fn reconnect_request(&self) -> ConnectRequest {
        ConnectRequest {
            profile: self.profile.clone(),
            secret: (!self.secret.is_empty()).then(|| self.secret.to_string()),
            proxy_secret: (!self.proxy_secret.is_empty()).then(|| self.proxy_secret.to_string()),
        }
    }

    pub async fn home(&self) -> String {
        self.home.read().await.clone()
    }

    pub async fn login_home(&self) -> String {
        self.login_home.read().await.clone()
    }

    pub async fn is_closed(&self) -> bool {
        self.handle.lock().await.is_closed()
    }

    pub async fn disconnect(&self) {
        let sftp = self.sftp.lock().await.take();
        if let Some(sftp) = sftp {
            let _ = tokio::time::timeout(Duration::from_secs(1), sftp.close()).await;
        }
        let _ = self
            .handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "Terax workspace closed", "en")
            .await;
    }

    pub async fn exec(
        &self,
        command: &str,
        cwd: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutput, String> {
        if command.trim().is_empty() {
            return Err("empty remote command".into());
        }
        let command = match cwd.filter(|cwd| !cwd.trim().is_empty()) {
            Some(cwd) => format!("cd -- {} && {command}", shell_quote(cwd)),
            None => command.to_string(),
        };
        let mut channel = {
            let handle = self.handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| format!("open SSH exec channel: {e}"))?
        };
        channel
            .exec(true, command.into_bytes())
            .await
            .map_err(|e| format!("start remote command: {e}"))?;

        let run = async {
            let mut output = ExecOutput::default();
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        append_bounded(&mut output.stdout, &data, &mut output.truncated)
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        append_bounded(&mut output.stderr, &data, &mut output.truncated)
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        output.exit_code = Some(exit_status as i32)
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        output.exit_code = Some(signal_exit_code(&signal_name))
                    }
                    Some(ChannelMsg::Eof) => {}
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            output
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(output) => Ok(output),
            Err(_) => {
                let _ = channel.close().await;
                Ok(ExecOutput {
                    timed_out: true,
                    ..ExecOutput::default()
                })
            }
        }
    }
}

fn client_config(keepalive_seconds: u64) -> client::Config {
    client::Config {
        keepalive_interval: (keepalive_seconds > 0).then(|| Duration::from_secs(keepalive_seconds)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    }
}

async fn connect_transport(
    profile: &SshProfile,
    proxy: Option<&ProxyConfig>,
    config: Arc<client::Config>,
    app: tauri::AppHandle,
    host_keys: Arc<HostKeyVerifier>,
    remote_forwards: RemoteForwardRegistry,
) -> Result<Handle<ClientHandler>, String> {
    let handler = ClientHandler {
        app,
        profile_id: profile.id.clone(),
        host: profile.host.clone(),
        port: profile.port,
        host_keys,
        remote_forwards,
    };
    let stream = tokio::time::timeout(
        Duration::from_secs(15),
        super::proxy::connect(proxy, &profile.host, profile.port),
    )
    .await
    .map_err(|_| "SSH TCP connection timed out".to_string())?
    .map_err(|e| format!("SSH TCP connection failed: {e}"))?;
    tokio::time::timeout(
        Duration::from_secs(20),
        client::connect_stream(config, stream, handler),
    )
    .await
    .map_err(|_| "SSH handshake timed out".to_string())?
    .map_err(|e| format!("SSH handshake failed: {e}"))
}

async fn detect_linux_bash_home(workspace: &RemoteWorkspace) -> Result<String, String> {
    const PROBE: &str = "os=$(uname -s 2>/dev/null) || exit 91; [ \"$os\" = Linux ] || exit 92; [ -n \"$SHELL\" ] && [ \"${SHELL##*/}\" = bash ] && [ -x \"$SHELL\" ] && [ -x /bin/bash ] || exit 93; [ -n \"$HOME\" ] || exit 94; printf '%s\\000%s\\000%s' \"$os\" \"$SHELL\" \"$HOME\"";
    let output = workspace.exec(PROBE, None, Duration::from_secs(10)).await?;
    if output.timed_out {
        return Err("timed out while detecting the remote Linux/bash environment".into());
    }
    match output.exit_code {
        Some(0) => {}
        Some(92) => return Err("Remote SSH currently supports Linux hosts only".into()),
        Some(93) => return Err("Remote SSH currently requires bash as the login shell".into()),
        Some(94) => return Err("Remote SSH login did not provide a HOME directory".into()),
        Some(code) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("failed to detect the remote Linux/bash environment (exit {code})")
            } else {
                format!("failed to detect the remote Linux/bash environment: {detail}")
            });
        }
        None => {
            return Err(
                "SSH server closed the environment probe without reporting an exit status".into(),
            )
        }
    }
    let fields: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    if fields.len() != 3 || fields[0] != b"Linux" || fields[1].is_empty() || fields[2].is_empty() {
        return Err("SSH server returned an invalid Linux/bash environment probe".into());
    }
    let home = std::str::from_utf8(fields[2])
        .map_err(|_| "Remote SSH HOME is not valid UTF-8".to_string())?
        .to_string();
    validate_remote_path(&home)?;
    if !home.starts_with('/') {
        return Err(format!("Remote SSH HOME is not an absolute path: {home}"));
    }
    Ok(home)
}

#[derive(Default, Debug)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

fn append_bounded(target: &mut Vec<u8>, data: &[u8], truncated: &mut bool) {
    let remaining = MAX_EXEC_OUTPUT.saturating_sub(target.len());
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
) -> Result<PrimaryAuthResult, String> {
    let result = match profile.auth_method {
        SshAuthMethod::Password => {
            let password = handle
                .authenticate_password(&profile.username, secret)
                .await
                .map_err(|e| format!("password authentication failed: {e}"))?;
            return Ok(password_auth_result(password.success()));
        }
        SshAuthMethod::PrivateKey => {
            let path = profile.identity_file.as_deref().unwrap_or_default();
            let expanded = expand_local_home(path);
            let key =
                russh::keys::load_secret_key(&expanded, (!secret.is_empty()).then_some(secret))
                    .map_err(|e| format!("load private key {}: {e}", expanded.display()))?;
            let hash = key.algorithm().is_rsa().then_some(HashAlg::Sha256);
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle
                .authenticate_publickey(&profile.username, key)
                .await
                .map_err(|e| format!("public-key authentication failed: {e}"))?
                .success()
        }
        SshAuthMethod::Agent => authenticate_agent(handle, &profile.username).await?,
    };
    if result {
        Ok(PrimaryAuthResult::Authenticated)
    } else {
        Err("SSH server rejected the supplied credentials".into())
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
) -> Result<bool, String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| format!("keyboard-interactive authentication failed: {e}"))?;
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
                    .map_err(|e| format!("keyboard-interactive response failed: {e}"))?;
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

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

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

fn expand_remote_home(path: &str, home: &str) -> String {
    if matches!(path, "~" | "$HOME" | "${HOME}") {
        return home.to_string();
    }
    for prefix in ["~/", "$HOME/", "${HOME}/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            return join_remote(home, rest);
        }
    }
    if path.starts_with('/') {
        path.to_string()
    } else {
        join_remote(home, path)
    }
}

pub fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') || path.contains('\r') || path.contains('\n') {
        return Err("invalid remote path".into());
    }
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::{client_config, expand_remote_home, password_auth_result, PrimaryAuthResult};

    #[test]
    fn expands_common_remote_home_forms() {
        assert_eq!(expand_remote_home("~", "/home/me"), "/home/me");
        assert_eq!(expand_remote_home("~/code", "/home/me"), "/home/me/code");
        assert_eq!(
            expand_remote_home("${HOME}/code", "/home/me"),
            "/home/me/code"
        );
        assert_eq!(expand_remote_home("/srv/code", "/home/me"), "/srv/code");
        assert_eq!(expand_remote_home("code", "/home/me"), "/home/me/code");
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
        let banner = format!("{:?}", client_config(30).client_id);
        assert!(!banner.contains("OpenSSH"), "unexpected banner: {banner}");
        assert!(banner.contains("russh"), "unexpected banner: {banner}");
    }
}
