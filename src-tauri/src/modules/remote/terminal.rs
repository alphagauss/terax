//! 远端 PTY channel、Workspace capability 探测与生命周期管理。
//!
//! 本模块使用 Tauri raw IPC channel 接入既有 xterm 和 PTY 前端。只有底层 SSH handle
//! 已关闭时才返回 transport 退出码，Runtime 是否断线仍由统一 ping 探活决定。

use std::time::Duration;

use russh::client::Msg;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tauri::ipc::{Channel, Response};
use tokio::sync::{mpsc, oneshot, watch};

use super::session::{shell_quote, signal_exit_code, validate_remote_path, RemoteWorkspace};
use crate::modules::pty::shell_init::{bashrc_script, normalize_script};

/// 底层 SSH transport 已关闭时向前端返回的专用退出码。
pub const TRANSPORT_CLOSED_EXIT_CODE: i32 = -255;

/// 一条远端交互式 PTY channel 的输入、尺寸和关闭控制句柄。
pub struct RemoteTerminalHandle {
    pub(crate) workspace: std::sync::Arc<RemoteWorkspace>,
    input: mpsc::Sender<Vec<u8>>,
    resize: watch::Sender<(u16, u16)>,
    close: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

/// 认证后提前启动、等待前端终端接管的 PTY channel。
pub struct PreparedTerminal {
    profile_id: String,
    requested_cwd: Option<String>,
    blocks: bool,
    read: ChannelReadHalf,
    write: ChannelWriteHalf<Msg>,
    buffered: Vec<u8>,
}

impl PreparedTerminal {
    /// 判断首次前端 PTY 请求是否与预启动终端一致。
    pub fn matches(&self, profile_id: &str, cwd: Option<&str>, blocks: bool) -> bool {
        self.profile_id == profile_id
            && self.requested_cwd.as_deref().is_none_or(|prepared_cwd| {
                Some(prepared_cwd) == cwd.filter(|value| !value.trim().is_empty())
            })
            && self.blocks == blocks
    }

    /// 未被前端接管时关闭远端 channel。
    pub async fn close(self) {
        let _ = self.write.close().await;
    }
}

const BOOTSTRAP_PREFIX: &[u8] = b"\0TERAX-SSH-BOOT\0";
const BOOTSTRAP_SUFFIX: &[u8] = b"\0TERAX-SSH-READY\0";
const BOOTSTRAP_LIMIT: usize = 16 * 1024;

impl RemoteTerminalHandle {
    pub async fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.input
            .send(data)
            .await
            .map_err(|_| "remote terminal input channel closed".to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.resize
            .send((cols, rows))
            .map_err(|_| "remote terminal resize channel closed".to_string())
    }

