//! SSH 文件系统变更服务。
//!
//! 复合变更优先使用封闭 Bash 任务；只有明确未执行且能力缺失时才回退传统 SFTP，
//! 避免结果不明确时重复创建或覆盖远端对象。

use std::sync::Arc;

use super::session::RemoteWorkspace;
use super::tasks::create_directory::{self, CreateDirectoryOutcome, CreateDirectoryTaskError};
use super::tasks::TaskKind;

/// 创建目录及其缺失父链，保留目标已存在错误。
pub(crate) async fn create_directory(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<(), String> {
    let task = TaskKind::CreateDirectory;
    if workspace.tasks.should_attempt(task) {
        match create_directory::create(workspace, path).await {
            Ok(CreateDirectoryOutcome::Created) => {
                workspace.tasks.mark_available(task);
                return Ok(());
            }
            Ok(CreateDirectoryOutcome::Exists) => {
                workspace.tasks.mark_available(task);
                return Err(format!("already exists: {path}"));
            }
            Err(CreateDirectoryTaskError::Unsupported(reason)) => {
                workspace.tasks.mark_unavailable(task, reason);
            }
            Err(CreateDirectoryTaskError::Protocol(error)) => {
                workspace.tasks.mark_unavailable(task, &error);
                return Err(error);
            }
            Err(CreateDirectoryTaskError::Business(error))
            | Err(CreateDirectoryTaskError::Transport(error)) => return Err(error),
        }
    }
    super::sftp::create_dir(workspace, path).await
}
