//! 文件传输命令与前端共享的数据模型。
//!
//! 模型描述当前 Workspace 的传输任务及其 Journal 快照，不包含凭据，也不暴露可由
//! 前端任意切换的 SSH profile。Direct 与 Archive 由请求中的策略显式选择。

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
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStrategy {
    Direct,
    Archive,
}

/// 传输任务的外部生命周期状态。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    AwaitingDecision,
    Canceling,
    Completed,
    CompletedWithErrors,
    Failed,
    Canceled,
}

impl TransferStatus {
    /// 返回任务是否已经进入不可继续执行的终态。
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::CompletedWithErrors | Self::Failed | Self::Canceled
        )
    }
}

/// 任务当前所在的执行阶段。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStage {
    Queued,
    Scanning,
    CheckingConflicts,
    Archiving,
    Transferring,
    Extracting,
    Verifying,
    Finalizing,
    Finished,
}

/// 创建后台传输任务的请求。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueTransferRequest {
    /// 指定时同步单个目录的内容，仅新增及更新修改时间更晚的文件。
    pub sync: Option<FolderSyncOptions>,
    pub direction: TransferDirection,
    pub strategy: TransferStrategy,
    pub sources: Vec<String>,
    pub destination: String,
    /// 单文件下载的用户指定名称，目录与上传不接受此字段。
    pub destination_name: Option<String>,
}

impl EnqueueTransferRequest {
    /// 校验不依赖文件系统的请求边界，并保留路径首尾的合法空格。
    pub fn normalize(mut self) -> Result<Self, TransferFailure> {
        if let Some(options) = &self.sync {
            if self.strategy != TransferStrategy::Archive
                || self.sources.len() != 1
                || self.destination_name.is_some()
            {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidRequest,
                    "folder sync requires one directory and archive strategy",
                ));
            }
            options.validate()?;
            let remote = match self.direction {
                TransferDirection::Upload => &mut self.destination,
                TransferDirection::Download => &mut self.sources[0],
            };
            // 同步目标映射到目录本身，先消除尾斜杠和当前目录段，避免 WSL 同级 staging 多套一层。
            *remote = normalize_sync_root(remote)?;
        }
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
        if let Some(name) = &self.destination_name {
            if self.direction != TransferDirection::Download
                || self.strategy != TransferStrategy::Direct
                || self.sources.len() != 1
                || name.is_empty()
                || name == "."
                || name == ".."
                || name.contains('/')
                || (cfg!(windows) && name.contains(['\\', ':']))
                || name.chars().any(char::is_control)
                || name.len() > 255
            {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidRequest,
                    "invalid single-file download name",
                ));
            }
        }
        Ok(self)
    }
}

/// 显式名称排除优先于源端目录内的 .gitignore；目录排除项不匹配同名文件。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncOptions {
    pub exclude_git: bool,
    pub excludes: Vec<String>,
    pub exclude_directories: Vec<String>,
    pub respect_gitignore: bool,
}

impl FolderSyncOptions {
    /// 保留 .git 预设与自定义名称的独立状态，并统一扫描时的名称匹配。
    pub(crate) fn excludes_name(&self, name: &str) -> bool {
        (self.exclude_git && name == ".git") || self.excludes.iter().any(|value| value == name)
    }

    pub(crate) fn validate(&self) -> Result<(), TransferFailure> {
        let git_preset_count =
            usize::from(self.exclude_git && !self.excludes.iter().any(|name| name == ".git"));
        if self.excludes.len() + self.exclude_directories.len() + git_preset_count > 128
            || self
                .excludes
                .iter()
                .chain(&self.exclude_directories)
                .any(|name| {
                    name.is_empty()
                        || name == "."
                        || name == ".."
                        || name.len() > 255
                        || name.contains(['/', '\\'])
                        || name.chars().any(char::is_control)
                })
        {
            return Err(TransferFailure::new(
                TransferErrorCode::InvalidRequest,
                "invalid sync exclusions",
            ));
        }
        Ok(())
    }
}

/// 同步记录与任务共用环境目录规范化规则，不解析链接或改变大小写。
pub(crate) fn normalize_sync_root(path: &str) -> Result<String, TransferFailure> {
    if !path.starts_with('/')
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| part == "..")
    {
        return Err(TransferFailure::new(
            TransferErrorCode::InvalidRequest,
            "invalid sync root",
        ));
    }
    let parts: Vec<_> = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.is_empty() {
        return Err(TransferFailure::new(
            TransferErrorCode::InvalidRequest,
            "cannot sync a filesystem root",
        ));
    }
    Ok(format!("/{}", parts.join("/")))
}

/// 冲突目标和来源的条目类型。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferEntryKind {
    File,
    Directory,
    Other,
}

/// 前端可展示的冲突交互类型。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferConflictKind {
    File,
    ArchiveDirectory,
    TypeMismatch,
}

/// 单个冲突允许提交的稳定动作。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferConflictDecision {
    Cancel,
    Skip,
    Replace,
    ReplaceDirectory,
    Merge,
    MergeSkip,
}

