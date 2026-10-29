//! SSH 传输任务的独占 SFTP channel 创建。
//!
//! raw channel 只服务单个传输任务，避免目录浏览请求和大文件数据包相互排队。

use std::sync::Arc;

use russh_sftp::client::{Config, RawSftpSession, SftpSession};

use crate::modules::remote::session::RemoteWorkspace;
use crate::modules::transfers::errors::TransferErrorCode;
use crate::modules::transfers::manager::TransferRunError;

/// 打开任务独占的高层 SFTP 会话。
///
/// 上传文件使用有界的并发 WRITE 确认队列，不缓存完整文件，也不阻塞 Explorer 会话。
pub(crate) async fn open(
    workspace: &Arc<RemoteWorkspace>,
) -> Result<Arc<SftpSession>, TransferRunError> {
    let channel = workspace.open_session("transfer_metadata").await?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| {
            TransferRunError::failed(
                TransferErrorCode::ConnectionLost,
                format!("request transfer SFTP subsystem: {error}"),
            )
        })?;
    let config = Config {
        max_concurrent_writes: 32,
        request_timeout_secs: super::io::REMOTE_IO_TIMEOUT.as_secs(),
        ..Default::default()
    };
    let session = super::io::run(
        "initialize transfer SFTP session",
        SftpSession::new_with_config(channel.into_stream(), config),
    )
    .await?;
    Ok(Arc::new(session))
}

/// 打开并初始化任务独占的 raw SFTP channel。
pub(crate) async fn open_raw(
    workspace: &Arc<RemoteWorkspace>,
) -> Result<Arc<RawSftpSession>, TransferRunError> {
    let channel = workspace.open_session("transfer_data").await?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| {
            TransferRunError::failed(
                TransferErrorCode::ConnectionLost,
                format!("request transfer SFTP subsystem: {error}"),
            )
        })?;
    let session = Arc::new(RawSftpSession::new(channel.into_stream()));
    session.set_timeout(super::io::REMOTE_IO_TIMEOUT.as_secs());
    super::io::run("initialize transfer SFTP session", session.init()).await?;
    Ok(session)
}
