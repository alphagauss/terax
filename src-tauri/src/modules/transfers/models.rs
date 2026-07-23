//! 文件传输命令与前端共享的数据模型。
//!
//! 模型只描述当前 Workspace 进程内的传输任务，不持久化凭据，也不暴露可由
//! 前端任意切换的 SSH profile。Direct 与 Archive 由不同命令显式选择。

use serde::{Deserialize, Serialize};

use super::errors::{TransferErrorCode, TransferFailure};

const MAX_TRANSFER_SOURCES: usize = 1_024;
const MAX_TRANSFER_PATH_BYTES: usize = 32 * 1_024;

/// 文件传输方向。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

/// 用户显式选择的传输策略。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStrategy {
    Direct,
    Archive,
}

/// 传输任务的外部生命周期状态。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Canceling,
    Completed,
    Failed,
    Canceled,
}

impl TransferStatus {
    /// 返回任务是否已经进入不可继续执行的终态。
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Canceled)
    }
}

/// 任务当前所在的执行阶段。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStage {
    Queued,
    Scanning,
    Archiving,
    Transferring,
    Extracting,
    Verifying,
    Finalizing,
    Finished,
}

/// 创建后台传输任务的请求。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueTransferRequest {
    pub direction: TransferDirection,
    pub sources: Vec<String>,
    pub destination: String,
}

impl EnqueueTransferRequest {
    /// 校验不依赖文件系统的请求边界，并保留路径首尾的合法空格。
    pub fn normalize(mut self) -> Result<Self, TransferFailure> {
        self.sources.retain(|source| !source.trim().is_empty());
        if self.sources.is_empty() {
            return Err(TransferFailure::new(
                TransferErrorCode::InvalidRequest,
                "transfer requires at least one source",
            ));
        }
        if self.sources.len() > MAX_TRANSFER_SOURCES {
            return Err(TransferFailure::new(
                TransferErrorCode::ResourceLimit,
                format!("transfer source count exceeds {MAX_TRANSFER_SOURCES}"),
            ));
        }
        if self.destination.trim().is_empty() {
            return Err(TransferFailure::new(
                TransferErrorCode::InvalidRequest,
                "transfer destination is required",
            ));
        }
        if self.destination.len() > MAX_TRANSFER_PATH_BYTES
            || self
                .sources
                .iter()
                .any(|source| source.len() > MAX_TRANSFER_PATH_BYTES)
        {
            return Err(TransferFailure::new(
                TransferErrorCode::ResourceLimit,
                "transfer path exceeds the IPC safety limit",
            ));
        }
        Ok(self)
    }
}

/// 可供前端展示的完整任务快照。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTaskSnapshot {
    pub id: String,
    pub direction: TransferDirection,
    pub strategy: TransferStrategy,
    pub status: TransferStatus,
    pub stage: TransferStage,
    pub source_count: u64,
    pub destination: String,
    pub name: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub total_files: u64,
    pub completed_files: u64,
    pub total_roots: u64,
    pub committed_roots: u64,
    pub speed_bytes_per_second: u64,
    pub current_file: Option<String>,
    pub failure: Option<TransferFailure>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_empty_requests_without_rewriting_paths() {
        let normalized = EnqueueTransferRequest {
            direction: TransferDirection::Upload,
            sources: vec!["  ".into(), " C:/a.txt ".into()],
            destination: " /tmp ".into(),
        }
        .normalize()
        .unwrap();
        assert_eq!(normalized.sources, vec![" C:/a.txt "]);
        assert_eq!(normalized.destination, " /tmp ");

        assert!(EnqueueTransferRequest {
            direction: TransferDirection::Download,
            sources: vec![],
            destination: "/tmp".into(),
        }
        .normalize()
        .is_err());
    }

    #[test]
    fn only_finished_states_are_terminal() {
        assert!(TransferStatus::Completed.is_terminal());
        assert!(TransferStatus::Failed.is_terminal());
        assert!(TransferStatus::Canceled.is_terminal());
        assert!(!TransferStatus::Paused.is_terminal());
        assert!(!TransferStatus::Canceling.is_terminal());
    }

    #[test]
    fn normalize_caps_untrusted_request_size() {
        let error = EnqueueTransferRequest {
            direction: TransferDirection::Upload,
            sources: (0..=MAX_TRANSFER_SOURCES)
                .map(|index| format!("/{index}"))
                .collect(),
            destination: "/tmp".into(),
        }
        .normalize()
        .unwrap_err();
        assert_eq!(error.code, TransferErrorCode::ResourceLimit);
    }
}
