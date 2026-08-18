//! 后台文件传输队列与任务生命周期管理。
//!
//! 管理器持有有界任务历史、原始请求、控制信号与延迟清理所有权，并把等待执行、
//! 目标 reservation、重试和终态收敛串成统一生命周期。扫描与复制由低依赖模块负责。

use std::cmp::Reverse;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::modules::workspace::WorkspaceEnv;

use super::cleanup_ticket::{CleanupTicket, CleanupTicketState, CleanupTicketTarget};
use super::errors::{TransferErrorCode, TransferFailure};
use super::models::{
    EnqueueTransferRequest, ResolveTransferConflictRequest, TransferConflict,
    TransferConflictDecision, TransferDirection, TransferFileFailure, TransferStage,
    TransferStatus, TransferStrategy, TransferTaskSnapshot,
};
use super::planner;
use super::progress::ExecutionContext;
use super::scheduler::TransferScheduler;
use super::{archive, conflicts, direct, journal};

const MAX_CONCURRENT_TASKS: usize = 2;
const MAX_ACTIVE_TASKS: usize = 64;
const MAX_HISTORY_TASKS: usize = 100;
const TRANSFER_EVENT: &str = "terax://transfer-updated";
const TRANSFER_REMOVED_EVENT: &str = "terax://transfer-removed";

static PENDING_CLEANUPS: LazyLock<StdMutex<HashMap<String, usize>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// 登记一个尚未确认完成的任务私有临时路径清理。
pub(crate) fn begin_deferred_cleanup(task_id: &str) {
    let mut pending = PENDING_CLEANUPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let count = pending.entry(task_id.to_string()).or_default();
    *count = count.saturating_add(1);
}

/// 完成一个延迟清理所有权；同一任务的其他清理完成前仍禁止删除历史。
pub(crate) fn finish_deferred_cleanup(task_id: &str) {
    let mut pending = PENDING_CLEANUPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(count) = pending.get_mut(task_id) else {
        return;
    };
    if *count <= 1 {
        pending.remove(task_id);
    } else {
        *count -= 1;
    }
}

fn has_deferred_cleanup(task_id: &str) -> bool {
    PENDING_CLEANUPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(task_id)
}

#[derive(Clone, Serialize)]
struct FsChangedPayload {
    paths: Vec<String>,
}

/// Tauri 托管的文件传输状态。
pub struct TransferState {
    manager: Arc<TransferManager>,
}

impl Default for TransferState {
    fn default() -> Self {
        Self {
            manager: Arc::new(TransferManager::new(MAX_CONCURRENT_TASKS)),
        }
    }
}

impl TransferState {
    /// 返回进程内共享的任务管理器。
    pub(crate) fn manager(&self) -> Arc<TransferManager> {
        self.manager.clone()
    }
}

/// 执行器内部错误，取消与普通失败必须映射到不同终态。
#[derive(Debug)]
pub(crate) enum TransferRunError {
    Canceled,
    Failed(TransferFailure),
}

impl From<String> for TransferRunError {
    fn from(value: String) -> Self {
        Self::failed(TransferErrorCode::Internal, value)
    }
}

impl From<TransferFailure> for TransferRunError {
    fn from(value: TransferFailure) -> Self {
        Self::Failed(value)
    }
}

impl TransferRunError {
    /// 创建带稳定错误码的执行失败。
    pub(crate) fn failed(code: TransferErrorCode, detail: impl Into<String>) -> Self {
        Self::Failed(TransferFailure::new(code, detail))
    }

    /// 返回 Direct 是否可以把该错误隔离到单个目录内文件。
    pub(crate) fn is_file_scoped(&self) -> bool {
        matches!(
            self,
            Self::Failed(TransferFailure {
                code: TransferErrorCode::SourceUnavailable
                    | TransferErrorCode::SourceChanged
                    | TransferErrorCode::IntegrityCheckFailed
                    | TransferErrorCode::PermissionDenied
                    | TransferErrorCode::IoFailed,
                ..
            })
        )
    }

    /// 克隆单文件失败需要持久化和展示的结构化错误。
    pub(crate) fn failure(&self) -> Option<TransferFailure> {
        match self {
            Self::Failed(failure) => Some(failure.clone()),
            Self::Canceled => None,
        }
    }
}

/// 单任务的协作式暂停与取消信号。
pub(crate) struct TaskControl {
    paused: AtomicBool,
    pause_changed: Notify,
    cancellation: CancellationToken,
    conflict: Mutex<Option<PendingConflict>>,
}

/// 控制层唯一活动冲突及其尚未消费的决策。
struct PendingConflict {
    id: String,
    resolution: Option<ConflictResolution>,
}

/// 与一次冲突 ID 严格绑定的用户决策。
pub(crate) struct ConflictResolution {
    pub(crate) conflict_id: String,
    pub(crate) decision: TransferConflictDecision,
    pub(crate) apply_to_remaining: bool,
}

impl TaskControl {
    /// 创建未暂停且未取消的任务控制信号。
    pub(crate) fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            pause_changed: Notify::new(),
            cancellation: CancellationToken::new(),
            conflict: Mutex::new(None),
        }
    }

    /// 在每个文件块和目录项之间执行协作式暂停与取消。
    pub(crate) async fn checkpoint(&self) -> Result<(), TransferRunError> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(TransferRunError::Canceled);
            }
            if !self.paused.load(Ordering::Acquire) {
                return Ok(());
            }
            tokio::select! {
                _ = self.pause_changed.notified() => {}
                _ = self.cancellation.cancelled() => {
                    return Err(TransferRunError::Canceled);
                }
            }
        }
    }

    /// 返回任务是否正处于暂停状态。
    pub(crate) fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    /// 在阻塞归档线程中等待暂停结束，并及时观察取消信号。
    pub(crate) fn checkpoint_blocking(&self) -> Result<(), TransferRunError> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(TransferRunError::Canceled);
            }
            if !self.is_paused() {
                return Ok(());
            }
            std::thread::park_timeout(std::time::Duration::from_millis(20));
        }
    }

    /// 返回任务是否已经收到取消请求。
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    /// 异步等待取消请求，供单个远端 I/O 与取消信号竞争。
    pub(crate) async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    /// 标记任务暂停并唤醒可能正在竞争许可的执行器。
    pub(crate) fn pause(&self) {
        self.paused.store(true, Ordering::Release);
        self.pause_changed.notify_one();
    }

    /// 恢复任务并唤醒唯一执行器。
    pub(crate) fn resume(&self) {
        self.paused.store(false, Ordering::Release);
        self.pause_changed.notify_one();
    }

    /// 请求取消并唤醒暂停中的执行器。
    pub(crate) fn cancel(&self) {
        self.cancellation.cancel();
        self.pause_changed.notify_one();
    }

    /// 等待暂停状态变化或任务取消。
    pub(crate) async fn wait_for_change(&self) -> Result<(), TransferRunError> {
        tokio::select! {
            _ = self.pause_changed.notified() => Ok(()),
            _ = self.cancellation.cancelled() => Err(TransferRunError::Canceled),
        }
    }

    /// 在向前端发布快照前注册唯一活动冲突，避免极快响应被误判为过期。
    pub(crate) async fn begin_conflict(&self, conflict_id: String) -> Result<(), TransferRunError> {
        let mut pending = self.conflict.lock().await;
        if pending.is_some() {
            return Err(TransferRunError::failed(
                TransferErrorCode::Internal,
                "transfer task already has an active conflict",
            ));
        }
        *pending = Some(PendingConflict {
            id: conflict_id,
            resolution: None,
        });
        Ok(())
    }

    /// 等待指定冲突的用户决策，同时保持取消可立即生效。
    pub(crate) async fn wait_for_conflict(
        &self,
        conflict_id: &str,
    ) -> Result<ConflictResolution, TransferRunError> {
        loop {
            {
                let mut pending = self.conflict.lock().await;
                let Some(conflict) = pending.as_mut() else {
                    return Err(TransferRunError::failed(
                        TransferErrorCode::Internal,
                        "transfer conflict is no longer active",
                    ));
                };
                if conflict.id != conflict_id {
                    return Err(TransferRunError::failed(
                        TransferErrorCode::Internal,
                        "transfer conflict id changed while waiting",
                    ));
                }
                if let Some(resolution) = conflict.resolution.take() {
                    *pending = None;
                    return Ok(resolution);
                }
            }
            tokio::select! {
                _ = self.pause_changed.notified() => {}
                _ = self.cancellation.cancelled() => return Err(TransferRunError::Canceled),
            }
        }
    }

    /// 发布已经由任务快照校验过的冲突决策，重复或过期决策会被拒绝。
    pub(crate) async fn resolve_conflict(&self, resolution: ConflictResolution) -> bool {
        let mut pending = self.conflict.lock().await;
        let Some(conflict) = pending.as_mut() else {
            return false;
        };
        if conflict.id != resolution.conflict_id || conflict.resolution.is_some() {
            return false;
        }
        conflict.resolution = Some(resolution);
        drop(pending);
        self.pause_changed.notify_one();
        true
    }

    /// 清理由发布失败或取消留下的活动冲突。
    pub(crate) async fn clear_conflict(&self, conflict_id: &str) {
        let mut pending = self.conflict.lock().await;
        if pending
            .as_ref()
            .is_some_and(|conflict| conflict.id == conflict_id)
        {
            *pending = None;
        }
    }
}

