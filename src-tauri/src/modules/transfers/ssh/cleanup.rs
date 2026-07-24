//! SSH 连接恢复后的延迟 staging 清理。
//!
//! 传输连接中断时，原会话无法立即删除任务私有路径。本模块在当前 Workspace 进程
//! 内等待同一 profile 重连，随后用一个受限的服务器本地命令清理任务私有路径。

use std::sync::Arc;
use std::time::Duration;

use crate::modules::remote::manager::global_manager;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const CLEANUP_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);
const CLEANUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);

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

/// 用一个服务器本地命令删除经过验证的任务私有路径。
///
/// 此入口只接受 Terax 生成的固定命名，拒绝任意用户路径。`rm -rf` 在远端本地递归，
/// 不会把目录中文件数量放大为逐项 SFTP 往返。
pub(crate) async fn remove_now(workspace: &Arc<RemoteWorkspace>, paths: &[String]) -> bool {
    if paths.is_empty() {
        return true;
    }
    let home = workspace.home().await;
    if let Some(path) = paths
        .iter()
        .find(|path| !is_owned_cleanup_path(path, &home))
    {
        log::warn!("refused to clean invalid remote transfer path: {path}");
        return false;
    }
    let mut command = String::from("rm -rf --");
    for path in paths {
        command.push(' ');
        command.push_str(&shell_quote(path));
    }
    match workspace
        .exec(&command, None, CLEANUP_COMMAND_TIMEOUT)
        .await
    {
        Ok(output) if output.exit_code == Some(0) && !output.timed_out && !output.truncated => true,
        Ok(output) => {
            log::warn!(
                "remote transfer cleanup command failed with exit {:?}: {}",
                output.exit_code,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            false
        }
        Err(error) => {
            log::warn!("failed to start remote transfer cleanup: {error}");
            false
        }
    }
}

/// 循环等待 Workspace 重连，并用服务器本地递归删除重试尚未清理的路径。
async fn cleanup_after_reconnect(profile_id: &str, paths: &[String]) {
    loop {
        let workspace = match global_manager() {
            Ok(manager) => manager.workspace(profile_id).await.ok(),
            Err(_) => None,
        };
        if let Some(workspace) = workspace {
            if remove_now(&workspace, paths).await {
                return;
            }
        }
        tokio::time::sleep(CLEANUP_RETRY_INTERVAL).await;
    }
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
}