/// 当前正在等待用户处理的目标冲突。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferConflict {
    pub id: String,
    pub kind: TransferConflictKind,
    pub source_kind: TransferEntryKind,
    pub destination_kind: TransferEntryKind,
    pub source_path: String,
    pub destination_path: String,
    pub decisions: Vec<TransferConflictDecision>,
    pub allow_apply_to_remaining: bool,
}

/// 用户对当前冲突提交的一次性决策。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveTransferConflictRequest {
    pub task_id: String,
    pub conflict_id: String,
    pub decision: TransferConflictDecision,
    pub apply_to_remaining: bool,
}

/// Direct 任务中可独立重试或忽略的文件失败。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferFileFailure {
    pub id: String,
    pub source_path: String,
    pub destination_path: String,
    pub failure: TransferFailure,
    pub attempts: u32,
    pub ignored: bool,
}

/// 可供前端展示的完整任务快照。
#[derive(Clone, Debug, Deserialize, Serialize)]
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
    pub failed_files: u64,
    pub unprocessed_files: u64,
    pub total_roots: u64,
    pub committed_roots: u64,
    pub speed_bytes_per_second: u64,
    pub current_file: Option<String>,
    pub failure: Option<TransferFailure>,
    pub file_failures: Vec<TransferFileFailure>,
    pub conflict: Option<TransferConflict>,
    pub is_directory: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_preset_keeps_the_effective_exclusion_limit() {
        let mut options = FolderSyncOptions {
            exclude_git: true,
            excludes: (0..128).map(|index| format!("name-{index}")).collect(),
            ..Default::default()
        };
        assert!(options.validate().is_err());
        options.excludes.pop();
        assert!(options.validate().is_ok());
        options.excludes.push(".git".into());
        assert!(options.validate().is_ok());
        options.exclude_directories.push("target".into());
        assert!(options.validate().is_err());
    }

    #[test]
    fn sync_normalizes_remote_directory_components_before_staging_mapping() {
        let request = EnqueueTransferRequest {
            sync: Some(FolderSyncOptions::default()),
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Archive,
            sources: vec!["C:/local".into()],
            destination: "//home//project/./".into(),
            destination_name: None,
        };
        assert_eq!(
            request.clone().normalize().unwrap().destination,
            "/home/project"
        );
        let mut download = request.clone();
        download.direction = TransferDirection::Download;
        download.sources = vec!["/home/project/./".into()];
        download.destination = "C:/local".into();
        assert_eq!(download.normalize().unwrap().sources, ["/home/project"]);
        for path in ["/", "/./", "/home/../project", "relative"] {
            let mut invalid = request.clone();
            invalid.destination = path.into();
            assert!(invalid.normalize().is_err());
        }
    }

    #[test]
    fn save_as_name_is_limited_to_single_file_direct_downloads() {
        let request = EnqueueTransferRequest {
            sync: None,
            direction: TransferDirection::Download,
            strategy: TransferStrategy::Direct,
            sources: vec!["/home/file.txt".into()],
            destination: "/tmp".into(),
            destination_name: Some("新文件.txt".into()),
        };
        assert!(request.clone().normalize().is_ok());
        for name in ["", ".", "..", "../escape", "a/b", "a\nname"] {
            let mut invalid = request.clone();
            invalid.destination_name = Some(name.into());
            assert!(invalid.normalize().is_err(), "{name}");
        }
        for name in ["a\\b", "a:stream"] {
            let mut platform_name = request.clone();
            platform_name.destination_name = Some(name.into());
            assert_eq!(platform_name.normalize().is_ok(), !cfg!(windows));
        }
        let mut upload = request.clone();
        upload.direction = TransferDirection::Upload;
        assert!(upload.normalize().is_err());
        let mut archive = request.clone();
        archive.strategy = TransferStrategy::Archive;
        assert!(archive.normalize().is_err());
        let mut multiple = request;
        multiple.sources.push("/home/other".into());
        assert!(multiple.normalize().is_err());
    }

    #[test]
    fn normalize_rejects_empty_requests_without_rewriting_paths() {
        let normalized = EnqueueTransferRequest {
            sync: None,
            destination_name: None,
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Direct,
            sources: vec!["  ".into(), " C:/a.txt ".into()],
            destination: " /tmp ".into(),
        }
        .normalize()
        .unwrap();
        assert_eq!(normalized.sources, vec![" C:/a.txt "]);
        assert_eq!(normalized.destination, " /tmp ");

        assert!(EnqueueTransferRequest {
            sync: None,
            destination_name: None,
            direction: TransferDirection::Download,
            strategy: TransferStrategy::Archive,
            sources: vec![],
            destination: "/tmp".into(),
        }
        .normalize()
        .is_err());
    }

    #[test]
    fn only_finished_states_are_terminal() {
        assert!(TransferStatus::Completed.is_terminal());
        assert!(TransferStatus::CompletedWithErrors.is_terminal());
        assert!(TransferStatus::Failed.is_terminal());
        assert!(TransferStatus::Canceled.is_terminal());
        assert!(!TransferStatus::Paused.is_terminal());
        assert!(!TransferStatus::AwaitingDecision.is_terminal());
        assert!(!TransferStatus::Canceling.is_terminal());
    }

    #[test]
    fn normalize_caps_untrusted_request_size() {
        let error = EnqueueTransferRequest {
            sync: None,
            destination_name: None,
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Direct,
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