/// 保存当前进程任务快照、控制句柄和全局并发许可。
pub(crate) struct TransferManager {
    tasks: RwLock<HashMap<String, ManagedTask>>,
    scheduler: TransferScheduler,
    journal_loaded: Mutex<bool>,
    enqueue_operations: Mutex<()>,
    history_operations: Mutex<()>,
}

struct ManagedTask {
    snapshot: TransferTaskSnapshot,
    request: EnqueueTransferRequest,
    journal_path: PathBuf,
    control: Option<Arc<TaskControl>>,
}

impl TransferManager {
    /// 创建具有固定并发上限的进程内任务管理器。
    fn new(concurrency: usize) -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            scheduler: TransferScheduler::new(concurrency),
            journal_loaded: Mutex::new(false),
            enqueue_operations: Mutex::new(()),
            history_operations: Mutex::new(()),
        }
    }

    /// 创建任务并立即返回快照，扫描与复制在后台异步执行。
    pub(crate) async fn enqueue(
        self: &Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        workspace_id: String,
        request: EnqueueTransferRequest,
    ) -> Result<TransferTaskSnapshot, TransferFailure> {
        let request = request.normalize()?;
        if matches!(workspace, WorkspaceEnv::Local) {
            return Err(TransferFailure::new(
                TransferErrorCode::WorkspaceUnavailable,
                "file transfer is only available in WSL or SSH workspaces",
            ));
        }
        self.ensure_journal_loaded(&workspace, &workspace_id)
            .await?;
        // 创建 Journal 与插入内存任务必须串行，否则并发越过上限后会留下无主 Journal。
        let _enqueue = self.enqueue_operations.lock().await;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let snapshot = TransferTaskSnapshot {
            id: id.clone(),
            direction: request.direction,
            strategy: request.strategy,
            status: TransferStatus::Queued,
            stage: TransferStage::Queued,
            source_count: request.sources.len() as u64,
            destination: request.destination.clone(),
            name: task_name(&request.sources),
            total_bytes: 0,
            transferred_bytes: 0,
            total_files: 0,
            completed_files: 0,
            failed_files: 0,
            unprocessed_files: 0,
            total_roots: 0,
            committed_roots: 0,
            speed_bytes_per_second: 0,
            current_file: None,
            failure: None,
            file_failures: Vec::new(),
            conflict: None,
            is_directory: false,
            created_at: now,
            updated_at: now,
        };
        {
            let tasks = self.tasks.read().await;
            ensure_active_capacity(&tasks)?;
        }
        let journal_path = journal::create(&workspace, &workspace_id, &request, &snapshot).await?;
        let control = Arc::new(TaskControl::new());
        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(
                id.clone(),
                ManagedTask {
                    snapshot: snapshot.clone(),
                    request: request.clone(),
                    journal_path,
                    control: Some(control.clone()),
                },
            );
        }
        emit_snapshot(&app, &snapshot);

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_task(app, workspace, request, id, control).await;
        });
        Ok(snapshot)
    }

    /// 返回按创建时间倒序排列的当前任务快照。
    pub(crate) async fn list(
        &self,
        workspace: &WorkspaceEnv,
        workspace_id: &str,
    ) -> Result<Vec<TransferTaskSnapshot>, TransferFailure> {
        self.ensure_journal_loaded(workspace, workspace_id).await?;
        let mut tasks: Vec<_> = self
            .tasks
            .read()
            .await
            .values()
            .map(|task| task.snapshot.clone())
            .collect();
        tasks.sort_by_key(|task| Reverse(task.created_at));
        Ok(tasks)
    }

    /// 暂停尚未结束的任务。
    pub(crate) async fn pause(&self, app: &AppHandle, id: &str) -> Result<(), TransferFailure> {
        let control = self.control(id).await?;
        control.pause();
        self.mutate_task(app, id, |task| {
            if matches!(
                task.status,
                TransferStatus::Queued | TransferStatus::Running
            ) {
                task.status = TransferStatus::Paused;
                task.speed_bytes_per_second = 0;
            }
        })
        .await?;
        Ok(())
    }

    /// 恢复一个已暂停的任务。
    pub(crate) async fn resume(&self, app: &AppHandle, id: &str) -> Result<(), TransferFailure> {
        let control = self.control(id).await?;
        control.resume();
        self.mutate_task(app, id, |task| {
            if task.status == TransferStatus::Paused {
                task.status = resumed_status(task.stage);
            }
        })
        .await?;
        Ok(())
    }

    /// 请求取消任务，执行器会在下一个安全检查点清理临时目标。
    pub(crate) async fn cancel(&self, app: &AppHandle, id: &str) -> Result<(), TransferFailure> {
        let control = self.control(id).await?;
        control.cancel();
        self.mutate_task(app, id, |task| {
            if !task.status.is_terminal() {
                task.status = TransferStatus::Canceling;
                task.speed_bytes_per_second = 0;
            }
        })
        .await?;
        Ok(())
    }

    /// 校验并提交当前任务唯一待处理冲突的决策。
    pub(crate) async fn resolve_conflict(
        &self,
        request: ResolveTransferConflictRequest,
    ) -> Result<(), TransferFailure> {
        let conflict = {
            let tasks = self.tasks.read().await;
            let task = tasks
                .get(&request.task_id)
                .ok_or_else(|| task_not_found(&request.task_id))?;
            if task.snapshot.status != TransferStatus::AwaitingDecision {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "transfer task is not waiting for a conflict decision",
                ));
            }
            task.snapshot.conflict.clone().ok_or_else(|| {
                TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "transfer task has no pending conflict",
                )
            })?
        };
        if !is_supported_conflict_resolution(&conflict, &request) {
            return Err(TransferFailure::new(
                TransferErrorCode::InvalidRequest,
                "stale or unsupported transfer conflict decision",
            ));
        }
        let accepted = self
            .control(&request.task_id)
            .await?
            .resolve_conflict(ConflictResolution {
                conflict_id: request.conflict_id,
                decision: request.decision,
                apply_to_remaining: request.apply_to_remaining,
            })
            .await;
        if accepted {
            Ok(())
        } else {
            Err(TransferFailure::new(
                TransferErrorCode::InvalidTaskState,
                "transfer conflict decision was already submitted",
            ))
        }
    }

    /// 将一个 Direct 文件失败标记为忽略，同时保留汇总失败计数。
    pub(crate) async fn ignore_failure(
        &self,
        app: &AppHandle,
        id: &str,
        failure_id: &str,
    ) -> Result<(), TransferFailure> {
        let _operation = self.history_operations.lock().await;
        {
            let tasks = self.tasks.read().await;
            let task = tasks.get(id).ok_or_else(|| task_not_found(id))?;
            if task.snapshot.status != TransferStatus::CompletedWithErrors
                || task.snapshot.strategy != TransferStrategy::Direct
            {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "only completed Direct file failures can be removed",
                ));
            }
            let failure = task
                .snapshot
                .file_failures
                .iter()
                .find(|failure| failure.id == failure_id)
                .ok_or_else(|| {
                    TransferFailure::new(
                        TransferErrorCode::InvalidRequest,
                        "transfer file failure was not found",
                    )
                })?;
            if failure.ignored {
                return Ok(());
            }
        }
        let snapshot = self
            .mutate_task(app, id, |task| {
                if let Some(failure) = task
                    .file_failures
                    .iter_mut()
                    .find(|failure| failure.id == failure_id)
                {
                    failure.ignored = true;
                }
            })
            .await?;
        if let Err(error) = self.persist_snapshot(id, &snapshot).await {
            let _ = self
                .mutate_task(app, id, |task| {
                    if let Some(failure) = task
                        .file_failures
                        .iter_mut()
                        .find(|failure| failure.id == failure_id)
                    {
                        failure.ignored = false;
                    }
                })
                .await;
            return Err(error);
        }
        Ok(())
    }

    /// 在原文件夹任务中重试一个失败文件，保持前端始终只有一条聚合记录。
    pub(crate) async fn retry_failure(
        self: &Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        id: &str,
        failure_id: &str,
    ) -> Result<(), TransferFailure> {
        let _operation = self.history_operations.lock().await;
        let _enqueue = self.enqueue_operations.lock().await;
        let (failure, direction) = {
            let tasks = self.tasks.read().await;
            let task = tasks.get(id).ok_or_else(|| task_not_found(id))?;
            if task.snapshot.status != TransferStatus::CompletedWithErrors
                || task.snapshot.strategy != TransferStrategy::Direct
            {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "only completed Direct file failures can be retried",
                ));
            }
            let failure = task
                .snapshot
                .file_failures
                .iter()
                .find(|failure| failure.id == failure_id && !failure.ignored)
                .cloned()
                .ok_or_else(|| {
                    TransferFailure::new(
                        TransferErrorCode::InvalidRequest,
                        "transfer file failure was not found",
                    )
                })?;
            ensure_active_capacity(&tasks)?;
            (failure, task.snapshot.direction)
        };
        let destination = retry_destination_parent(&workspace, &failure.destination_path)?;
        let request = EnqueueTransferRequest {
            direction,
            strategy: TransferStrategy::Direct,
            sources: vec![failure.source_path],
            destination,
        };
        let snapshot = self
            .mutate_task(&app, id, |task| {
                task.status = TransferStatus::Queued;
                task.stage = TransferStage::Queued;
                task.current_file = None;
                task.conflict = None;
                if let Some(failure) = task
                    .file_failures
                    .iter_mut()
                    .find(|failure| failure.id == failure_id)
                {
                    failure.attempts = failure.attempts.saturating_add(1);
                }
            })
            .await?;
        if let Err(error) = self.persist_snapshot(id, &snapshot).await {
            let _ = self
                .mutate_task(&app, id, |task| {
                    task.status = TransferStatus::CompletedWithErrors;
                    task.stage = TransferStage::Finished;
                    if let Some(failure) = task
                        .file_failures
                        .iter_mut()
                        .find(|failure| failure.id == failure_id)
                    {
                        failure.attempts = failure.attempts.saturating_sub(1);
                    }
                })
                .await;
            return Err(error);
        }
        let control = Arc::new(TaskControl::new());
        if let Some(task) = self.tasks.write().await.get_mut(id) {
            task.control = Some(control.clone());
        }
        let manager = self.clone();
        let task_id = id.to_string();
        let failure_id = failure_id.to_string();
        tauri::async_runtime::spawn(async move {
            manager
                .run_file_retry(app, workspace, request, task_id, failure_id, control)
                .await;
        });
        Ok(())
    }

    /// 移除单个终态任务的历史记录。
    pub(crate) async fn remove(&self, app: &AppHandle, id: &str) -> Result<(), TransferFailure> {
        let _operation = self.history_operations.lock().await;
        let journal_path = {
            let tasks = self.tasks.read().await;
            let task = tasks.get(id).ok_or_else(|| task_not_found(id))?;
            if !task.snapshot.status.is_terminal() {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "active transfer task cannot be removed",
                ));
            }
            if has_deferred_cleanup(id) {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "transfer temporary data cleanup is still pending",
                ));
            }
            task.journal_path.clone()
        };
        journal::remove(&journal_path).await?;
        let mut tasks = self.tasks.write().await;
        tasks.remove(id);
        drop(tasks);
        emit_removed(app, id);
        Ok(())
    }

    /// 清理已完成的历史任务，并返回实际删除的任务 ID。
    pub(crate) async fn clear_completed(&self, app: &AppHandle) -> Vec<String> {
        self.clear_matching(app, |status| {
            matches!(
                status,
                TransferStatus::Completed | TransferStatus::CompletedWithErrors
            )
        })
        .await
    }

    /// 清理全部终态历史任务，并返回实际删除的任务 ID。
    pub(crate) async fn clear_all(&self, app: &AppHandle) -> Vec<String> {
        self.clear_matching(app, TransferStatus::is_terminal).await
    }

    /// 串行筛选并删除历史，磁盘确认成功后再发布逐项移除事件。
    async fn clear_matching(
        &self,
        app: &AppHandle,
        matches: impl Fn(TransferStatus) -> bool,
    ) -> Vec<String> {
        let _operation = self.history_operations.lock().await;
        let candidates = {
            let tasks = self.tasks.read().await;
            history_matching_ids(&tasks, &matches)
                .into_iter()
                .filter(|id| !has_deferred_cleanup(id))
                .filter_map(|id| tasks.get(&id).map(|task| (id, task.journal_path.clone())))
                .collect::<Vec<_>>()
        };
        let mut removed = Vec::new();
        for (id, path) in candidates {
            match journal::remove(&path).await {
                Ok(()) => {
                    self.tasks.write().await.remove(&id);
                    removed.push(id);
                }
                Err(error) => {
                    log::warn!("failed to remove transfer journal {id}: {}", error.detail)
                }
            }
        }
        for id in &removed {
            emit_removed(app, id);
        }
        removed
    }

    /// 使用终态任务保留的原始请求创建一个全新的重试任务。
    pub(crate) async fn retry(
        self: &Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        workspace_id: String,
        id: &str,
    ) -> Result<TransferTaskSnapshot, TransferFailure> {
        let _operation = self.history_operations.lock().await;
        let request = {
            let tasks = self.tasks.read().await;
            let task = tasks.get(id).ok_or_else(|| task_not_found(id))?;
            let can_retry = task.snapshot.status == TransferStatus::Canceled
                || task
                    .snapshot
                    .failure
                    .as_ref()
                    .is_some_and(|failure| failure.retryable);
            if !can_retry {
                return Err(TransferFailure::new(
                    TransferErrorCode::InvalidTaskState,
                    "transfer task is not retryable",
                ));
            }
            task.request.clone()
        };
        self.enqueue(app, workspace, workspace_id, request).await
    }

    /// 等待并发许可后运行任务，并统一发布文件系统变更和终态。
    async fn run_task(
        self: Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        request: EnqueueTransferRequest,
        id: String,
        control: Arc<TaskControl>,
    ) {
        if let Err(error) = control.checkpoint().await {
            self.finish_task(&app, &id, Err(error)).await;
            return;
        }

        self.set_stage(&app, &id, TransferStage::Scanning).await;
        let mut context =
            ExecutionContext::new(self.clone(), app.clone(), id.clone(), control.clone());
        let mut result = async {
            let mut prepared =
                planner::prepare(&workspace, &request, &id, request.strategy, &mut context).await?;
            let _reservation = self.scheduler.reserve(prepared.target_keys())?;
            if conflicts::resolve(&mut prepared, request.strategy, &mut context).await? {
                prepared.publish_totals(&mut context).await?;
            }
            let _permit = self.scheduler.acquire(&control).await?;
            match request.strategy {
                TransferStrategy::Direct => direct::execute(prepared, &mut context).await,
                TransferStrategy::Archive => archive::execute(prepared, &mut context).await,
            }
        }
        .await;
        if let Err(error) = context.flush_pending().await {
            if result.is_ok() {
                result = Err(error);
            }
        }
        if should_emit_fs_changed(
            request.direction,
            result.is_ok(),
            context.has_committed_roots(),
        ) {
            let _ = app.emit(
                "fs:changed",
                FsChangedPayload {
                    paths: vec![request.destination.clone()],
                },
            );
        }
        self.finish_task(&app, &id, result).await;
    }

    /// 复用原文件夹任务执行一次 Direct 单文件重试，并把结果合并回原失败项。
    async fn run_file_retry(
        self: Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        request: EnqueueTransferRequest,
        id: String,
        failure_id: String,
        control: Arc<TaskControl>,
    ) {
        self.set_stage(&app, &id, TransferStage::Scanning).await;
        let mut context = ExecutionContext::new_file_retry(
            self.clone(),
            app.clone(),
            id.clone(),
            control.clone(),
        );
        // 每次重试使用独立 staging 身份，避免断线清理尚未完成时撞上前一次临时路径。
        let execution_id = Uuid::new_v4().to_string();
        let mut result = async {
            control.checkpoint().await?;
            let mut prepared = planner::prepare(
                &workspace,
                &request,
                &execution_id,
                TransferStrategy::Direct,
                &mut context,
            )
            .await?;
            let _reservation = self.scheduler.reserve(prepared.target_keys())?;
            if conflicts::resolve(&mut prepared, TransferStrategy::Direct, &mut context).await? {
                prepared.publish_totals(&mut context).await?;
            }
            let _permit = self.scheduler.acquire(&control).await?;
            direct::execute(prepared, &mut context).await
        }
        .await;
        if let Err(error) = context.flush_pending().await {
            if result.is_ok() {
                result = Err(error);
            }
        }
        if should_emit_fs_changed(
            request.direction,
            result.is_ok(),
            context.has_committed_roots(),
        ) {
            let _ = app.emit(
                "fs:changed",
                FsChangedPayload {
                    paths: vec![request.destination],
                },
            );
        }
        self.finish_file_retry(&app, &id, &failure_id, result).await;
    }

    /// 将单文件重试结果合并回原聚合任务，不创建第二条历史记录。
    async fn finish_file_retry(
        &self,
        app: &AppHandle,
        id: &str,
        failure_id: &str,
        result: Result<(), TransferRunError>,
    ) {
        let _operation = self.history_operations.lock().await;
        let snapshot = self
            .mutate_task(app, id, |task| {
                apply_file_retry_result(task, failure_id, &result)
            })
            .await;
        if let Ok(snapshot) = snapshot {
            if let Err(error) = self.persist_snapshot(id, &snapshot).await {
                log::warn!("failed to persist file retry {id}: {}", error.detail);
                let _ = self
                    .mutate_task(app, id, |task| {
                        task.status = TransferStatus::Failed;
                        task.stage = TransferStage::Finished;
                        task.failure = Some(error);
                        task.conflict = None;
                        task.speed_bytes_per_second = 0;
                    })
                    .await;
            }
        }
        if let Some(task) = self.tasks.write().await.get_mut(id) {
            task.control = None;
        }
    }

    /// 将执行结果转换为稳定终态，并移除暂停和取消控制句柄。
    async fn finish_task(&self, app: &AppHandle, id: &str, result: Result<(), TransferRunError>) {
        let operation = self.history_operations.lock().await;
        let snapshot = self
            .mutate_task(app, id, |task| {
                task.stage = TransferStage::Finished;
                task.current_file = None;
                task.speed_bytes_per_second = 0;
                // 规划中途失败时，已持久化的文件失败也必须纳入汇总总数。
                task.total_files = task
                    .total_files
                    .max(task.completed_files.saturating_add(task.failed_files));
                match &result {
                    Ok(()) => {
                        task.status = if task.failed_files > 0 {
                            TransferStatus::CompletedWithErrors
                        } else {
                            TransferStatus::Completed
                        };
                        if task.failed_files == 0 {
                            task.transferred_bytes = task.total_bytes;
                            task.completed_files = task.total_files;
                        }
                        task.committed_roots = task.total_roots;
                        task.unprocessed_files = 0;
                        task.failure = None;
                    }
                    Err(TransferRunError::Canceled) => {
                        task.status = TransferStatus::Canceled;
                        task.unprocessed_files = task
                            .total_files
                            .saturating_sub(task.completed_files)
                            .saturating_sub(task.failed_files);
                        task.failure = None;
                    }
                    Err(TransferRunError::Failed(failure)) => {
                        task.status = TransferStatus::Failed;
                        task.unprocessed_files = task
                            .total_files
                            .saturating_sub(task.completed_files)
                            .saturating_sub(task.failed_files);
                        task.failure = Some(failure.clone());
                    }
                }
                task.conflict = None;
            })
            .await;
        if let Ok(snapshot) = snapshot {
            if let Err(error) = self.persist_snapshot(id, &snapshot).await {
                log::warn!("failed to persist terminal transfer {id}: {}", error.detail);
                let _ = self
                    .mutate_task(app, id, |task| {
                        task.status = TransferStatus::Failed;
                        task.stage = TransferStage::Finished;
                        task.failure = Some(error);
                        task.conflict = None;
                        task.speed_bytes_per_second = 0;
                    })
                    .await;
            }
        }
        if let Some(task) = self.tasks.write().await.get_mut(id) {
            task.control = None;
        }
        drop(operation);
        self.prune_history(app).await;
    }

    /// 取得仍处于活动期的任务控制句柄。
    async fn control(&self, id: &str) -> Result<Arc<TaskControl>, TransferFailure> {
        self.tasks
            .read()
            .await
            .get(id)
            .and_then(|task| task.control.clone())
            .ok_or_else(|| task_not_found(id))
    }

    /// 推进任务阶段，首次离开队列时同步进入运行态。
    pub(crate) async fn set_stage(&self, app: &AppHandle, id: &str, stage: TransferStage) {
        let _ = self
            .mutate_task(app, id, |task| {
                task.stage = stage;
                if task.status == TransferStatus::Queued {
                    task.status = TransferStatus::Running;
                }
            })
            .await;
    }

    /// 在破坏性提交前同步持久化 Finalizing 快照，Journal 失败时禁止继续提交。
    pub(crate) async fn begin_finalizing(
        &self,
        app: &AppHandle,
        id: &str,
    ) -> Result<(), TransferRunError> {
        self.mutate_and_persist(app, id, |task| task.stage = TransferStage::Finalizing)
            .await
    }

    /// 追加 recovery 或 disposable 清理票据，不改变前端任务快照。
    pub(crate) async fn persist_cleanup_ticket(
        &self,
        id: &str,
        ticket: &CleanupTicket,
    ) -> Result<(), TransferRunError> {
        let path = self.journal_path(id).await?;
        journal::append_cleanup_ticket(&path, ticket)
            .await
            .map_err(TransferRunError::from)
    }

    /// 记录一条清理票据已完成或其路径已不存在。
    pub(crate) async fn finish_cleanup_ticket(
        &self,
        id: &str,
        ticket_id: &str,
    ) -> Result<(), TransferRunError> {
        let path = self.journal_path(id).await?;
        journal::append_cleanup_finished(&path, ticket_id)
            .await
            .map_err(TransferRunError::from)
    }

    /// 发布冲突并把任务切换到等待用户状态。
    pub(crate) async fn begin_conflict(
        &self,
        app: &AppHandle,
        id: &str,
        conflict: TransferConflict,
    ) -> Result<(), TransferRunError> {
        self.mutate_and_persist(app, id, |task| {
            task.status = TransferStatus::AwaitingDecision;
            task.stage = TransferStage::CheckingConflicts;
            task.conflict = Some(conflict);
            task.speed_bytes_per_second = 0;
        })
        .await
    }

    /// 清除已经处理的冲突，并按决策恢复运行或进入取消中状态。
    pub(crate) async fn end_conflict(
        &self,
        app: &AppHandle,
        id: &str,
        resume: bool,
    ) -> Result<(), TransferRunError> {
        let paused = resume && self.control(id).await?.is_paused();
        self.mutate_task(app, id, |task| {
            if task.status == TransferStatus::AwaitingDecision {
                task.status = if resume {
                    if paused {
                        TransferStatus::Paused
                    } else {
                        TransferStatus::Running
                    }
                } else {
                    TransferStatus::Canceling
                };
            }
            task.conflict = None;
        })
        .await
        .map(|_| ())
        .map_err(TransferRunError::from)
    }

    /// 批量记录 Direct 中已经隔离的文件失败。
    pub(crate) async fn record_file_failures(
        &self,
        app: &AppHandle,
        id: &str,
        failures: Vec<TransferFileFailure>,
    ) -> Result<(), TransferRunError> {
        if failures.is_empty() {
            return Ok(());
        }
        let path = self.journal_path(id).await?;
        journal::append_file_failures(&path, &failures)
            .await
            .map_err(TransferRunError::from)?;
        self.mutate_task(app, id, |task| {
            task.failed_files = task.failed_files.saturating_add(failures.len() as u64);
            task.is_directory = true;
            task.file_failures.extend(failures);
        })
        .await
        .map(|_| ())
        .map_err(TransferRunError::from)
    }

    /// 发布扫描所得总量并同步持久化，保证运行中异常退出仍有稳定计数。
    pub(crate) async fn set_totals(
        &self,
        app: &AppHandle,
        id: &str,
        total_files: u64,
        total_bytes: u64,
        total_roots: u64,
        is_directory: bool,
    ) -> Result<(), TransferRunError> {
        self.mutate_and_persist(app, id, |task| {
            task.total_files = total_files;
            task.total_bytes = total_bytes;
            task.total_roots = total_roots;
            task.is_directory = is_directory;
        })
        .await
    }

    /// 记录 Archive 单流的实际字节总量，并同步低频恢复快照。
    pub(crate) async fn set_archive_size(
        &self,
        app: &AppHandle,
        id: &str,
        total_bytes: u64,
    ) -> Result<(), TransferRunError> {
        self.mutate_and_persist(app, id, |task| {
            task.total_bytes = total_bytes;
            task.transferred_bytes = 0;
            task.speed_bytes_per_second = 0;
        })
        .await
    }

    /// 记录 Archive 在打包或解包后确认的文件总数，并同步低频恢复快照。
    pub(crate) async fn set_archive_file_count(
        &self,
        app: &AppHandle,
        id: &str,
        total_files: u64,
    ) -> Result<(), TransferRunError> {
        self.mutate_and_persist(app, id, |task| {
            task.total_files = total_files;
            task.completed_files = task.completed_files.min(total_files);
        })
        .await
    }

    /// 在不可回滚的发布之后同步保存已提交根和文件数量。
    pub(crate) async fn set_committed_progress(
        &self,
        app: &AppHandle,
        id: &str,
        committed_roots: u64,
        completed_files: u64,
    ) -> Result<(), TransferRunError> {
        let snapshot = self
            .mutate_task(app, id, |task| {
                task.committed_roots = committed_roots.min(task.total_roots);
                task.completed_files = task
                    .completed_files
                    .saturating_add(completed_files)
                    .min(task.total_files);
            })
            .await
            .map_err(TransferRunError::from)?;
        let path = self.journal_path(id).await?;
        journal::append_committed_progress(&path, &snapshot)
            .await
            .map_err(TransferRunError::from)
    }

    /// 在写锁内完成一次快照变更，并用严格递增版本向 WebView 发布。
    pub(crate) async fn mutate_task(
        &self,
        app: &AppHandle,
        id: &str,
        mutate: impl FnOnce(&mut TransferTaskSnapshot),
    ) -> Result<TransferTaskSnapshot, TransferFailure> {
        let snapshot = {
            let mut tasks = self.tasks.write().await;
            let task = tasks.get_mut(id).ok_or_else(|| task_not_found(id))?;
            mutate(&mut task.snapshot);
            task.snapshot.updated_at = next_updated_at(task.snapshot.updated_at);
            task.snapshot.clone()
        };
        emit_snapshot(app, &snapshot);
        Ok(snapshot)
    }

    /// 在发布低频快照后立即追加 Journal，供提交边界和稳定总量更新复用。
    async fn mutate_and_persist(
        &self,
        app: &AppHandle,
        id: &str,
        mutate: impl FnOnce(&mut TransferTaskSnapshot),
    ) -> Result<(), TransferRunError> {
        let snapshot = self
            .mutate_task(app, id, mutate)
            .await
            .map_err(TransferRunError::from)?;
        self.persist_snapshot(id, &snapshot)
            .await
            .map_err(TransferRunError::from)
    }

    /// 保留全部活动任务和最近终态记录，并通知前端同步淘汰结果。
    async fn prune_history(&self, app: &AppHandle) {
        let _operation = self.history_operations.lock().await;
        let candidates = {
            let tasks = self.tasks.read().await;
            history_prune_ids(&tasks, MAX_HISTORY_TASKS)
                .into_iter()
                .filter(|id| !has_deferred_cleanup(id))
                .filter_map(|id| tasks.get(&id).map(|task| (id, task.journal_path.clone())))
                .collect::<Vec<_>>()
        };
        for (id, path) in candidates {
            if let Err(error) = journal::remove(&path).await {
                log::warn!("failed to prune transfer journal {id}: {}", error.detail);
                continue;
            }
            self.tasks.write().await.remove(&id);
            emit_removed(app, &id);
        }
    }

    /// 首次访问传输队列时恢复当前 Workspace 环境的持久化历史。
    async fn ensure_journal_loaded(
        &self,
        workspace: &WorkspaceEnv,
        workspace_id: &str,
    ) -> Result<(), TransferFailure> {
        let mut loaded = self.journal_loaded.lock().await;
        if *loaded {
            return Ok(());
        }
        // 历史加载、票据所有权登记和清除必须串行，避免刚恢复的 Journal 被并发删除。
        let _history = self.history_operations.lock().await;
        let recovered = journal::load(workspace, workspace_id).await?;
        let mut cleanup_tickets = Vec::new();
        let mut tasks = self.tasks.write().await;
        for task in recovered {
            for ticket in task
                .cleanup_tickets
                .into_iter()
                .filter(|ticket| ticket.state == CleanupTicketState::Disposable)
            {
                if ticket.owner_task_id() == task.snapshot.id {
                    cleanup_tickets.push((task.path.clone(), ticket));
                } else {
                    log::warn!(
                        "refused transfer cleanup ticket with mismatched owner task id in {}",
                        task.path.display()
                    );
                }
            }
            tasks
                .entry(task.snapshot.id.clone())
                .or_insert(ManagedTask {
                    snapshot: task.snapshot,
                    request: task.request,
                    journal_path: task.path,
                    control: None,
                });
        }
        drop(tasks);
        *loaded = true;
        for (journal_path, ticket) in cleanup_tickets {
            recover_disposable_cleanup(journal_path, ticket);
        }
        Ok(())
    }

    /// 把已取得的低频快照追加到任务 Journal。
    async fn persist_snapshot(
        &self,
        id: &str,
        snapshot: &TransferTaskSnapshot,
    ) -> Result<(), TransferFailure> {
        let path = self.journal_path(id).await?;
        journal::append(&path, snapshot).await
    }

    /// 读取任务创建时固定的 Journal 路径。
    async fn journal_path(&self, id: &str) -> Result<PathBuf, TransferFailure> {
        self.tasks
            .read()
            .await
            .get(id)
            .map(|task| task.journal_path.clone())
            .ok_or_else(|| task_not_found(id))
    }
}

