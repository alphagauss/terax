//! SSH 文件传输的有界远端 I/O。
//!
//! russh-sftp 的单次请求在 transport 异常断开时可能长期不返回。本模块为每次远端
//! 文件操作设置空闲上限，并按父目录批量探测目标类型；Archive 的长 I/O 还可与
//! 取消信号竞争，避免 Canceling 被单个高延迟请求长期阻塞。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;

use super::super::errors::TransferErrorCode;
use super::super::manager::{TaskControl, TransferRunError};
use super::super::models::TransferEntryKind;

pub(super) const REMOTE_IO_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REMOTE_PROBES: usize = 32;

/// 将 SFTP 协议错误和远端文件流 I/O 错误归一化为传输错误码。
pub(crate) trait RemoteOperationError: std::fmt::Display {
    fn code(&self) -> TransferErrorCode;
}

impl RemoteOperationError for SftpError {
    fn code(&self) -> TransferErrorCode {
        match self {
            Self::Status(status) => match status.status_code {
                StatusCode::PermissionDenied => TransferErrorCode::PermissionDenied,
                StatusCode::NoSuchFile | StatusCode::Eof => TransferErrorCode::SourceUnavailable,
                StatusCode::NoConnection | StatusCode::ConnectionLost => {
                    TransferErrorCode::ConnectionLost
                }
                _ => TransferErrorCode::IoFailed,
            },
            Self::Limited(_) => TransferErrorCode::ResourceLimit,
            Self::Timeout => TransferErrorCode::RequestTimeout,
            Self::IO(_) | Self::UnexpectedBehavior(_) => TransferErrorCode::ConnectionLost,
            Self::UnexpectedPacket => TransferErrorCode::IoFailed,
        }
    }
}

impl RemoteOperationError for std::io::Error {
    fn code(&self) -> TransferErrorCode {
        if self.kind() == std::io::ErrorKind::TimedOut {
            return TransferErrorCode::RequestTimeout;
        }
        if let Some(error) = self
            .get_ref()
            .and_then(|error| error.downcast_ref::<SftpError>())
        {
            return error.code();
        }
        super::super::errors::io_failure("remote operation", self).code
    }
}

