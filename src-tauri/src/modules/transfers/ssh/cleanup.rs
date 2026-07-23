//! SSH 连接恢复后的延迟 staging 清理。
//!
//! 传输连接中断时，原会话无法立即删除任务私有路径。本模块在当前 Workspace 进程
//! 内等待同一 profile 重连，随后使用新的独占 SFTP 会话重试清理。

use std::time::Duration;

use crate::modules::remote::manager::global_manager;

const CLEANUP_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);

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
            cleanup_after_reconnect(&profile_id, &mut paths),
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

/// 循环等待 Workspace 重连，每次都通过新会话重试尚未删除的路径。
async fn cleanup_after_reconnect(profile_id: &str, paths: &mut Vec<String>) {
    loop {
        let workspace = match global_manager() {
            Ok(manager) => manager.workspace(profile_id).await.ok(),
            Err(_) => None,
        };
        if let Some(workspace) = workspace {
            if let Ok(session) = super::session::open(&workspace).await {
                let mut remaining = Vec::new();
                for path in paths.iter() {
                    if !super::super::commit::cleanup_remote_owned_path(&session, path).await {
                        remaining.push(path.clone());
                    }
                }
                let _ = tokio::time::timeout(Duration::from_secs(1), session.close()).await;
                if remaining.is_empty() {
                    return;
                }
                *paths = remaining;
            }
        }
        tokio::time::sleep(CLEANUP_RETRY_INTERVAL).await;
    }
}