/// 首次加载历史时只对已标记 disposable 的精确路径启动一次清理。
fn recover_disposable_cleanup(journal_path: PathBuf, ticket: CleanupTicket) {
    let owner_task_id = ticket.owner_task_id().to_string();
    begin_deferred_cleanup(&owner_task_id);
    tauri::async_runtime::spawn(async move {
        let _ownership = RecoveredCleanupOwnership(owner_task_id);
        match &ticket.target {
            CleanupTicketTarget::Local {
                staging_task_id,
                owner_task_id,
                paths,
            } => {
                let Some(remaining) =
                    super::commit::remove_persisted_local_backups(staging_task_id, paths).await
                else {
                    return;
                };
                if remaining.is_empty() {
                    finish_recovered_cleanup(&journal_path, &ticket.id).await;
                } else {
                    super::commit::schedule_local_cleanup(owner_task_id, remaining);
                }
            }
            CleanupTicketTarget::Ssh { .. } => {
                let Some((scope, paths)) =
                    super::ssh::cleanup::RemoteCleanupScope::from_ticket(&ticket.target)
                else {
                    return;
                };
                let workspace = match crate::modules::remote::manager::global_manager() {
                    Ok(manager) => manager.workspace(scope.profile_id()).await.ok(),
                    Err(_) => None,
                };
                let Some(workspace) = workspace else {
                    super::ssh::cleanup::schedule(scope, paths);
                    return;
                };
                if !scope.matches_workspace(&workspace) {
                    return;
                }
                let remaining = super::ssh::cleanup::remove_now(&workspace, &scope, &paths).await;
                if remaining.is_empty() {
                    finish_recovered_cleanup(&journal_path, &ticket.id).await;
                } else {
                    super::ssh::cleanup::schedule(scope, remaining);
                }
            }
        }
    });
}

