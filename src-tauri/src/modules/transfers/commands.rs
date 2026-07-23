//! 文件传输 Tauri command 薄适配层。
//!
//! 命令从不可变的 Workspace 启动上下文取得 WSL 或 SSH 环境，前端不能通过
//! 参数将任务切换到其他 profile。

use tauri::{AppHandle, State};

use crate::modules::workspace_process::WorkspaceProcessState;

use super::models::{EnqueueTransferRequest, TransferStrategy, TransferTaskSnapshot};
use super::TransferState;

/// 将文件、文件夹或批量来源作为 Direct 任务加入后台队列。
#[tauri::command]
pub async fn transfer_enqueue_direct(
    app: AppHandle,
    state: State<'_, TransferState>,
    workspace: State<'_, WorkspaceProcessState>,
    request: EnqueueTransferRequest,
) -> Result<TransferTaskSnapshot, String> {
    state
        .manager()
        .enqueue(
            app,
            workspace.bootstrap().env.clone(),
            request,
            TransferStrategy::Direct,
        )
        .await
}

/// 将 SSH 文件、文件夹或批量来源作为 Archive 任务加入后台队列。
#[tauri::command]
pub async fn transfer_enqueue_archive(
    app: AppHandle,
    state: State<'_, TransferState>,
    workspace: State<'_, WorkspaceProcessState>,
    request: EnqueueTransferRequest,
) -> Result<TransferTaskSnapshot, String> {
    state
        .manager()
        .enqueue(
            app,
            workspace.bootstrap().env.clone(),
            request,
            TransferStrategy::Archive,
        )
        .await
}

/// 返回当前进程持有的全部传输任务。
#[tauri::command]
pub async fn transfer_list(
    state: State<'_, TransferState>,
) -> Result<Vec<TransferTaskSnapshot>, String> {
    Ok(state.manager().list().await)
}

/// 暂停后台传输任务。
#[tauri::command]
pub async fn transfer_pause(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), String> {
    state.manager().pause(&app, &id).await
}

/// 恢复后台传输任务。
#[tauri::command]
pub async fn transfer_resume(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), String> {
    state.manager().resume(&app, &id).await
}

/// 取消任务并清理仍在 staging 中的目标。
#[tauri::command]
pub async fn transfer_cancel(
    app: AppHandle,
    state: State<'_, TransferState>,
    id: String,
) -> Result<(), String> {
    state.manager().cancel(&app, &id).await
}

/// 移除一个已经结束的任务记录。
#[tauri::command]
pub async fn transfer_remove(state: State<'_, TransferState>, id: String) -> Result<(), String> {
    state.manager().remove(&id).await
}
