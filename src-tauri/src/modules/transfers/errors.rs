//! 文件传输错误协议。
//!
//! 后端以稳定错误码向前端描述失败类别，动态路径、操作系统错误和远端输出只作为
//! 诊断细节。前端据此本地化用户提示，不依赖英文错误文本做控制流判断。

use serde::Serialize;
use std::error::Error;
use std::fmt;
use std::io;

/// 前端可稳定识别和翻译的传输错误码。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferErrorCode {
    InvalidRequest,
    WorkspaceUnavailable,
    SourceUnavailable,
    SourceChanged,
    DestinationExists,
    DestinationBusy,
    ArchiveUnavailable,
    IntegrityCheckFailed,
    PermissionDenied,
    ConnectionLost,
    StorageFull,
    ResourceLimit,
    TaskNotFound,
    InvalidTaskState,
    IoFailed,
    Internal,
}

/// 通过 IPC 和任务快照暴露的结构化失败信息。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFailure {
    pub code: TransferErrorCode,
    pub detail: String,
    pub retryable: bool,
}

impl TransferFailure {
    /// 创建失败信息，并由错误类别统一决定是否允许用户重试。
    pub fn new(code: TransferErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
            retryable: matches!(
                code,
                TransferErrorCode::SourceUnavailable
                    | TransferErrorCode::SourceChanged
                    | TransferErrorCode::DestinationBusy
                    | TransferErrorCode::ConnectionLost
                    | TransferErrorCode::StorageFull
                    | TransferErrorCode::IoFailed
                    | TransferErrorCode::Internal
            ),
        }
    }
}

/// 将底层 I/O 错误映射为稳定类别，同时保留原始诊断信息。
pub(crate) fn io_failure(context: impl AsRef<str>, error: &std::io::Error) -> TransferFailure {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => TransferErrorCode::SourceUnavailable,
        std::io::ErrorKind::AlreadyExists => TransferErrorCode::DestinationExists,
        std::io::ErrorKind::PermissionDenied => TransferErrorCode::PermissionDenied,
        std::io::ErrorKind::StorageFull => TransferErrorCode::StorageFull,
        std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::ConnectionRefused
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::TimedOut
        | std::io::ErrorKind::UnexpectedEof => TransferErrorCode::ConnectionLost,
        _ => TransferErrorCode::IoFailed,
    };
    TransferFailure::new(code, format!("{}: {error}", context.as_ref()))
}

/// 为阻塞 I/O 错误补充操作和路径，同时保留错误类别及原始系统错误文本。
pub(crate) fn contextual_io_error(context: impl AsRef<str>, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{}: {error}", context.as_ref()))
}

#[derive(Debug)]
struct SourceChangedIo {
    detail: String,
}

impl fmt::Display for SourceChangedIo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl Error for SourceChangedIo {}

/// 创建可在阻塞归档边界识别的来源变化错误。
pub(crate) fn source_changed_io(detail: impl Into<String>) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        SourceChangedIo {
            detail: detail.into(),
        },
    )
}

/// 判断阻塞 I/O 错误是否由来源身份或内容变化产生。
pub(crate) fn is_source_changed_io(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<SourceChangedIo>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryability_is_defined_by_error_semantics() {
        assert!(TransferFailure::new(TransferErrorCode::ConnectionLost, "disconnected").retryable);
        assert!(!TransferFailure::new(TransferErrorCode::DestinationExists, "exists").retryable);
        assert!(!TransferFailure::new(TransferErrorCode::PermissionDenied, "denied").retryable);
    }

    #[test]
    fn io_errors_keep_details_but_expose_stable_codes() {
        let failure = io_failure(
            "read source",
            &std::io::Error::new(std::io::ErrorKind::PermissionDenied, "blocked"),
        );
        assert_eq!(failure.code, TransferErrorCode::PermissionDenied);
        assert!(failure.detail.contains("read source"));
        assert!(failure.detail.contains("blocked"));
    }

    #[test]
    fn contextual_io_errors_keep_kind_operation_and_path() {
        let error = contextual_io_error(
            "read directory C:\\workspace\\.pytest_cache",
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "blocked"),
        );
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(error
            .to_string()
            .contains("read directory C:\\workspace\\.pytest_cache"));
        assert!(error.to_string().contains("blocked"));
    }

    #[test]
    fn storage_full_errors_remain_retryable_after_space_is_released() {
        let failure = io_failure(
            "write destination",
            &std::io::Error::new(std::io::ErrorKind::StorageFull, "full"),
        );
        assert_eq!(failure.code, TransferErrorCode::StorageFull);
        assert!(failure.retryable);
    }
}