/// 确保一次恢复清理在任何退出路径都释放临时历史所有权。
struct RecoveredCleanupOwnership(String);

impl Drop for RecoveredCleanupOwnership {
    fn drop(&mut self) {
        finish_deferred_cleanup(&self.0);
    }
}

async fn finish_recovered_cleanup(journal_path: &std::path::Path, ticket_id: &str) {
    if let Err(error) = journal::append_cleanup_finished(journal_path, ticket_id).await {
        log::warn!(
            "failed to finish recovered transfer cleanup ticket: {}",
            error.detail
        );
    }
}

fn emit_snapshot(app: &AppHandle, snapshot: &TransferTaskSnapshot) {
    if let Err(error) = app.emit(TRANSFER_EVENT, snapshot) {
        log::warn!("failed to emit transfer update: {error}");
    }
}

fn emit_removed(app: &AppHandle, id: &str) {
    if let Err(error) = app.emit(TRANSFER_REMOVED_EVENT, id) {
        log::warn!("failed to emit transfer removal: {error}");
    }
}

/// 把一次文件重试的终态合并进原聚合快照。
fn apply_file_retry_result(
    task: &mut TransferTaskSnapshot,
    failure_id: &str,
    result: &Result<(), TransferRunError>,
) {
    task.stage = TransferStage::Finished;
    task.current_file = None;
    task.conflict = None;
    task.speed_bytes_per_second = 0;
    task.failure = None;
    match result {
        Ok(()) => {
            if let Some(failure) = task
                .file_failures
                .iter_mut()
                .find(|failure| failure.id == failure_id)
            {
                failure.ignored = true;
            }
            task.failed_files = task.failed_files.saturating_sub(1);
            task.completed_files = task.completed_files.saturating_add(1).min(task.total_files);
            task.status = if task.failed_files == 0 {
                task.transferred_bytes = task.total_bytes;
                TransferStatus::Completed
            } else {
                TransferStatus::CompletedWithErrors
            };
        }
        Err(TransferRunError::Failed(retry_failure)) => {
            if let Some(failure) = task
                .file_failures
                .iter_mut()
                .find(|failure| failure.id == failure_id)
            {
                failure.failure = retry_failure.clone();
                failure.ignored = false;
            }
            task.status = TransferStatus::CompletedWithErrors;
        }
        Err(TransferRunError::Canceled) => {
            task.status = TransferStatus::CompletedWithErrors;
        }
    }
}

