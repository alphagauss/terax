//! 当前 SSH epoch 的远端文件系统资源与请求合并。
//!
//! 普通文件与目录元数据使用独立 SFTP session；同一路径的可见与隐藏目录请求共享
//! 一次完整列表，再在调用边界过滤。领头请求不依赖单个前端调用的生命周期。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::{oneshot, Mutex, Notify};

use super::session::RemoteWorkspace;
use super::sftp::{self, RemoteDirEntry};

type DirectoryResult = Result<Vec<RemoteDirEntry>, String>;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct DirectoryKey {
    path: String,
}

/// 一个 transport epoch 内共享的普通文件、目录元数据 session 与请求协调器。
#[derive(Default)]
pub struct RemoteFs {
    pub(crate) session: Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    pub(crate) directory_session: Mutex<Option<Arc<russh_sftp::client::RawSftpSession>>>,
    directory_reads: Mutex<HashMap<DirectoryKey, Vec<oneshot::Sender<DirectoryResult>>>>,
    first_directory_ready: AtomicBool,
    first_directory_notify: Notify,
}

impl RemoteFs {
    /// 读取目录并合并相同的并发请求。
    pub async fn read_dir(
        &self,
        workspace: Arc<RemoteWorkspace>,
        path: String,
        show_hidden: bool,
    ) -> DirectoryResult {
        let started_at = Instant::now();
        let profile_id = workspace.profile.id.clone();
        let key = DirectoryKey { path };
        let (receiver, leader) = self.subscribe(key.clone()).await;
        if leader {
            tauri::async_runtime::spawn(async move {
                let result = sftp::read_dir_uncached(&workspace, &key.path).await;
                workspace.remote_fs.complete(key, result).await;
            });
        }
        let result = receiver
            .await
            .map_err(|_| "remote directory request was cancelled".to_string())?;
        let first_directory = self.settle_first_directory();
        let mut entries = result?;
        if !show_hidden {
            entries.retain(|entry| !entry.name.starts_with('.'));
        }
        if first_directory {
            log::info!(
                "SSH first directory ready profile={} elapsed_ms={}",
                profile_id,
                started_at.elapsed().as_millis()
            );
        }
        Ok(entries)
    }

    /// 等待首个前台目录返回；失败或慢服务端不会无限阻塞后台资源。
    pub async fn wait_for_first_directory(&self) {
        if self.first_directory_ready.load(Ordering::Acquire) {
            return;
        }
        let notified = self.first_directory_notify.notified();
        if self.first_directory_ready.load(Ordering::Acquire) {
            return;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), notified).await;
    }

    fn settle_first_directory(&self) -> bool {
        let first = !self.first_directory_ready.swap(true, Ordering::AcqRel);
        if first {
            self.first_directory_notify.notify_waiters();
        }
        first
    }

    async fn subscribe(&self, key: DirectoryKey) -> (oneshot::Receiver<DirectoryResult>, bool) {
        let (sender, receiver) = oneshot::channel();
        let mut reads = self.directory_reads.lock().await;
        let leader = !reads.contains_key(&key);
        reads.entry(key).or_default().push(sender);
        (receiver, leader)
    }

    async fn complete(&self, key: DirectoryKey, result: DirectoryResult) {
        let waiters = self.directory_reads.lock().await.remove(&key);
        for waiter in waiters.into_iter().flatten() {
            let _ = waiter.send(result.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn identical_directory_reads_share_one_leader() {
        let fs = RemoteFs::default();
        let key = DirectoryKey {
            path: "/workspace".to_string(),
        };
        let (first, first_leader) = fs.subscribe(key.clone()).await;
        let (second, second_leader) = fs.subscribe(key.clone()).await;

        assert!(first_leader);
        assert!(!second_leader);
        fs.complete(key, Ok(Vec::new())).await;
        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn visibility_options_share_the_same_network_request() {
        let fs = RemoteFs::default();
        let key = DirectoryKey {
            path: "/workspace".to_string(),
        };
        let (_, visible_leader) = fs.subscribe(key.clone()).await;
        let (_, hidden_leader) = fs.subscribe(key).await;

        assert!(visible_leader);
        assert!(!hidden_leader);
    }

    #[tokio::test]
    async fn failed_first_directory_releases_background_waiters() {
        let fs = Arc::new(RemoteFs::default());
        let key = DirectoryKey {
            path: "/workspace".to_string(),
        };
        let (receiver, leader) = fs.subscribe(key.clone()).await;
        assert!(leader);
        let waiter = tokio::spawn({
            let fs = fs.clone();
            async move { fs.wait_for_first_directory().await }
        });

        fs.complete(key, Err("unavailable".to_string())).await;
        let result = receiver.await.unwrap();
        fs.settle_first_directory();
        assert!(result.is_err());
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .unwrap()
            .unwrap();
    }
}
