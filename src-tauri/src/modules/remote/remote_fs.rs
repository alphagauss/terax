//! 当前 SSH epoch 的远端文件系统资源与请求合并。
//!
//! 缓存 SFTP session，并将同一路径、同一可见性选项的并发目录读取合并为一次网络操作。
//! 领头请求在独立任务中完成，单个前端调用被取消不会遗留永不收敛的等待者。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{oneshot, Mutex};

use super::session::RemoteWorkspace;
use super::sftp::{self, RemoteDirEntry};

type DirectoryResult = Result<Vec<RemoteDirEntry>, String>;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct DirectoryKey {
    path: String,
    show_hidden: bool,
}

/// 一个 transport epoch 内共享的 SFTP session 与目录读取协调器。
#[derive(Default)]
pub struct RemoteFs {
    pub(crate) session: Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    directory_reads: Mutex<HashMap<DirectoryKey, Vec<oneshot::Sender<DirectoryResult>>>>,
}

impl RemoteFs {
    /// 读取目录并合并相同的并发请求。
    pub async fn read_dir(
        &self,
        workspace: Arc<RemoteWorkspace>,
        path: String,
        show_hidden: bool,
    ) -> DirectoryResult {
        let key = DirectoryKey { path, show_hidden };
        let (receiver, leader) = self.subscribe(key.clone()).await;
        if leader {
            tauri::async_runtime::spawn(async move {
                let result = sftp::read_dir_uncached(&workspace, &key.path, key.show_hidden).await;
                workspace.remote_fs.complete(key, result).await;
            });
        }
        receiver
            .await
            .map_err(|_| "remote directory request was cancelled".to_string())?
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
            show_hidden: false,
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
    async fn visibility_options_do_not_share_directory_requests() {
        let fs = RemoteFs::default();
        let (_, visible_leader) = fs
            .subscribe(DirectoryKey {
                path: "/workspace".to_string(),
                show_hidden: false,
            })
            .await;
        let (_, hidden_leader) = fs
            .subscribe(DirectoryKey {
                path: "/workspace".to_string(),
                show_hidden: true,
            })
            .await;

        assert!(visible_leader);
        assert!(hidden_leader);
    }
}