fn task_not_found(id: &str) -> TransferFailure {
    TransferFailure::new(
        TransferErrorCode::TaskNotFound,
        format!("transfer task {id} was not found"),
    )
}

fn ensure_active_capacity(tasks: &HashMap<String, ManagedTask>) -> Result<(), TransferFailure> {
    let pending = PENDING_CLEANUPS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let active_count = tasks
        .values()
        .filter(|task| {
            !task.snapshot.status.is_terminal() || pending.contains_key(&task.snapshot.id)
        })
        .count();
    if active_count >= MAX_ACTIVE_TASKS {
        return Err(TransferFailure::new(
            TransferErrorCode::ResourceLimit,
            format!("active transfer task count exceeds {MAX_ACTIVE_TASKS}"),
        ));
    }
    Ok(())
}

fn is_supported_conflict_resolution(
    conflict: &TransferConflict,
    request: &ResolveTransferConflictRequest,
) -> bool {
    conflict.id == request.conflict_id
        && conflict.decisions.contains(&request.decision)
        && (!request.apply_to_remaining
            || conflict.allow_apply_to_remaining
                && matches!(
                    request.decision,
                    TransferConflictDecision::Replace | TransferConflictDecision::Skip
                ))
}

fn retry_destination_parent(
    workspace: &WorkspaceEnv,
    destination_path: &str,
) -> Result<String, TransferFailure> {
    let parent = match workspace {
        WorkspaceEnv::Local => None,
        WorkspaceEnv::Wsl { .. } | WorkspaceEnv::Ssh { .. }
            if destination_path.starts_with('/') =>
        {
            destination_path.rsplit_once('/').map(|(parent, _)| {
                if parent.is_empty() {
                    "/".to_string()
                } else {
                    parent.to_string()
                }
            })
        }
        WorkspaceEnv::Wsl { .. } | WorkspaceEnv::Ssh { .. } => {
            std::path::Path::new(destination_path)
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
        }
    };
    parent.ok_or_else(|| {
        TransferFailure::new(
            TransferErrorCode::InvalidRequest,
            "failed transfer destination has no parent directory",
        )
    })
}