/// 执行一次有超时上限的远端操作，并保留可识别的权限、来源和资源错误。
pub(crate) async fn run<T, E>(
    operation: impl Into<String>,
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, TransferRunError>
where
    E: RemoteOperationError,
{
    let operation = operation.into();
    match tokio::time::timeout(REMOTE_IO_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(TransferRunError::failed(
            error.code(),
            format!("{operation}: {error}"),
        )),
        Err(_) => Err(TransferRunError::failed(
            TransferErrorCode::RequestTimeout,
            format!(
                "{operation} timed out after {}s",
                REMOTE_IO_TIMEOUT.as_secs()
            ),
        )),
    }
}

/// 执行可被任务取消立即中断等待的远端操作。
///
/// 取消时丢弃仍在等待的 SFTP future，由任务关闭专用会话并清理 staging。这样高
/// RTT 链路不必等到单次 60 秒 I/O 超时才把任务从 Canceling 推进到 Canceled。
pub(crate) async fn run_cancellable<T, E>(
    operation: impl Into<String>,
    future: impl Future<Output = Result<T, E>>,
    control: &TaskControl,
) -> Result<T, TransferRunError>
where
    E: RemoteOperationError,
{
    tokio::select! {
        biased;
        _ = control.cancelled() => Err(TransferRunError::Canceled),
        result = run(operation, future) => result,
    }
}

/// 仅用于按固定偏移读取，不允许复用到写入、重命名或提交操作。
pub(crate) async fn retry_read<T, F, Fut>(
    operation: &str,
    mut read: F,
) -> Result<T, TransferRunError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, SftpError>>,
{
    for attempt in 0..3 {
        let started = std::time::Instant::now();
        let result = run(operation, read()).await;
        match result {
            Err(TransferRunError::Failed(ref failure))
                if failure.code == TransferErrorCode::RequestTimeout && attempt < 2 =>
            {
                log::warn!(
                    "TRANSFER event=read_retry operation={operation} attempt={} elapsed_ms={}",
                    attempt + 1,
                    started.elapsed().as_millis()
                );
            }
            result => return result,
        }
    }
    unreachable!()
}

/// 按父目录批量读取 SSH 目标类型，目录列表不可用时回退到有界并发逐项探测。
pub(crate) async fn entry_kinds(
    session: &Arc<SftpSession>,
    paths: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, Option<TransferEntryKind>>, TransferRunError> {
    let mut parents: HashMap<String, Vec<String>> = HashMap::new();
    for path in paths.into_iter().collect::<HashSet<_>>() {
        let parent = remote_parent(&path).unwrap_or("/").to_string();
        parents.entry(parent).or_default().push(path);
    }
    let mut pending = stream::iter(parents)
        .map(|(parent, paths)| {
            let session = session.clone();
            async move {
                if paths.len() == 1 {
                    return entry_kinds_individual(&session, paths).await;
                }
                let entries = run(
                    format!("list remote transfer destination parent {parent}"),
                    session.read_dir(parent),
                )
                .await;
                match entries {
                    Ok(entries) => {
                        let candidates: HashSet<_> = paths.iter().cloned().collect();
                        let mut kinds: HashMap<_, _> =
                            paths.into_iter().map(|path| (path, None)).collect();
                        for entry in entries {
                            let path = entry.path();
                            if candidates.contains(&path) {
                                kinds.insert(path, Some(remote_file_type(entry.file_type())));
                            }
                        }
                        Ok(kinds)
                    }
                    Err(_) => entry_kinds_individual(&session, paths).await,
                }
            }
        })
        .buffer_unordered(MAX_REMOTE_PROBES);
    let mut result = HashMap::new();
    while let Some(group) = pending.next().await {
        result.extend(group?);
    }
    Ok(result)
}

async fn entry_kinds_individual(
    session: &Arc<SftpSession>,
    paths: Vec<String>,
) -> Result<HashMap<String, Option<TransferEntryKind>>, TransferRunError> {
    let mut pending = stream::iter(paths)
        .map(|path| {
            let session = session.clone();
            async move {
                let metadata = run(
                    format!("stat remote transfer destination {path}"),
                    session.symlink_metadata(path.clone()),
                )
                .await;
                let kind = match metadata {
                    Ok(metadata) => Some(remote_file_type(metadata.file_type())),
                    Err(TransferRunError::Failed(failure))
                        if failure.code == TransferErrorCode::SourceUnavailable =>
                    {
                        None
                    }
                    Err(error) => return Err(error),
                };
                Ok((path, kind))
            }
        })
        .buffer_unordered(MAX_REMOTE_PROBES);
    let mut result = HashMap::new();
    while let Some(probe) = pending.next().await {
        let (path, kind) = probe?;
        result.insert(path, kind);
    }
    Ok(result)
}

fn remote_file_type(file_type: russh_sftp::protocol::FileType) -> TransferEntryKind {
    if file_type.is_file() {
        TransferEntryKind::File
    } else if file_type.is_dir() {
        TransferEntryKind::Directory
    } else {
        TransferEntryKind::Other
    }
}

fn remote_parent(path: &str) -> Option<&str> {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_read_timeouts_retry_and_attempts_are_bounded() {
        let mut attempts = 0;
        let value = retry_read("read offset=32", || {
            attempts += 1;
            std::future::ready(if attempts < 3 {
                Err(SftpError::Timeout)
            } else {
                Ok(42)
            })
        })
        .await
        .unwrap();
        assert_eq!((value, attempts), (42, 3));
        attempts = 0;
        let error = retry_read("read stalled", || {
            attempts += 1;
            std::future::ready(Err::<(), _>(SftpError::Timeout))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 3);
        assert_eq!(
            error.failure().unwrap().code,
            TransferErrorCode::RequestTimeout
        );
        attempts = 0;
        let _ = retry_read("read disconnected", || {
            attempts += 1;
            std::future::ready(Err::<(), _>(SftpError::UnexpectedBehavior("closed".into())))
        })
        .await;
        assert_eq!(attempts, 1);
        assert_eq!(
            std::io::Error::other(SftpError::Timeout).code(),
            TransferErrorCode::RequestTimeout
        );
    }

    #[tokio::test]
    async fn remote_errors_keep_a_stable_retryable_code() {
        let error = run(
            "read remote file",
            std::future::ready(Err::<(), _>(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed",
            ))),
        )
        .await
        .unwrap_err();
        let TransferRunError::Failed(failure) = error else {
            panic!("expected a structured failure");
        };
        assert_eq!(failure.code, TransferErrorCode::ConnectionLost);
        assert!(failure.retryable);
        assert!(failure.detail.contains("read remote file"));
    }

    #[tokio::test]
    async fn remote_permission_errors_are_not_reported_as_disconnects() {
        let denied = SftpError::Status(russh_sftp::protocol::Status {
            id: 1,
            status_code: StatusCode::PermissionDenied,
            error_message: "denied".into(),
            language_tag: "en".into(),
        });
        let error = run(
            "create remote destination",
            std::future::ready(Err::<(), _>(denied)),
        )
        .await
        .unwrap_err();
        let TransferRunError::Failed(failure) = error else {
            panic!("expected a structured failure");
        };
        assert_eq!(failure.code, TransferErrorCode::PermissionDenied);
        assert!(!failure.retryable);
    }

    #[tokio::test]
    async fn cancellable_remote_operation_does_not_wait_for_io_timeout() {
        let control = TaskControl::new();
        control.cancel();
        let error = run_cancellable(
            "blocked remote operation",
            std::future::pending::<Result<(), std::io::Error>>(),
            &control,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, TransferRunError::Canceled));
    }
}