    pub fn close(&self) {
        if let Ok(mut close) = self.close.lock() {
            if let Some(sender) = close.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
/// 在已连接 workspace 上创建远端交互式 bash，并将数据桥接到前端。
pub async fn open(
    workspace: std::sync::Arc<RemoteWorkspace>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    blocks: bool,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<RemoteTerminalHandle, String> {
    let channel = workspace
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open remote terminal channel: {e}"))?;
    channel
        .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("allocate remote PTY: {e}"))?;
    let login_home = workspace.login_home().await;
    let cwd = cwd
        .filter(|cwd| !cwd.trim().is_empty())
        .unwrap_or(login_home);
    validate_remote_path(&cwd)?;
    let command = integrated_bash_command(&cwd, blocks);
    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|e| format!("start remote shell: {e}"))?;

    let (read, write) = channel.split();
    Ok(bridge(workspace, read, write, Vec::new(), on_data, on_exit))
}

/// 使用一个 PTY 同时确认远端环境、解析 Workspace root 并启动集成 bash。
pub(crate) async fn prepare(
    workspace: std::sync::Arc<RemoteWorkspace>,
    root_assignment: &str,
    requested_root: &str,
    cwd: Option<String>,
    blocks: bool,
) -> Result<(PreparedTerminal, super::session::WorkspaceProbe), String> {
    if let Some(cwd) = cwd.as_deref() {
        validate_remote_path(cwd)?;
    }
    let channel = workspace
        .handle
        .channel_open_session()
        .await
        .map_err(|error| format!("open prepared terminal channel: {error}"))?;
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|error| format!("allocate prepared terminal PTY: {error}"))?;
    let command = bootstrap_bash_command(root_assignment, cwd.as_deref(), blocks);
    channel
        .exec(true, command.into_bytes())
        .await
        .map_err(|error| format!("start prepared terminal shell: {error}"))?;

    let requested_cwd = cwd.filter(|value| !value.trim().is_empty());
    let profile_id = workspace.profile.id.clone();
    let mut channel = channel;
    let bootstrap = tokio::time::timeout(
        Duration::from_secs(10),
        read_bootstrap(&mut channel, requested_root),
    )
    .await;
    let (probe, buffered) = match bootstrap {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let _ = channel.close().await;
            return Err(error);
        }
        Err(_) => {
            let _ = channel.close().await;
            return Err("timed out while preparing the remote terminal".to_string());
        }
    };
    let (read, write) = channel.split();
    Ok((
        PreparedTerminal {
            profile_id,
            requested_cwd,
            blocks,
            read,
            write,
            buffered,
        },
        probe,
    ))
}

/// 将预启动 PTY 绑定到前端 IPC channel，并应用真实终端尺寸。
pub async fn attach_prepared(
    workspace: std::sync::Arc<RemoteWorkspace>,
    prepared: PreparedTerminal,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<RemoteTerminalHandle, String> {
    if let Err(error) = prepared
        .write
        .window_change(cols as u32, rows as u32, 0, 0)
        .await
    {
        prepared.close().await;
        return Err(format!("resize prepared terminal: {error}"));
    }
    Ok(bridge(
        workspace,
        prepared.read,
        prepared.write,
        prepared.buffered,
        on_data,
        on_exit,
    ))
}

/// 将普通或预启动 channel 接入统一的终端输入、输出、resize 和关闭循环。
fn bridge(
    workspace: std::sync::Arc<RemoteWorkspace>,
    mut read: ChannelReadHalf,
    write: ChannelWriteHalf<Msg>,
    buffered: Vec<u8>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> RemoteTerminalHandle {
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(32);
    let (resize_tx, mut resize_rx) = watch::channel((0, 0));
    let (close_tx, mut close_rx) = oneshot::channel();
    let terminal_workspace = workspace.clone();
    tauri::async_runtime::spawn(async move {
        let mut exit_code = None;
        let mut closed_by_client = false;
        if !buffered.is_empty() && on_data.send(Response::new(buffered)).is_err() {
            let _ = write.close().await;
            return;
        }
        loop {
            tokio::select! {
                message = read.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if on_data.send(Response::new(data.to_vec())).is_err() {
                            closed_by_client = true;
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32)
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        exit_code = Some(signal_exit_code(&signal_name))
                    }
                    // RFC 4254 permits exit-status after EOF. Wait for Close
                    // so a normal shell exit is not mislabeled as a transport
                    // loss merely because EOF arrived first.
                    Some(ChannelMsg::Eof) => {}
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                Some(data) = input_rx.recv() => {
                    if write.data_bytes(data).await.is_err() {
                        break;
                    }
                }
                changed = resize_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let (cols, rows) = *resize_rx.borrow_and_update();
                    if write.window_change(cols as u32, rows as u32, 0, 0).await.is_err() {
                        break;
                    }
                }
                _ = &mut close_rx => {
                    closed_by_client = true;
                    let _ = write.eof().await;
                    let _ = write.close().await;
                    break;
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), write.close()).await;
        let transport_closed = terminal_workspace.is_closed();
        let exit_code = classify_exit(exit_code, closed_by_client, transport_closed);
        let _ = on_exit.send(exit_code);
    });

    RemoteTerminalHandle {
        workspace,
        input: input_tx,
        resize: resize_tx,
        close: std::sync::Mutex::new(Some(close_tx)),
    }
}

/// 从 prepared PTY 读取私有启动帧，保留同一数据包中紧随其后的 shell 输出。
async fn read_bootstrap(
    channel: &mut russh::Channel<Msg>,
    requested_root: &str,
) -> Result<(super::session::WorkspaceProbe, Vec<u8>), String> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                stdout.extend_from_slice(&data);
                if stdout.len() > BOOTSTRAP_LIMIT {
                    return Err("prepared terminal bootstrap exceeded the size limit".to_string());
                }
                if let Some((probe, buffered)) = parse_bootstrap(&stdout, requested_root)? {
                    return Ok((probe, buffered));
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                if stderr.len() < BOOTSTRAP_LIMIT {
                    stderr.extend_from_slice(&data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                return Err(format!(
                    "prepared terminal exited before bootstrap (exit {exit_status}): {}",
                    String::from_utf8_lossy(&stderr).trim()
                ));
            }
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                return Err(format!(
                    "prepared terminal exited before bootstrap with signal {signal_name:?}"
                ));
            }
            Some(ChannelMsg::Close) | None => {
                return Err("prepared terminal closed before bootstrap".to_string())
            }
            _ => {}
        }
    }
}

