//! SSH 文件传输的有界远端 I/O。
//!
//! russh-sftp 的单次请求在 transport 异常断开时可能长期不返回。本模块为每次远端
//! 文件操作设置空闲上限，使任务能够进入失败终态并交还调度许可。

use std::future::Future;
use std::time::Duration;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::StatusCode;

use super::super::errors::TransferErrorCode;
use super::super::manager::TransferRunError;

const REMOTE_IO_TIMEOUT: Duration = Duration::from_secs(15);

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
            Self::Timeout | Self::IO(_) | Self::UnexpectedBehavior(_) => {
                TransferErrorCode::ConnectionLost
            }
            Self::UnexpectedPacket => TransferErrorCode::IoFailed,
        }
    }
}

impl RemoteOperationError for std::io::Error {
    fn code(&self) -> TransferErrorCode {
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
            TransferErrorCode::ConnectionLost,
            format!("{operation} timed out"),
        )),
    }
}

/// 执行允许目标不存在的远端操作，供幂等清理使用。
pub(crate) async fn run_optional<T>(
    operation: impl Into<String>,
    future: impl Future<Output = Result<T, SftpError>>,
) -> Result<Option<T>, TransferRunError> {
    let operation = operation.into();
    match tokio::time::timeout(REMOTE_IO_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(Some(value)),
        Ok(Err(SftpError::Status(status))) if status.status_code == StatusCode::NoSuchFile => {
            Ok(None)
        }
        Ok(Err(error)) => Err(TransferRunError::failed(
            TransferErrorCode::ConnectionLost,
            format!("{operation}: {error}"),
        )),
        Err(_) => Err(TransferRunError::failed(
            TransferErrorCode::ConnectionLost,
            format!("{operation} timed out"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn optional_remote_operations_treat_missing_paths_as_success() {
        let missing = SftpError::Status(russh_sftp::protocol::Status {
            id: 1,
            status_code: StatusCode::NoSuchFile,
            error_message: "missing".into(),
            language_tag: "en".into(),
        });
        let result = run_optional(
            "stat remote staging path",
            std::future::ready(Err::<(), _>(missing)),
        )
        .await
        .unwrap();
        assert!(result.is_none());
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
}
