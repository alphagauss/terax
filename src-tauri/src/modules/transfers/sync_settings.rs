//! 按环境目录保存最近成功同步的表单设置。
//!
//! 复用当前 Workspace 的 Tauri Store 实例，不依赖对话框生命周期，也不随任务历史清理。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use super::models::{
    normalize_sync_root, EnqueueTransferRequest, FolderSyncOptions, TransferDirection,
    TransferStatus,
};
use crate::modules::workspace_process::WorkspaceProcessState;

/// 不包含未添加输入和预览状态的同步设置。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncSettings {
    pub local_path: String,
    pub direction: TransferDirection,
    #[serde(flatten)]
    pub options: FolderSyncOptions,
}

fn settings_key(remote_path: &str) -> Result<String, String> {
    normalize_sync_root(remote_path)
        .map(|path| format!("folderSync:{path}"))
        .map_err(|error| error.detail)
}

/// 从任务提交的请求提取配置；非同步和非完整成功终态均不覆盖记录。
fn completed_settings(
    request: &EnqueueTransferRequest,
    status: TransferStatus,
) -> Option<(&str, FolderSyncSettings)> {
    if status != TransferStatus::Completed {
        return None;
    }
    let options = request.sync.as_ref()?;
    let (local_path, remote_path) = match request.direction {
        TransferDirection::Upload => (&request.sources[0], &request.destination),
        TransferDirection::Download => (&request.destination, &request.sources[0]),
    };
    Some((
        remote_path,
        FolderSyncSettings {
            local_path: local_path.clone(),
            direction: request.direction,
            options: options.clone(),
        },
    ))
}

/// 与前端共用 Store 实例，读取 Rust 成功完成后更新的最新设置。
pub(crate) fn read(
    app: &AppHandle,
    remote_path: &str,
) -> Result<Option<FolderSyncSettings>, String> {
    let key = settings_key(remote_path)?;
    let workspace = app.state::<WorkspaceProcessState>();
    let store = app
        .store(&workspace.bootstrap().state_path)
        .map_err(|error| error.to_string())?;
    store
        .get(key)
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| error.to_string())
}

/// 成功后只修改当前目录的键并立即保存；失败恢复旧设置，不改变传输结果。
pub(crate) fn save(
    app: &AppHandle,
    request: &EnqueueTransferRequest,
    status: TransferStatus,
) -> Result<(), String> {
    let Some((remote_path, settings)) = completed_settings(request, status) else {
        return Ok(());
    };
    let key = settings_key(remote_path)?;
    let value = serde_json::to_value(settings).map_err(|error| error.to_string())?;
    let workspace = app.state::<WorkspaceProcessState>();
    let store = app
        .store(&workspace.bootstrap().state_path)
        .map_err(|error| error.to_string())?;
    let previous = store.get(&key);
    store.set(key.clone(), value);
    if let Err(error) = store.save() {
        match previous {
            Some(value) => store.set(key, value),
            None => {
                store.delete(key);
            }
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::models::TransferStrategy;
    use super::*;

    fn request(direction: TransferDirection) -> EnqueueTransferRequest {
        let (source, destination) = match direction {
            TransferDirection::Upload => ("C:/project", "/srv/project/./"),
            TransferDirection::Download => ("/srv/project/./", "C:/project"),
        };
        EnqueueTransferRequest {
            sync: Some(FolderSyncOptions {
                exclude_git: false,
                excludes: vec![".git".into(), ".cache".into()],
                exclude_directories: vec!["target".into()],
                respect_gitignore: true,
            }),
            direction,
            strategy: TransferStrategy::Archive,
            sources: vec![source.into()],
            destination: destination.into(),
            destination_name: None,
        }
        .normalize()
        .unwrap()
    }

    #[test]
    fn successful_settings_preserve_both_directions_and_custom_git_name() {
        for direction in [TransferDirection::Upload, TransferDirection::Download] {
            let request = request(direction);
            let (remote, settings) =
                completed_settings(&request, TransferStatus::Completed).unwrap();
            assert_eq!(remote, "/srv/project");
            assert_eq!(settings.local_path, "C:/project");
            assert_eq!(settings.direction, direction);
            let value = serde_json::to_value(&settings).unwrap();
            assert_eq!(value["excludeGit"], false);
            assert_eq!(value["excludes"], serde_json::json!([".git", ".cache"]));
            assert_eq!(value["excludeDirectories"], serde_json::json!(["target"]));
            assert_eq!(value["respectGitignore"], true);
            let restored: FolderSyncSettings = serde_json::from_value(value).unwrap();
            assert_eq!(restored.local_path, settings.local_path);
            assert!(!restored.options.exclude_git);
        }
    }

    #[test]
    fn only_fully_completed_syncs_replace_settings() {
        let mut request = request(TransferDirection::Upload);
        for status in [
            TransferStatus::Queued,
            TransferStatus::Running,
            TransferStatus::Paused,
            TransferStatus::AwaitingDecision,
            TransferStatus::Canceling,
            TransferStatus::Canceled,
            TransferStatus::Failed,
            TransferStatus::CompletedWithErrors,
        ] {
            assert!(completed_settings(&request, status).is_none());
        }
        assert!(completed_settings(&request, TransferStatus::Completed).is_some());
        request.sync = None;
        assert!(completed_settings(&request, TransferStatus::Completed).is_none());
    }

    #[test]
    fn record_keys_share_task_path_normalization_without_merging_distinct_paths() {
        assert_eq!(
            settings_key("/srv//project/./").unwrap(),
            settings_key("/srv/project").unwrap()
        );
        assert_ne!(
            settings_key("/srv/project").unwrap(),
            settings_key("/srv/Project").unwrap()
        );
        assert_ne!(
            settings_key("/srv/project").unwrap(),
            settings_key("/srv/project/sub").unwrap()
        );
        for path in ["/", "relative", "/srv/../project", "/srv/\nproject"] {
            assert!(settings_key(path).is_err());
        }
    }
}