/// 解析 prepared PTY 的 NUL 分隔启动帧，不把内部字段暴露给 xterm。
fn parse_bootstrap(
    bytes: &[u8],
    requested_root: &str,
) -> Result<Option<(super::session::WorkspaceProbe, Vec<u8>)>, String> {
    let Some(prefix) = bytes
        .windows(BOOTSTRAP_PREFIX.len())
        .position(|window| window == BOOTSTRAP_PREFIX)
    else {
        return Ok(None);
    };
    let fields_start = prefix + BOOTSTRAP_PREFIX.len();
    let Some(suffix_offset) = bytes[fields_start..]
        .windows(BOOTSTRAP_SUFFIX.len())
        .position(|window| window == BOOTSTRAP_SUFFIX)
    else {
        return Ok(None);
    };
    let suffix = fields_start + suffix_offset;
    let probe =
        super::session::parse_workspace_probe_bytes(&bytes[fields_start..suffix], requested_root)?;
    let buffered_start = suffix + BOOTSTRAP_SUFFIX.len();
    Ok(Some((probe, bytes[buffered_start..].to_vec())))
}

/// 将 terminal channel 结束分类为普通 shell 退出或 transport 断开。
fn classify_exit(exit_code: Option<i32>, closed_by_client: bool, transport_closed: bool) -> i32 {
    exit_code.unwrap_or({
        if closed_by_client || !transport_closed {
            0
        } else {
            TRANSPORT_CLOSED_EXIT_CODE
        }
    })
}

fn integrated_bash_command(cwd: &str, blocks: bool) -> String {
    let blocks = if blocks { " TERAX_BLOCKS=1" } else { "" };
    format!(
        "cd -- {} && exec env TERAX_TERMINAL=1{} /bin/bash --rcfile <(printf %s {}) -i",
        shell_quote(cwd),
        blocks,
        shell_quote(&normalize_script(bashrc_script())),
    )
}

