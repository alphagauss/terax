//! Remote PTY channel bridge.
//!
//! Adapted from Eussh's terminal bridge, but uses Tauri raw IPC channels so it
//! plugs directly into Terax's existing xterm/PTY frontend without a parallel
//! renderer implementation.

use std::time::Duration;

use russh::ChannelMsg;
use tauri::ipc::{Channel, Response};
use tokio::sync::{mpsc, oneshot};

use super::session::{shell_quote, RemoteWorkspace};

pub struct RemoteTerminalHandle {
    pub input: mpsc::UnboundedSender<Vec<u8>>,
    pub resize: mpsc::UnboundedSender<(u16, u16)>,
    close: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl RemoteTerminalHandle {
    pub fn close(&self) {
        if let Ok(mut close) = self.close.lock() {
            if let Some(sender) = close.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn open(
    workspace: std::sync::Arc<RemoteWorkspace>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<RemoteTerminalHandle, String> {
    let channel = {
        let handle = workspace.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("open remote terminal channel: {e}"))?
    };
    channel
        .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("allocate remote PTY: {e}"))?;
    let cwd = cwd.filter(|cwd| !cwd.trim().is_empty());
    if let Some(cwd) = cwd {
        let command = format!(
            "cd -- {} && exec \"${{SHELL:-/bin/sh}}\" -l",
            shell_quote(&cwd)
        );
        channel
            .exec(true, command.into_bytes())
            .await
            .map_err(|e| format!("start remote shell: {e}"))?;
    } else {
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("start remote shell: {e}"))?;
    }

    let (mut read, write) = channel.split();
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (close_tx, mut close_rx) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let mut exit_code = 0i32;
        loop {
            tokio::select! {
                message = read.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if on_data.send(Response::new(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = exit_status as i32,
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                Some(data) = input_rx.recv() => {
                    if write.data_bytes(data).await.is_err() {
                        break;
                    }
                }
                Some((cols, rows)) = resize_rx.recv() => {
                    if write.window_change(cols as u32, rows as u32, 0, 0).await.is_err() {
                        break;
                    }
                }
                _ = &mut close_rx => {
                    let _ = write.eof().await;
                    let _ = write.close().await;
                    break;
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), write.close()).await;
        let _ = on_exit.send(exit_code);
    });

    Ok(RemoteTerminalHandle {
        input: input_tx,
        resize: resize_tx,
        close: std::sync::Mutex::new(Some(close_tx)),
    })
}
