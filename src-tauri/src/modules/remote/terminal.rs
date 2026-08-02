//! 远端 PTY channel 桥接与生命周期管理。
//!
//! 本模块使用 Tauri raw IPC channel 接入既有 xterm 和 PTY 前端。只有底层 SSH handle
//! 已关闭时才返回 transport 退出码，Runtime 是否断线仍由统一 ping 探活决定。

use std::time::Duration;

use russh::ChannelMsg;
use tauri::ipc::{Channel, Response};
use tokio::sync::{mpsc, oneshot, watch};

use super::session::{shell_quote, signal_exit_code, validate_remote_path, RemoteWorkspace};
use crate::modules::pty::shell_init::{bashrc_script, normalize_script};

/// 底层 SSH transport 已关闭时向前端返回的专用退出码。
pub const TRANSPORT_CLOSED_EXIT_CODE: i32 = -255;

/// 一条远端交互式 PTY channel 的输入、尺寸和关闭控制句柄。
pub struct RemoteTerminalHandle {
    input: mpsc::Sender<Vec<u8>>,
    resize: watch::Sender<(u16, u16)>,
    close: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

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

    let (mut read, write) = channel.split();
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(32);
    let (resize_tx, mut resize_rx) = watch::channel((cols, rows));
    let (close_tx, mut close_rx) = oneshot::channel();
    let terminal_workspace = workspace.clone();
    tauri::async_runtime::spawn(async move {
        let mut exit_code = None;
        let mut closed_by_client = false;
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

    Ok(RemoteTerminalHandle {
        input: input_tx,
        resize: resize_tx,
        close: std::sync::Mutex::new(Some(close_tx)),
    })
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

#[cfg(test)]
mod tests {
    use super::{
        classify_exit, integrated_bash_command, signal_exit_code, TRANSPORT_CLOSED_EXIT_CODE,
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
}
