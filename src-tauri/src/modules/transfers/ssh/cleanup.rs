//! SSH 连接恢复后的延迟 staging 清理。
//!
//! 传输连接中断时，原会话无法立即删除任务私有路径。本模块在当前 Workspace 进程
//! 内等待同一 profile 重连，随后用一个受限的服务器本地命令清理任务私有路径。

use std::sync::Arc;
use std::time::Duration;

use crate::modules::remote::manager::global_manager;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

use super::super::errors::TransferErrorCode;
use super::super::manager::TransferRunError;

const CLEANUP_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);
const CLEANUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CLEANUP_COMMAND_BYTES: usize = 64 * 1024;

/// 在后台等待同一 SSH profile 恢复，并清理当前任务明确拥有的路径。
pub(crate) fn schedule(profile_id: String, mut paths: Vec<String>) {
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if tokio::time::timeout(
            CLEANUP_RETRY_WINDOW,
            cleanup_after_reconnect(&profile_id, &paths),
        )
        .await
        .is_err()
        {
            log::warn!(
                "remote transfer cleanup expired for profile {profile_id}: {} path(s)",
                paths.len()
            );
        }
    });
}

/// 用少量服务器本地命令删除经过验证的任务私有路径，并返回仍需重试的路径。
///
/// 此入口只接受 Terax 生成的固定命名，拒绝任意用户路径。`rm -rf` 在远端本地递归，
/// 不会把目录中文件数量放大为逐项 SFTP 往返。
pub(crate) async fn remove_now(workspace: &Arc<RemoteWorkspace>, paths: &[String]) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }
    let home = workspace.home().await;
    if let Some(path) = paths
        .iter()
        .find(|path| !is_owned_cleanup_path(path, &home))
    {
        log::warn!("refused to clean invalid remote transfer path: {path}");
        return paths.to_vec();
    }

    let mut remaining = Vec::new();
    for batch in cleanup_batches(paths) {
        let command = cleanup_command(&batch);
        match workspace
            .exec(&command, None, CLEANUP_COMMAND_TIMEOUT)
            .await
        {
            Ok(output) if output.exit_code == Some(0) && !output.timed_out && !output.truncated => {
            }
            Ok(output) => {
                log::warn!(
                    "remote transfer cleanup command failed with exit {:?}: {}",
                    output.exit_code,
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                remaining.extend(batch.into_iter().cloned());
            }
            Err(error) => {
                log::warn!("failed to start remote transfer cleanup: {error}");
                remaining.extend(batch.into_iter().cloned());
            }
        }
    }
    remaining
}

/// 循环等待 Workspace 重连，并用服务器本地递归删除重试尚未清理的路径。
async fn cleanup_after_reconnect(profile_id: &str, paths: &[String]) {
    let mut remaining = paths.to_vec();
    loop {
        let workspace = match global_manager() {
            Ok(manager) => manager.workspace(profile_id).await.ok(),
            Err(_) => None,
        };
        if let Some(workspace) = workspace {
            remaining = remove_now(&workspace, &remaining).await;
            if remaining.is_empty() {
                return;
            }
        }
        tokio::time::sleep(CLEANUP_RETRY_INTERVAL).await;
    }
}

/// 判断当前失败是否无法可靠使用现有 SSH 连接立即清理。
pub(crate) fn should_defer(result: &Result<(), TransferRunError>) -> bool {
    matches!(result, Err(TransferRunError::Canceled))
        || matches!(
            result,
            Err(TransferRunError::Failed(failure))
                if failure.code == TransferErrorCode::ConnectionLost
        )
}

fn cleanup_batches(paths: &[String]) -> Vec<Vec<&String>> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut command_bytes = "rm -rf --".len();
    for path in paths {
        let argument_bytes = 1 + shell_quote(path).len();
        if !batch.is_empty() && command_bytes + argument_bytes > MAX_CLEANUP_COMMAND_BYTES {
            batches.push(std::mem::take(&mut batch));
            command_bytes = "rm -rf --".len();
        }
        command_bytes += argument_bytes;
        batch.push(path);
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

fn cleanup_command(paths: &[&String]) -> String {
    let mut command = String::from("rm -rf --");
    for path in paths {
        command.push(' ');
        command.push_str(&shell_quote(path));
    }
    command
}

/// 只认可任务 UUID 派生的 staging、相邻归档目录和 mktemp 归档目录。
fn is_owned_cleanup_path(path: &str, workspace_home: &str) -> bool {
    if !path.starts_with('/')
        || path == "/"
        || path.contains(['\0', '\r', '\n'])
        || path[1..].split('/').any(str::is_empty)
        || path
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or_default();
    if let Some(value) = name.strip_prefix(".terax-archive-") {
        return remote_path_within(path, workspace_home) && uuid::Uuid::parse_str(value).is_ok();
    }
    if let Some(value) = name.strip_prefix("terax-archive.") {
        return path.strip_suffix(name) == Some("/tmp/")
            && value.len() == 8
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric());
    }
    let Some(value) = name.strip_prefix(".terax-part-") else {
        return false;
    };
    let Some((task_id, index)) = value.rsplit_once('-') else {
        return false;
    };
    remote_path_within(path, workspace_home)
        && uuid::Uuid::parse_str(task_id).is_ok()
        && !index.is_empty()
        && index.bytes().all(|byte| byte.is_ascii_digit())
}

fn remote_path_within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_accepts_only_task_owned_remote_paths() {
        let task = uuid::Uuid::new_v4();
        let home = "/home/user";
        assert!(is_owned_cleanup_path(
            &format!("/home/user/.terax-part-{task}-3"),
            home
        ));
        assert!(is_owned_cleanup_path(
            &format!("/home/user/.terax-archive-{task}"),
            home
        ));
        assert!(is_owned_cleanup_path("/tmp/terax-archive.a1B2c3D4", home));
        assert!(!is_owned_cleanup_path("/", home));
        assert!(!is_owned_cleanup_path("/home/user/project", home));
        assert!(!is_owned_cleanup_path(
            "/home/user/.terax-part-not-a-uuid-0",
            home
        ));
        assert!(!is_owned_cleanup_path(
            &format!("/etc/.terax-part-{task}-0"),
            home
        ));
        assert!(!is_owned_cleanup_path(
            "/home/user/../.terax-archive-a1B2c3D4",
            home
        ));
    }

    #[test]
    fn cleanup_commands_are_split_before_the_byte_limit() {
        let paths = vec![
            format!(
                "/home/user/{}/.terax-part-{}-0",
                "a".repeat(40_000),
                uuid::Uuid::new_v4()
            ),
            format!(
                "/home/user/{}/.terax-part-{}-1",
                "b".repeat(40_000),
                uuid::Uuid::new_v4()
            ),
        ];
        let batches = cleanup_batches(&paths);
        assert_eq!(batches.len(), 2);
        assert!(cleanup_command(&batches[0]).len() <= MAX_CLEANUP_COMMAND_BYTES);
        assert!(cleanup_command(&batches[1]).len() <= MAX_CLEANUP_COMMAND_BYTES);
    }
}
