//! 字节传输检查点；只保留连续确认前缀和任务私有路径，不接管提交恢复。

use super::errors::TransferErrorCode;
use super::manager::TransferRunError;
use super::ssh::cleanup::RemoteCleanupScope;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) const CHECKPOINT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct ResumeState {
    pub(crate) manifest: String,
    pub(crate) local_paths: Vec<PathBuf>,
    pub(crate) remote_scope: Option<RemoteCleanupScope>,
    pub(crate) remote_paths: Vec<String>,
    pub(crate) archive: Option<ArchiveCheckpoint>,
    pub(crate) files: HashMap<String, u64>,
    pub(crate) discarded: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ArchiveCheckpoint {
    pub(crate) local: PathBuf,
    pub(crate) remote: String,
    pub(crate) work_dir: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) file_count: u64,
}

impl ResumeState {
    pub(crate) fn upload(plan: &super::planner::RemoteUploadPlan) -> Self {
        let mut entries = vec![format!(
            "upload:{}:{}:{}:{}",
            plan.workspace.profile.id,
            plan.workspace.profile.host,
            plan.workspace.profile.port,
            plan.workspace.profile.username
        )];
        entries.extend(
            plan.roots
                .iter()
                .map(|root| format!("root:{}:{}", root.source_path, root.final_path)),
        );
        entries.extend(plan.files.iter().map(|file| {
            format!(
                "file:{:?}:{}:{}:{:?}:{:?}",
                file.source,
                file.destination,
                file.size,
                file.metadata.modified(),
                file.source_identity
            )
        }));
        entries.extend(plan.directories.iter().map(|dir| {
            format!(
                "dir:{:?}:{}:{:?}",
                dir.source,
                dir.destination,
                dir.metadata.modified()
            )
        }));
        Self {
            manifest: fingerprint(entries),
            remote_scope: Some(RemoteCleanupScope::for_upload(
                &plan.workspace,
                plan.task_id.clone(),
                plan.owner_task_id.clone(),
                plan.roots.iter().map(|root| root.final_path.as_str()),
            )),
            remote_paths: plan.roots.iter().map(|root| root.stage.clone()).collect(),
            ..Self::default()
        }
    }

    pub(crate) fn download(plan: &super::planner::RemoteDownloadPlan) -> Self {
        let mut entries = vec![format!(
            "download:{}:{}:{}:{}",
            plan.workspace.profile.id,
            plan.workspace.profile.host,
            plan.workspace.profile.port,
            plan.workspace.profile.username
        )];
        entries.extend(
            plan.roots
                .iter()
                .map(|root| format!("root:{}:{:?}", root.source_path, root.final_path)),
        );
        entries.extend(plan.files.iter().map(|file| {
            format!(
                "file:{}:{:?}:{}:{:?}",
                file.source,
                file.destination,
                file.size,
                file.metadata.modified()
            )
        }));
        entries.extend(plan.directories.iter().map(|dir| {
            format!(
                "dir:{}:{:?}:{:?}",
                dir.source,
                dir.destination,
                dir.metadata.modified()
            )
        }));
        Self {
            manifest: fingerprint(entries),
            local_paths: plan.roots.iter().map(|root| root.stage.clone()).collect(),
            remote_scope: Some(RemoteCleanupScope::for_download(
                &plan.workspace,
                plan.task_id.clone(),
                plan.owner_task_id.clone(),
            )),
            ..Self::default()
        }
    }
}

