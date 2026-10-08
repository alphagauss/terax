//! 文件传输 Tauri command 薄适配层。
//!
//! 命令从不可变的 Workspace 启动上下文取得 WSL 或 SSH 环境，前端不能通过
//! 参数将任务切换到其他 profile。

use tauri::{AppHandle, State};

use crate::modules::workspace_process::WorkspaceProcessState;

use super::errors::TransferFailure;
use super::models::{EnqueueTransferRequest, ResolveTransferConflictRequest, TransferTaskSnapshot};
use super::TransferState;

/// 读取当前 Workspace 中这个环境目录最近成功同步的设置。
#[tauri::command]
pub async fn transfer_sync_settings(
    app: AppHandle,
    state: State<'_, TransferState>,
    remote_path: String,
) -> Result<Option<super::sync_settings::FolderSyncSettings>, String> {
    state.manager().sync_settings(app, remote_path).await
}

/// 只读比较目录内容；实际入队后重新比较，不复用过期覆盖决定。
#[tauri::command]
pub async fn transfer_sync_preview(
    workspace: State<'_, WorkspaceProcessState>,
    request: EnqueueTransferRequest,
) -> Result<super::sync::SyncPreview, TransferFailure> {
    super::sync::preview(&workspace.bootstrap().env, request).await
}

/// 将文件、文件夹或批量来源按请求中的策略加入后台队列。
#[tauri::command]
pub async fn transfer_enqueue(
    app: AppHandle,
    state: State<'_, TransferState>,
    workspace: State<'_, WorkspaceProcessState>,
    request: EnqueueTransferRequest,
) -> Result<TransferTaskSnapshot, TransferFailure> {
    state
        .manager()
        .enqueue(
            app,
            workspace.bootstrap().env.clone(),
            workspace.bootstrap().id.clone(),
            request,
        )
        .await
}

/// 提交当前待处理冲突的一次性决策。
#[tauri::command]
pub async fn transfer_resolve_conflict(
    state: State<'_, TransferState>,
    request: ResolveTransferConflictRequest,
) -> Result<(), TransferFailure> {
    state.manager().resolve_conflict(request).await
}

/// 忽略一个 Direct 文件失败，使其不再出现在默认失败列表中。
#[tauri::command]
pub async fn transfer_ignore_failure(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
    failure_id: String,
) -> Result<(), TransferFailure> {
    state.manager().ignore_failure(&app, &id, &failure_id).await
}

/// 在原聚合任务中重新执行一个 Direct 文件失败。
#[tauri::command]
pub async fn transfer_retry_failure(
    app: AppHandle,
    state: State<'_, TransferState>,
    workspace: State<'_, WorkspaceProcessState>,
    id: String,
    failure_id: String,
) -> Result<(), TransferFailure> {
    state
        .manager()
        .retry_failure(app, workspace.bootstrap().env.clone(), &id, &failure_id)
        .await
}

/// 返回当前进程持有的全部传输任务。
#[tauri::command]
pub async fn transfer_list(
    state: State<'_, TransferState>,
    workspace: State<'_, WorkspaceProcessState>,
) -> Result<Vec<TransferTaskSnapshot>, TransferFailure> {
    state
        .manager()
        .list(&workspace.bootstrap().env, &workspace.bootstrap().id)
        .await
}

/// 暂停后台传输任务。
#[tauri::command]
pub async fn transfer_pause(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), TransferFailure> {
    state.manager().pause(&app, &id).await
}

/// 恢复后台传输任务。
#[tauri::command]
pub async fn transfer_resume(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), TransferFailure> {
    state.manager().resume(&app, &id).await
}

/// 取消任务并清理仍在 staging 中的目标。
#[tauri::command]
pub async fn transfer_cancel(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), TransferFailure> {
    state.manager().cancel(&app, &id).await
}

/// 移除一个已经结束的任务记录。
#[tauri::command]
pub async fn transfer_remove(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), TransferFailure> {
    state.manager().remove(&app, &id).await
}

/// 清理成功及完成但含文件失败的任务，不影响任务级失败、取消或运行中任务。
#[tauri::command]
pub async fn transfer_clear_completed(
    app: AppHandle,
    state: State<'_, TransferState>,
) -> Result<Vec<String>, String> {
    Ok(state.manager().clear_completed(&app).await)
}

/// 清理全部终态传输任务记录，不影响仍在运行的任务。
#[tauri::command]
pub async fn transfer_clear_all(
    app: AppHandle,
    state: State<'_, TransferState>,
) -> Result<Vec<String>, String> {
    Ok(state.manager().clear_all(&app).await)
}

/// 使用失败或取消任务的原始参数创建一个新的后台任务。
#[tauri::command]
pub async fn transfer_retry(
    app: AppHandle,
    state: State<'_, TransferState>,
    workspace: State<'_, WorkspaceProcessState>,
    id: String,
) -> Result<TransferTaskSnapshot, TransferFailure> {
    state
        .manager()
        .retry(
            app,
            workspace.bootstrap().env.clone(),
            workspace.bootstrap().id.clone(),
            &id,
        )
        .await
}
