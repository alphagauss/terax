//! SSH 为后台传输提供连接级准入、专用 SFTP 流与可控命令。额度及通道关闭回执由连接持有。

use std::fmt;
use std::future::Future;
use std::time::Duration;

use russh::{ChannelMsg, Sig};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use super::channels::SessionChannel;
use super::session::{append_bounded, ExecOutput, RemoteWorkspace, EXEC_CANCELLED_ERROR};

/// 传输按失败阶段和原因决定任务终态；详情仅用于诊断。
#[derive(Debug)]
pub enum SshTransferError {
    Canceled,
    Busy(String),
    Disconnected(String),
    OpenFailed(String),
    OperationFailed(String),
}

impl fmt::Display for SshTransferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Canceled => f.write_str(EXEC_CANCELLED_ERROR),
            Self::Busy(detail)
            | Self::Disconnected(detail)
            | Self::OpenFailed(detail)
            | Self::OperationFailed(detail) => f.write_str(detail),
        }
    }
}

/// 数据流和元数据流各自占用一个任务专用的 SFTP 会话。
pub enum TransferSftpKind {
    Metadata,
    Data,
}

impl RemoteWorkspace {
    /// 取得当前连接的传输资格后才轮询任务，取消和重试均沿用原连接的准入规则。
    pub async fn run_transfer<T>(
        &self,
        task_id: &str,
        cancellation: &CancellationToken,
        work: impl Future<Output = T>,
    ) -> Result<T, SshTransferError> {
        self.channels
            .transfer_scope(self, task_id.to_owned(), cancellation, work)
            .await
    }

    /// 打开任务独占的 SFTP 子系统；上层持有返回流并设置协议超时与请求并发。
    pub async fn open_transfer_sftp(
        &self,
        kind: TransferSftpKind,
    ) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static, SshTransferError> {
        let purpose = match kind {
            TransferSftpKind::Metadata => "transfer_metadata",
            TransferSftpKind::Data => "transfer_data",
        };
        let channel = self.channels.open(self, purpose).await?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| {
                SshTransferError::OperationFailed(format!(
                    "request transfer SFTP subsystem: {error}"
                ))
            })?;
        Ok(channel.into_stream())
    }

    /// 启动可暂停的传输命令。调用方决定超时、输出上限以及何时发送控制信号。
    pub async fn start_transfer_command(
        &self,
        command: &str,
    ) -> Result<TransferCommand, SshTransferError> {
        let channel = self.channels.open(self, "transfer_command").await?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|error| {
                SshTransferError::OperationFailed(format!("start archive command: {error}"))
            })?;
        Ok(TransferCommand(channel))
    }

    /// 在独立 exec 通道提交带标准输入的命令，区分准入失败和已进入执行阶段的错误。
    pub async fn exec_with_input(
        &self,
        command: &str,
        input: Vec<u8>,
        timeout: Duration,
        max_output: usize,
    ) -> Result<ExecOutput, SshTransferError> {
        let channel = self.channels.open(self, "exec").await?;
        self.exec_on_channel_with_input(channel, command, input, timeout, max_output)
            .await
            .map_err(SshTransferError::OperationFailed)
    }
}

/// 一个已启动的传输命令。丢弃句柄沿用 SSH 通道的关闭流程。
pub struct TransferCommand(SessionChannel);

impl TransferCommand {
    pub async fn send_input(&self, input: Vec<u8>) -> Result<(), String> {
        self.0
            .data_bytes(input)
            .await
            .map_err(|error| format!("write sync input: {error}"))?;
        self.0
            .eof()
            .await
            .map_err(|error| format!("finish sync input: {error}"))
    }

    pub async fn set_paused(&self, paused: bool) -> Result<(), String> {
        self.0
            .signal(Sig::Custom(if paused { "STOP" } else { "CONT" }.into()))
            .await
            .map_err(|error| format!("control archive command: {error}"))
    }

    /// 消费一条消息并累计有界输出，仅在收到关闭消息或通道结束时返回 true。
    pub async fn read_output(
        &mut self,
        output: &mut ExecOutput,
        stdout_limit: usize,
        stderr_limit: usize,
    ) -> bool {
        match self.0.wait().await {
            Some(ChannelMsg::Data { data }) => append_bounded(
                &mut output.stdout,
                &data,
                &mut output.truncated,
                stdout_limit,
            ),
            Some(ChannelMsg::ExtendedData { data, .. }) => append_bounded(
                &mut output.stderr,
                &data,
                &mut output.truncated,
                stderr_limit,
            ),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                output.exit_code = Some(exit_status as i32)
            }
            Some(ChannelMsg::ExitSignal { .. }) => output.exit_code = Some(128),
            Some(ChannelMsg::Close) | None => return true,
            _ => {}
        }
        false
    }

    pub async fn kill(&self) {
        let _ = self.0.signal(Sig::KILL).await;
        self.close().await;
    }

    pub async fn close(&self) {
        let _ = self.0.close().await;
    }
}