fn history_prune_ids(tasks: &HashMap<String, ManagedTask>, limit: usize) -> Vec<String> {
    let mut terminal: Vec<_> = history_matching_ids(tasks, TransferStatus::is_terminal)
        .into_iter()
        .filter_map(|id| tasks.get(&id).map(|task| (task.snapshot.created_at, id)))
        .collect();
    terminal.sort();
    let remove_count = terminal.len().saturating_sub(limit);
    terminal
        .into_iter()
        .take(remove_count)
        .map(|(_, id)| id)
        .collect()
}

fn history_matching_ids<F>(tasks: &HashMap<String, ManagedTask>, matches: F) -> Vec<String>
where
    F: Fn(TransferStatus) -> bool,
{
    let mut ids: Vec<_> = tasks
        .iter()
        .filter(|(_, task)| matches(task.snapshot.status))
        .map(|(id, task)| (task.snapshot.created_at, id.clone()))
        .collect();
    ids.sort_by_key(|(created_at, id)| (*created_at, id.clone()));
    ids.into_iter().map(|(_, id)| id).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn next_updated_at(previous: u64) -> u64 {
    now_ms().max(previous.saturating_add(1))
}

fn task_name(sources: &[String]) -> String {
    if sources.len() > 1 {
        return format!("{} items", sources.len());
    }
    sources
        .first()
        .map(|source| source.trim_end_matches(['/', '\\']))
        .and_then(|source| source.rsplit(['/', '\\']).next())
        .filter(|name| !name.is_empty())
        .unwrap_or("transfer")
        .to_string()
}

fn resumed_status(stage: TransferStage) -> TransferStatus {
    if stage == TransferStage::Queued {
        TransferStatus::Queued
    } else {
        TransferStatus::Running
    }
}

fn should_emit_fs_changed(
    direction: TransferDirection,
    succeeded: bool,
    has_committed_roots: bool,
) -> bool {
    direction == TransferDirection::Upload && (succeeded || has_committed_roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed_task(id: &str, status: TransferStatus, created_at: u64) -> ManagedTask {
        ManagedTask {
            snapshot: TransferTaskSnapshot {
                id: id.into(),
                direction: TransferDirection::Upload,
                strategy: TransferStrategy::Direct,
                status,
                stage: TransferStage::Finished,
                source_count: 1,
                destination: "/tmp".into(),
                name: id.into(),
                total_bytes: 0,
                transferred_bytes: 0,
                total_files: 0,
                completed_files: 0,
                failed_files: 0,
                unprocessed_files: 0,
                total_roots: 0,
                committed_roots: 0,
                speed_bytes_per_second: 0,
                current_file: None,
                failure: None,
                file_failures: Vec::new(),
                conflict: None,
                is_directory: false,
                created_at,
                updated_at: created_at,
            },
            request: EnqueueTransferRequest {
                direction: TransferDirection::Upload,
                strategy: TransferStrategy::Direct,
                sources: vec![id.into()],
                destination: "/tmp".into(),
            },
            journal_path: PathBuf::from(format!("{id}.jsonl")),
            control: None,
        }
    }

    #[tokio::test]
    async fn task_control_resumes_and_cancels_waiters() {
        let control = Arc::new(TaskControl::new());
        control.pause();
        let waiter = {
            let control = control.clone();
            tokio::spawn(async move { control.checkpoint().await })
        };
        tokio::task::yield_now().await;
        control.resume();
        assert!(waiter.await.unwrap().is_ok());

        control.pause();
        let canceled = {
            let control = control.clone();
            tokio::spawn(async move { control.checkpoint().await })
        };
        tokio::task::yield_now().await;
        control.cancel();
        assert!(matches!(
            canceled.await.unwrap(),
            Err(TransferRunError::Canceled)
        ));
    }

    #[test]
    fn task_name_handles_windows_and_posix_paths() {
        assert_eq!(task_name(&["C:\\Users\\me\\file.txt".into()]), "file.txt");
        assert_eq!(task_name(&["/home/me/project/".into()]), "project");
        assert_eq!(task_name(&["a".into(), "b".into()]), "2 items");
    }

    #[test]
    fn task_updates_are_strictly_monotonic() {
        let previous = now_ms().saturating_add(1_000);
        assert!(next_updated_at(previous) > previous);
    }

    #[test]
    fn active_task_limit_counts_all_non_terminal_tasks() {
        let mut tasks = HashMap::new();
        for index in 0..MAX_ACTIVE_TASKS {
            let id = index.to_string();
            tasks.insert(
                id.clone(),
                managed_task(&id, TransferStatus::Running, index as u64),
            );
        }
        assert_eq!(
            ensure_active_capacity(&tasks).unwrap_err().code,
            TransferErrorCode::ResourceLimit
        );

        tasks.get_mut("0").unwrap().snapshot.status = TransferStatus::Completed;
        begin_deferred_cleanup("0");
        assert_eq!(
            ensure_active_capacity(&tasks).unwrap_err().code,
            TransferErrorCode::ResourceLimit
        );
        finish_deferred_cleanup("0");
        assert!(ensure_active_capacity(&tasks).is_ok());
    }

    #[test]
    fn deferred_cleanup_uses_reference_counts_per_task() {
        let task = Uuid::new_v4().to_string();
        begin_deferred_cleanup(&task);
        begin_deferred_cleanup(&task);
        assert!(has_deferred_cleanup(&task));

        finish_deferred_cleanup(&task);
        assert!(has_deferred_cleanup(&task));
        finish_deferred_cleanup(&task);
        assert!(!has_deferred_cleanup(&task));
    }

    #[test]
    fn private_staging_conflicts_are_task_level_failures() {
        assert!(
            TransferRunError::failed(TransferErrorCode::SourceChanged, "changed").is_file_scoped()
        );
        assert!(!TransferRunError::failed(
            TransferErrorCode::DestinationExists,
            "private staging collision"
        )
        .is_file_scoped());
        assert!(!TransferRunError::failed(TransferErrorCode::StorageFull, "full").is_file_scoped());
    }

    #[test]
    fn queued_tasks_resume_as_queued_until_the_scheduler_runs_them() {
        assert_eq!(
            resumed_status(TransferStage::Queued),
            TransferStatus::Queued
        );
        assert_eq!(
            resumed_status(TransferStage::Transferring),
            TransferStatus::Running
        );
    }

    #[test]
    fn history_clear_filters_only_requested_terminal_states() {
        let tasks = HashMap::from([
            (
                "active".into(),
                managed_task("active", TransferStatus::Running, 0),
            ),
            (
                "completed".into(),
                managed_task("completed", TransferStatus::Completed, 1),
            ),
            (
                "failed".into(),
                managed_task("failed", TransferStatus::Failed, 2),
            ),
            (
                "partial".into(),
                managed_task("partial", TransferStatus::CompletedWithErrors, 3),
            ),
            (
                "canceled".into(),
                managed_task("canceled", TransferStatus::Canceled, 4),
            ),
        ]);

        assert_eq!(
            history_matching_ids(&tasks, |status| status == TransferStatus::Completed),
            vec!["completed"]
        );
        assert_eq!(
            history_matching_ids(&tasks, TransferStatus::is_terminal),
            vec!["completed", "failed", "partial", "canceled"]
        );
    }

    #[test]
    fn partial_uploads_still_notify_the_workspace() {
        assert!(should_emit_fs_changed(
            TransferDirection::Upload,
            false,
            true
        ));
        assert!(!should_emit_fs_changed(
            TransferDirection::Upload,
            false,
            false
        ));
        assert!(!should_emit_fs_changed(
            TransferDirection::Download,
            true,
            true
        ));
    }

    #[test]
    fn history_pruning_keeps_active_tasks_and_newest_terminal_tasks() {
        let tasks = HashMap::from([
            (
                "active".into(),
                managed_task("active", TransferStatus::Running, 0),
            ),
            (
                "old".into(),
                managed_task("old", TransferStatus::Completed, 1),
            ),
            ("new".into(), managed_task("new", TransferStatus::Failed, 2)),
        ]);
        assert_eq!(history_prune_ids(&tasks, 1), vec!["old"]);
    }

    #[tokio::test]
    async fn conflict_resolution_is_bound_to_the_requested_conflict() {
        let control = Arc::new(TaskControl::new());
        control.begin_conflict("current".into()).await.unwrap();
        assert!(
            control
                .resolve_conflict(ConflictResolution {
                    conflict_id: "current".into(),
                    decision: TransferConflictDecision::Replace,
                    apply_to_remaining: true,
                })
                .await
        );
        assert!(
            !control
                .resolve_conflict(ConflictResolution {
                    conflict_id: "current".into(),
                    decision: TransferConflictDecision::Cancel,
                    apply_to_remaining: false,
                })
                .await
        );

        let resolution = control.wait_for_conflict("current").await.unwrap();

        assert_eq!(resolution.decision, TransferConflictDecision::Replace);
        assert!(resolution.apply_to_remaining);
    }

    #[test]
    fn conflict_resolution_rejects_stale_actions_and_unauthorized_bulk_decisions() {
        let mut conflict = TransferConflict {
            id: "current".into(),
            kind: super::super::models::TransferConflictKind::File,
            source_kind: super::super::models::TransferEntryKind::File,
            destination_kind: super::super::models::TransferEntryKind::File,
            source_path: "/source".into(),
            destination_path: "/target".into(),
            decisions: vec![
                TransferConflictDecision::Cancel,
                TransferConflictDecision::Skip,
                TransferConflictDecision::Replace,
            ],
            allow_apply_to_remaining: false,
        };
        let mut request = ResolveTransferConflictRequest {
            task_id: "task".into(),
            conflict_id: "current".into(),
            decision: TransferConflictDecision::Replace,
            apply_to_remaining: false,
        };

        assert!(is_supported_conflict_resolution(&conflict, &request));
        request.conflict_id = "stale".into();
        assert!(!is_supported_conflict_resolution(&conflict, &request));
        request.conflict_id = "current".into();
        request.decision = TransferConflictDecision::Merge;
        assert!(!is_supported_conflict_resolution(&conflict, &request));
        request.decision = TransferConflictDecision::MergeSkip;
        assert!(!is_supported_conflict_resolution(&conflict, &request));
        request.decision = TransferConflictDecision::Replace;
        request.apply_to_remaining = true;
        assert!(!is_supported_conflict_resolution(&conflict, &request));

        conflict.allow_apply_to_remaining = true;
        assert!(is_supported_conflict_resolution(&conflict, &request));
        request.decision = TransferConflictDecision::Skip;
        assert!(is_supported_conflict_resolution(&conflict, &request));
        request.decision = TransferConflictDecision::Cancel;
        assert!(!is_supported_conflict_resolution(&conflict, &request));
    }

    #[test]
    fn file_retry_uses_the_failed_destination_parent() {
        assert_eq!(
            retry_destination_parent(
                &WorkspaceEnv::Ssh {
                    profile_id: "server".into()
                },
                "/srv/project/src/main.rs"
            )
            .unwrap(),
            "/srv/project/src"
        );
        #[cfg(windows)]
        assert_eq!(
            retry_destination_parent(
                &WorkspaceEnv::Wsl {
                    distro: "Ubuntu".into()
                },
                "C:\\work\\project\\main.rs"
            )
            .unwrap(),
            "C:\\work\\project"
        );
    }

    #[test]
    fn successful_file_retry_updates_the_original_aggregate_snapshot() {
        let mut task = managed_task("parent", TransferStatus::CompletedWithErrors, 1).snapshot;
        task.total_files = 2;
        task.completed_files = 1;
        task.failed_files = 1;
        task.total_bytes = 20;
        task.transferred_bytes = 10;
        task.file_failures.push(TransferFileFailure {
            id: "failure".into(),
            source_path: "/source/file".into(),
            destination_path: "/target/file".into(),
            failure: TransferFailure::new(TransferErrorCode::SourceChanged, "changed"),
            attempts: 2,
            ignored: false,
        });

        apply_file_retry_result(&mut task, "failure", &Ok(()));

        assert_eq!(task.status, TransferStatus::Completed);
        assert_eq!(task.completed_files, 2);
        assert_eq!(task.failed_files, 0);
        assert_eq!(task.transferred_bytes, 20);
        assert!(task.file_failures[0].ignored);
    }
}