/// 构造校验 Workspace 后直接进入集成 bash 的单 channel 启动命令。
fn bootstrap_bash_command(root_assignment: &str, cwd: Option<&str>, blocks: bool) -> String {
    let terminal_cwd = cwd
        .map(|cwd| format!("terminal_cwd={}", shell_quote(cwd)))
        .unwrap_or_else(|| "terminal_cwd=\"$root\"".to_string());
    let blocks = if blocks { " TERAX_BLOCKS=1" } else { "" };
    format!(
        "os=$(uname -s 2>/dev/null) || exit 91; [ \"$os\" = Linux ] || exit 92; [ -n \"$SHELL\" ] && [ \"${{SHELL##*/}}\" = bash ] && [ -x \"$SHELL\" ] && [ -x /bin/bash ] || exit 93; [ -n \"$HOME\" ] || exit 94; {root_assignment}; cd -- \"$requested\" || exit 95; root=$(pwd -P) || exit 95; {terminal_cwd}; cd -- \"$terminal_cwd\" 2>/dev/null || cd -- \"$root\" || exit 96; printf '\\000TERAX-SSH-BOOT\\000%s\\000%s\\000%s\\000%s\\000TERAX-SSH-READY\\000' \"$os\" \"$SHELL\" \"$HOME\" \"$root\"; exec env TERAX_TERMINAL=1{blocks} /bin/bash --rcfile <(printf %s {}) -i",
        shell_quote(&normalize_script(bashrc_script()))
    )
}

#[cfg(test)]
mod tests {
    use super::{
        bootstrap_bash_command, classify_exit, integrated_bash_command, parse_bootstrap,
        signal_exit_code, BOOTSTRAP_PREFIX, BOOTSTRAP_SUFFIX, TRANSPORT_CLOSED_EXIT_CODE,
    };
    use russh::Sig;

    #[test]
    fn starts_integrated_bash_in_the_requested_directory() {
        let command = integrated_bash_command("/home/me/project", false);

        assert!(command.starts_with("cd -- '/home/me/project' && exec env TERAX_TERMINAL=1 "));
        assert!(command.contains("/bin/bash --rcfile <(printf %s '"));
        assert!(command.ends_with(") -i"));
        assert!(command.contains("_terax_precmd"));
        assert!(!command.contains('\r'));
        assert!(!command.contains("TERAX_BLOCKS=1"));
    }

    #[test]
    fn quotes_cwd_and_enables_blocks_when_requested() {
        let command = integrated_bash_command("/home/me/it's here", true);

        assert!(command.starts_with(
            "cd -- '/home/me/it'\\''s here' && exec env TERAX_TERMINAL=1 TERAX_BLOCKS=1 ",
        ));
    }

    #[test]
    fn keeps_transport_loss_distinct_from_shell_exit() {
        assert_eq!(signal_exit_code(&Sig::TERM), 143);
        assert_ne!(signal_exit_code(&Sig::TERM), TRANSPORT_CLOSED_EXIT_CODE);
        assert_eq!(classify_exit(None, false, false), 0);
        assert_eq!(classify_exit(None, false, true), TRANSPORT_CLOSED_EXIT_CODE);
        assert_eq!(classify_exit(None, true, true), 0);
    }

    #[test]
    fn prepared_terminal_bootstrap_is_hidden_from_shell_output() {
        let mut bytes = Vec::from(BOOTSTRAP_PREFIX);
        bytes.extend_from_slice(b"Linux\0/bin/bash\0/home/me\0/srv/project");
        bytes.extend_from_slice(BOOTSTRAP_SUFFIX);
        bytes.extend_from_slice(b"prompt> ");

        let (probe, buffered) = parse_bootstrap(&bytes, "~").unwrap().unwrap();
        assert_eq!(probe.login_home, "/home/me");
        assert_eq!(probe.root, "/srv/project");
        assert_eq!(buffered, b"prompt> ");
    }

    #[test]
    fn prepared_terminal_command_quotes_cwd_and_falls_back_to_root() {
        let command = bootstrap_bash_command("requested=\"$HOME\"", Some("/srv/it's here"), true);

        assert!(command.contains("terminal_cwd='/srv/it'\\''s here'"));
        assert!(command.contains("|| cd -- \"$root\" || exit 96"));
        assert!(command.contains("TERAX_BLOCKS=1"));
        assert!(command.contains("TERAX-SSH-BOOT"));
    }
}
