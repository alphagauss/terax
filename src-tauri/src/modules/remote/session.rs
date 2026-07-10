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
use russh::{ChannelMsg, Disconnect};
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

        let config = client::Config {
            client_id: russh::SshId::Standard(std::borrow::Cow::Borrowed("SSH-2.0-OpenSSH_9.9")),
            keepalive_interval: (profile.keepalive_seconds > 0)
                .then(|| Duration::from_secs(profile.keepalive_seconds)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        };

        let remote_forwards = RemoteForwardRegistry::default();
        let handler = ClientHandler {
            app,
            profile_id: profile.id.clone(),
            host: profile.host.clone(),
            port: profile.port,
            host_keys,
            remote_forwards: remote_forwards.clone(),
        };
        let stream = tokio::time::timeout(
            Duration::from_secs(15),
            super::proxy::connect(proxy.as_ref(), &profile.host, profile.port),
        )
        .await
        .map_err(|_| "SSH TCP connection timed out".to_string())?
        .map_err(|e| format!("SSH TCP connection failed: {e}"))?;
        let mut handle = tokio::time::timeout(
            Duration::from_secs(20),
            client::connect_stream(Arc::new(config), stream, handler),
        )
        .await
        .map_err(|_| "SSH handshake timed out".to_string())?
        .map_err(|e| format!("SSH handshake failed: {e}"))?;

        authenticate(&mut handle, &profile, secret.as_str()).await?;
        let workspace = Arc::new(Self {
            profile,
            handle: Arc::new(Mutex::new(handle)),
            remote_forwards,
            sftp: Mutex::new(None),
            home: RwLock::new("/".into()),
            secret,
            proxy_secret,
        });
        let detected_home = workspace
            .exec("printf %s \"$HOME\"", None, Duration::from_secs(10))
            .await
            .ok()
            .and_then(|output| {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                (!value.is_empty()).then_some(value)
            })
            .unwrap_or_else(|| format!("/home/{}", workspace.profile.username));
        let home = workspace
            .profile
            .root_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| expand_remote_home(value, &detected_home))
            .unwrap_or(detected_home);
        *workspace.home.write().await = home;
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

    pub async fn is_closed(&self) -> bool {
        self.handle.lock().await.is_closed()
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "Terax workspace closed", "en")
            .await;
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = sftp.close().await;
        }
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
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
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

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    profile: &SshProfile,
    secret: &str,
) -> Result<(), String> {
    let result = match profile.auth_method {
        SshAuthMethod::Password => {
            let password = handle
                .authenticate_password(&profile.username, secret)
                .await
                .map_err(|e| format!("password authentication failed: {e}"))?;
            if password.success() {
                true
            } else {
                authenticate_keyboard_interactive(handle, &profile.username, secret).await?
            }
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
        Ok(())
    } else {
        Err("SSH server rejected the supplied credentials".into())
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
    path.to_string()
}

pub fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') || path.contains('\r') || path.contains('\n') {
        return Err("invalid remote path".into());
    }
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::expand_remote_home;

    #[test]
    fn expands_common_remote_home_forms() {
        assert_eq!(expand_remote_home("~", "/home/me"), "/home/me");
        assert_eq!(expand_remote_home("~/code", "/home/me"), "/home/me/code");
        assert_eq!(
            expand_remote_home("${HOME}/code", "/home/me"),
            "/home/me/code"
        );
        assert_eq!(expand_remote_home("/srv/code", "/home/me"), "/srv/code");
    }
}