/// 计划顺序不影响身份；条目以长度分隔，避免路径拼接歧义。
pub(crate) fn fingerprint(mut entries: Vec<String>) -> String {
    entries.sort();
    let mut digest = Sha256::new();
    for entry in entries {
        digest.update((entry.len() as u64).to_le_bytes());
        digest.update(entry.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

pub(crate) fn recoverable(error: &TransferRunError) -> bool {
    matches!(error, TransferRunError::Failed(failure) if matches!(failure.code,
        TransferErrorCode::RequestTimeout | TransferErrorCode::ConnectionLost |
        TransferErrorCode::SessionBusy | TransferErrorCode::StorageFull))
}

pub(crate) fn changed() -> TransferRunError {
    TransferRunError::failed(
        TransferErrorCode::SourceChanged,
        "transfer source or destination changed; restart instead of resuming",
    )
}

/// 只跟踪当前并发窗口的乱序完成项，确认位置不跨过缺失的数据块。
pub(crate) struct ConfirmedPrefix {
    offset: u64,
    pending: std::collections::BTreeMap<u64, u64>,
}
impl ConfirmedPrefix {
    pub(crate) fn new(offset: u64) -> Self {
        Self {
            offset,
            pending: Default::default(),
        }
    }
    pub(crate) fn pending(&self) -> usize {
        self.pending.len()
    }
    pub(crate) fn complete(&mut self, offset: u64, length: u64) -> u64 {
        self.pending.insert(offset, length);
        while let Some(length) = self.pending.remove(&self.offset) {
            self.offset += length;
        }
        self.offset
    }
}

/// 文件长度可能含乱序写入的空洞，恢复位置只能取已持久化的连续确认前缀。
pub(crate) fn validated_offset(
    saved: u64,
    actual: u64,
    expected: u64,
) -> Result<u64, TransferRunError> {
    if saved > actual || saved > expected {
        return Err(changed());
    }
    Ok(saved)
}

pub(crate) fn owns_local(path: &Path, task: &str) -> bool {
    uuid::Uuid::parse_str(task).is_ok()
        && path.is_absolute()
        && !path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(&format!(".terax-part-{task}-")))
            .is_some_and(|index| !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit()))
}

/// 删除前只接受检查点明确登记的任务私有根；失败保留 Journal 供再次清理。
pub(crate) async fn cleanup(task: &str, state: &ResumeState) -> bool {
    if state.local_paths.iter().any(|path| !owns_local(path, task)) {
        return false;
    }
    let mut complete = super::commit::remove_local_paths(state.local_paths.clone())
        .await
        .is_empty();
    if !state.remote_paths.is_empty() {
        let Some(scope) = &state.remote_scope else {
            return false;
        };
        let workspace = match crate::modules::remote::manager::global_manager() {
            Ok(manager) => manager.workspace(scope.profile_id()).await.ok(),
            Err(_) => None,
        };
        let Some(workspace) = workspace else {
            return false;
        };
        if !scope.matches_workspace(&workspace) {
            return false;
        }
        // 历史操作不能被不可达服务器的长清理阻塞，超时仍保留原 Journal。
        complete &= tokio::time::timeout(
            std::time::Duration::from_secs(3),
            super::ssh::cleanup::remove_now(&workspace, scope, &state.remote_paths),
        )
        .await
        .is_ok_and(|remaining| remaining.is_empty());
    }
    complete
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn out_of_order_completion_never_checkpoints_a_hole() {
        let mut prefix = ConfirmedPrefix::new(32);
        assert_eq!(prefix.complete(96, 32), 32);
        assert_eq!(prefix.complete(64, 32), 32);
        assert_eq!(prefix.pending(), 2);
        assert_eq!(prefix.complete(32, 32), 128);
        assert_eq!(prefix.pending(), 0);
    }

    #[test]
    fn resume_uses_confirmed_prefix_not_sparse_file_length() {
        assert_eq!(validated_offset(32, 128, 256).unwrap(), 32);
        assert!(validated_offset(32, 16, 256).is_err());
        assert!(validated_offset(32, 128, 16).is_err());
        assert_ne!(
            fingerprint(vec!["ab".into(), "c".into()]),
            fingerprint(vec!["a".into(), "bc".into()])
        );
    }
    #[test]
    fn cleanup_never_accepts_a_final_target_or_another_tasks_path() {
        let task = uuid::Uuid::new_v4().to_string();
        let root = std::env::temp_dir();
        assert!(owns_local(
            &root.join(format!(".terax-part-{task}-0")),
            &task
        ));
        assert!(!owns_local(&root.join("model.bin"), &task));
        assert!(!owns_local(
            &root.join(format!(".terax-part-{task}-0.backup")),
            &task
        ));
        assert!(!owns_local(
            &root.join(format!(".terax-part-{task}-0")),
            &uuid::Uuid::new_v4().to_string()
        ));
    }
}
