//! SSH 文件内容操作的后端无关服务边界。
//!
//! Tauri 文件命令只通过本模块读取版本化快照和提交文件。当前默认后端仍是 SFTP，
//! 后续可选加速器必须复用相同结果语义，并在本层完成选择、回退和耗时记录。

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::python_file::{self, PythonFileError};
use super::session::RemoteWorkspace;
use super::sftp;

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
    if workspace.python_file_write_acceleration_available().await {
        match python_file::write_overwrite(workspace, path, content, replacement_revision).await {
            Ok(RemoteCheckedWrite::Written { mtime }) => {
                log_backend_completion(workspace, "write_overwrite", "python", started_at, true);
                return Ok(mtime);
            }
            Ok(RemoteCheckedWrite::Conflict { .. }) => {
                let error = PythonFileError {
                    dispatched: true,
                    disable_backend: true,
                };
                record_python_fallback(workspace, "write_overwrite", &error);
                return reconcile_dispatched_overwrite(
                    workspace,
                    path,
                    content.len(),
                    replacement_revision,
                )
                .await;
            }
            Err(error) => {
                record_python_fallback(workspace, "write_overwrite", &error);
                if error.dispatched {
                    return reconcile_dispatched_overwrite(
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

/// 收敛结果不明确的 Python 覆盖写，不重新执行无条件覆盖。
///
/// helper 可能已经提交后，目标若不是 replacement，就无法区分原值与第三方后续修改。
/// 此时必须拒绝 SFTP 重试，避免把并发写入静默覆盖。
async fn reconcile_dispatched_overwrite(
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
            "remote Python overwrite result is ambiguous; refusing an unconditional retry".into()
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
    let mut dispatched = false;
    if workspace.python_file_write_acceleration_available().await {
        match python_file::write_missing(workspace, path, content, replacement_revision).await {
            Ok(result) => {
                log_backend_completion(workspace, "write_missing", "python", started_at, true);
                return Ok(result);
            }
            Err(error) => {
                dispatched = error.dispatched;
                record_python_fallback(workspace, "write_missing", &error);
            }
        }
    }
    let result = sftp::write_file_missing(workspace, path, content).await;
    let result = if dispatched && matches!(result, Ok(RemoteCheckedWrite::Conflict { .. })) {
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
    if workspace.python_file_write_acceleration_available().await {
        match python_file::write_checked(workspace, path, content, expected, replacement_revision)
            .await
        {
            Ok(result) => {
                log_backend_completion(workspace, "write_checked", "python", started_at, true);
                return Ok(result);
            }
            Err(error) => record_python_fallback(workspace, "write_checked", &error),
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

/// 记录 helper 失败并在协议或执行环境失效时关闭当前 epoch 的加速路径。
fn record_python_fallback(
    workspace: &Arc<RemoteWorkspace>,
    operation: &str,
    error: &PythonFileError,
) {
    if error.disable_backend {
        workspace.disable_python_file_acceleration();
        log::warn!(
            "SSH Python file accelerator disabled profile={} operation={} dispatched={}",
            workspace.profile.id,
            operation,
            error.dispatched
        );
    } else {
        log::debug!(
            "SSH Python file operation fell back profile={} operation={} dispatched={}",
            workspace.profile.id,
            operation,
            error.dispatched
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
