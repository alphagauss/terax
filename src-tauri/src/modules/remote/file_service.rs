//! SSH 文件内容操作的后端无关服务边界。
//!
//! Tauri 文件命令只通过本模块读取版本化快照和提交文件。正文读取固定使用 SFTP；
//! 版本读取与写入优先通过 Bash 合并远端阶段，并在本层完成安全回退和耗时记录。

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::session::RemoteWorkspace;
use super::sftp;
use super::tasks::file_write::{self, FileWriteTaskError};
use super::tasks::{file_version, TaskKind};

/// 一次有界远端文件读取的正文或过大结果。
pub(crate) enum RemoteFileRead {
    Content {
        bytes: Vec<u8>,
        size: u64,
        mtime: u64,
    },
    TooLarge {
        size: u64,
        mtime: u64,
    },
}

/// 调用方最近确认的远端文件版本。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteVersion {
    pub revision: String,
    pub size: u64,
    pub mtime: u64,
}

/// 条件写入观察到的远端元数据。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteObservedVersion {
    pub size: u64,
    pub mtime: u64,
}

/// 远端条件写入结果。
pub(crate) enum RemoteCheckedWrite {
    Written {
        mtime: u64,
    },
    Conflict {
        current: Option<RemoteObservedVersion>,
    },
}

/// 读取一个有界远端文件快照。
pub(crate) async fn read_snapshot(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    limit: u64,
) -> Result<RemoteFileRead, String> {
    let started_at = Instant::now();
    let result = sftp::read_file_snapshot(workspace, path, limit).await;
    log_backend_completion(
        workspace,
        "read_snapshot",
        "sftp",
        started_at,
        result.is_ok(),
    );
    result
}

/// 在远端数据源计算文件版本，不传输正文。
pub(crate) async fn read_version(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    max_size: u64,
) -> Result<Option<RemoteVersion>, String> {
    let started_at = Instant::now();
    if workspace.tasks.should_attempt(TaskKind::FileVersion) {
        match file_version::read(workspace, path, max_size).await {
            Ok(result) => {
                workspace.tasks.mark_available(TaskKind::FileVersion);
                log_backend_completion(workspace, "read_version", "bash", started_at, true);
                return Ok(result);
            }
            Err(file_version::FileVersionTaskError::Unsupported(reason))
            | Err(file_version::FileVersionTaskError::Protocol(reason)) => {
                workspace.mark_task_unavailable(TaskKind::FileVersion, &reason);
                log::warn!(
                    "SSH Bash file version disabled profile={} reason={}",
                    workspace.profile.id,
                    reason
                );
            }
            Err(file_version::FileVersionTaskError::Business(error))
            | Err(file_version::FileVersionTaskError::Transport(error)) => {
                log_backend_completion(workspace, "read_version", "bash", started_at, false);
                return Err(error);
            }
        }
    }
    let result = sftp::file_version(workspace, path, max_size).await;
    log_backend_completion(
        workspace,
        "read_version",
        "sftp",
        started_at,
        result.is_ok(),
    );
    result
}

/// 无条件原子覆盖远端文件。
pub(crate) async fn write_overwrite(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    replacement_revision: &str,
) -> Result<u64, String> {
    let started_at = Instant::now();
    let task = TaskKind::FileWriteOverwrite;
    if workspace.tasks.should_attempt(task) {
        match file_write::write_overwrite(workspace, path, content, replacement_revision).await {
            Ok(RemoteCheckedWrite::Written { mtime }) => {
                log_backend_completion(workspace, "write_overwrite", "bash", started_at, true);
                return Ok(mtime);
            }
            Ok(RemoteCheckedWrite::Conflict { .. }) => {
                let error = FileWriteTaskError {
                    may_have_committed: true,
                    disable_backend: true,
                };
                record_file_write_fallback(workspace, task, "write_overwrite", &error);
                return reconcile_ambiguous_overwrite(
                    workspace,
                    path,
                    content.len(),
                    replacement_revision,
                )
                .await;
            }
            Err(error) => {
                record_file_write_fallback(workspace, task, "write_overwrite", &error);
                if error.may_have_committed {
                    return reconcile_ambiguous_overwrite(
                        workspace,
                        path,
                        content.len(),
                        replacement_revision,
                    )
                    .await;
                }
            }
        }
    }
    let result = sftp::write_file(workspace, path, content).await;
    log_backend_completion(
        workspace,
        "write_overwrite",
        "sftp",
        started_at,
        result.is_ok(),
    );
    result
}

/// 收敛结果不明确的 Bash 覆盖写，不重新执行无条件覆盖。
///
/// helper 可能已经提交后，目标若不是 replacement，就无法区分原值与第三方后续修改。
/// 此时必须拒绝 SFTP 重试，避免把并发写入静默覆盖。
async fn reconcile_ambiguous_overwrite(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    replacement_size: usize,
    replacement_revision: &str,
) -> Result<u64, String> {
    let current = sftp::file_version(workspace, path, replacement_size as u64)
        .await
        .ok()
        .flatten();
    reconciled_overwrite_mtime(current, replacement_revision)
}

/// 仅在远端内容已经等于 replacement 时接受不明确的覆盖结果。
fn reconciled_overwrite_mtime(
    current: Option<RemoteVersion>,
    replacement_revision: &str,
) -> Result<u64, String> {
    current
        .filter(|version| version.revision == replacement_revision)
        .map(|version| version.mtime)
        .ok_or_else(|| {
            "remote Bash overwrite result is ambiguous; refusing an unconditional retry".into()
        })
}

/// 仅在远端目标仍不存在时原子创建文件。
pub(crate) async fn write_missing(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, String> {
    let started_at = Instant::now();
    let mut may_have_committed = false;
    let task = TaskKind::FileWriteMissing;
    if workspace.tasks.should_attempt(task) {
        match file_write::write_missing(workspace, path, content, replacement_revision).await {
            Ok(result) => {
                log_backend_completion(workspace, "write_missing", "bash", started_at, true);
                return Ok(result);
            }
            Err(error) => {
                may_have_committed = error.may_have_committed;
                record_file_write_fallback(workspace, task, "write_missing", &error);
            }
        }
    }
    let result = sftp::write_file_missing(workspace, path, content).await;
    let result = if may_have_committed && matches!(result, Ok(RemoteCheckedWrite::Conflict { .. }))
    {
        match sftp::file_version(workspace, path, content.len() as u64).await {
            Ok(Some(version)) if version.revision == replacement_revision => {
                Ok(RemoteCheckedWrite::Written {
                    mtime: version.mtime,
                })
            }
            _ => result,
        }
    } else {
        result
    };
    log_backend_completion(
        workspace,
        "write_missing",
        "sftp",
        started_at,
        result.is_ok(),
    );
    result
}

/// 按已确认版本原子提交远端文件。
pub(crate) async fn write_checked(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    expected: &RemoteVersion,
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, String> {
    let started_at = Instant::now();
    let task = TaskKind::FileWriteChecked;
    if workspace.tasks.should_attempt(task) {
        match file_write::write_checked(workspace, path, content, expected, replacement_revision)
            .await
        {
            Ok(result) => {
                log_backend_completion(workspace, "write_checked", "bash", started_at, true);
                return Ok(result);
            }
            Err(error) => record_file_write_fallback(workspace, task, "write_checked", &error),
        }
    }
    let result =
        sftp::write_file_checked(workspace, path, content, expected, replacement_revision).await;
    log_backend_completion(
        workspace,
        "write_checked",
        "sftp",
        started_at,
        result.is_ok(),
    );
    result
}

/// 记录不含路径和正文的文件操作总耗时，供高延迟环境比较后端表现。
fn log_backend_completion(
    workspace: &RemoteWorkspace,
    operation: &str,
    backend: &str,
    started_at: Instant,
    succeeded: bool,
) {
    log::debug!(
        "SSH file operation profile={} operation={} backend={} elapsed_ms={} succeeded={}",
        workspace.profile.id,
        operation,
        backend,
        started_at.elapsed().as_millis(),
        succeeded
    );
}

/// 记录文件写入任务失败，并在协议或执行环境失效时关闭对应快速路径。
fn record_file_write_fallback(
    workspace: &Arc<RemoteWorkspace>,
    task: TaskKind,
    operation: &str,
    error: &FileWriteTaskError,
) {
    if error.disable_backend {
        workspace.mark_task_unavailable(task, "file write task unavailable");
        log::warn!(
            "SSH Bash file write task disabled profile={} operation={} may_have_committed={}",
            workspace.profile.id,
            operation,
            error.may_have_committed
        );
    } else {
        log::debug!(
            "SSH Bash file operation fell back profile={} operation={} may_have_committed={}",
            workspace.profile.id,
            operation,
            error.may_have_committed
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{reconciled_overwrite_mtime, RemoteVersion};

    #[test]
    fn ambiguous_overwrite_only_converges_to_the_replacement() {
        let replacement = "b".repeat(64);
        let matching = RemoteVersion {
            revision: replacement.clone(),
            size: 4,
            mtime: 123,
        };
        let changed = RemoteVersion {
            revision: "c".repeat(64),
            size: 4,
            mtime: 456,
        };

        assert_eq!(
            reconciled_overwrite_mtime(Some(matching), &replacement),
            Ok(123)
        );
        assert!(reconciled_overwrite_mtime(Some(changed), &replacement).is_err());
        assert!(reconciled_overwrite_mtime(None, &replacement).is_err());
    }
}
