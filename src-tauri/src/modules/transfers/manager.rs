//! 后台文件传输队列与任务生命周期管理。
//!
//! 管理器持有有界任务历史、原始请求与控制信号，并把等待执行、目标 reservation、
//! 重试和终态收敛串成统一生命周期。具体扫描、复制和进度聚合由低依赖模块负责。

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::modules::workspace::WorkspaceEnv;

use super::errors::{TransferErrorCode, TransferFailure};
use super::models::{
    EnqueueTransferRequest, TransferDirection, TransferStage, TransferStatus, TransferStrategy,
    TransferTaskSnapshot,
};
use super::planner;
use super::progress::ExecutionContext;
use super::scheduler::TransferScheduler;
use super::{archive, direct};

const MAX_CONCURRENT_TASKS: usize = 2;
const MAX_ACTIVE_TASKS: usize = 64;
const MAX_HISTORY_TASKS: usize = 100;
const TRANSFER_EVENT: &str = "terax://transfer-updated";
const TRANSFER_REMOVED_EVENT: &str = "terax://transfer-removed";

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
}

/// 单任务的协作式暂停与取消信号。
pub(crate) struct TaskControl {
    paused: AtomicBool,
    pause_changed: Notify,
    cancellation: CancellationToken,
}

impl TaskControl {
    /// 创建未暂停且未取消的任务控制信号。
    pub(crate) fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            pause_changed: Notify::new(),
            cancellation: CancellationToken::new(),
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
}

/// 保存当前进程任务快照、控制句柄和全局并发许可。
pub(crate) struct TransferManager {
    tasks: RwLock<HashMap<String, ManagedTask>>,
    controls: RwLock<HashMap<String, Arc<TaskControl>>>,
    scheduler: TransferScheduler,
}

struct ManagedTask {
    snapshot: TransferTaskSnapshot,
    request: EnqueueTransferRequest,
}

impl TransferManager {
    /// 创建具有固定并发上限的进程内任务管理器。
    fn new(concurrency: usize) -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            controls: RwLock::new(HashMap::new()),
            scheduler: TransferScheduler::new(concurrency),
        }
    }

    /// 创建任务并立即返回快照，扫描与复制在后台异步执行。
    pub(crate) async fn enqueue(
        self: &Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        request: EnqueueTransferRequest,
        strategy: TransferStrategy,
    ) -> Result<TransferTaskSnapshot, TransferFailure> {
        let request = request.normalize()?;
        if matches!(workspace, WorkspaceEnv::Local) {
            return Err(TransferFailure::new(
                TransferErrorCode::WorkspaceUnavailable,
                "file transfer is only available in WSL or SSH workspaces",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let snapshot = TransferTaskSnapshot {
            id: id.clone(),
            direction: request.direction,
            strategy,
            status: TransferStatus::Queued,
            stage: TransferStage::Queued,
            source_count: request.sources.len() as u64,
            destination: request.destination.clone(),
            name: task_name(&request.sources),
            total_bytes: 0,
            transferred_bytes: 0,
            total_files: 0,
            completed_files: 0,
            total_roots: 0,
            committed_roots: 0,
            speed_bytes_per_second: 0,
            current_file: None,
            failure: None,
            created_at: now,
            updated_at: now,
        };
        let control = Arc::new(TaskControl::new());
        {
            let mut tasks = self.tasks.write().await;
            let active_count = tasks
                .values()
                .filter(|task| !task.snapshot.status.is_terminal())
                .count();
            if active_count >= MAX_ACTIVE_TASKS {
                return Err(TransferFailure::new(
                    TransferErrorCode::ResourceLimit,
                    format!("active transfer task count exceeds {MAX_ACTIVE_TASKS}"),
                ));
            }
            tasks.insert(
                id.clone(),
                ManagedTask {
                    snapshot: snapshot.clone(),
                    request: request.clone(),
                },
            );
        }
        self.controls
            .write()
            .await
            .insert(id.clone(), control.clone());
        emit_snapshot(&app, &snapshot);

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .run_task(app, workspace, request, strategy, id, control)
                .await;
        });
        Ok(snapshot)
    }

    /// 返回按创建时间倒序排列的当前任务快照。
    pub(crate) async fn list(&self) -> Vec<TransferTaskSnapshot> {
        let mut tasks: Vec<_> = self
            .tasks
            .read()
            .await
            .values()
            .map(|task| task.snapshot.clone())
            .collect();
        tasks.sort_by_key(|task| Reverse(task.created_at));
        tasks
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

    /// 移除单个终态任务的历史记录。
    pub(crate) async fn remove(&self, app: &AppHandle, id: &str) -> Result<(), TransferFailure> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get(id).ok_or_else(|| task_not_found(id))?;
        if !task.snapshot.status.is_terminal() {
            return Err(TransferFailure::new(
                TransferErrorCode::InvalidTaskState,
                "active transfer task cannot be removed",
            ));
        }
        tasks.remove(id);
        drop(tasks);
        emit_removed(app, id);
        Ok(())
    }

    /// 清理已完成的历史任务，并返回实际删除的任务 ID。
    pub(crate) async fn clear_completed(&self, app: &AppHandle) -> Vec<String> {
        self.clear_matching(app, |status| status == TransferStatus::Completed)
            .await
    }

    /// 清理全部终态历史任务，并返回实际删除的任务 ID。
    pub(crate) async fn clear_all(&self, app: &AppHandle) -> Vec<String> {
        self.clear_matching(app, TransferStatus::is_terminal).await
    }

    /// 在持有任务写锁时一次性筛选并删除历史，释放锁后再发布逐项移除事件。
    async fn clear_matching(
        &self,
        app: &AppHandle,
        matches: impl Fn(TransferStatus) -> bool,
    ) -> Vec<String> {
        let removed = {
            let mut tasks = self.tasks.write().await;
            let removed = history_matching_ids(&tasks, matches);
            for id in &removed {
                tasks.remove(id);
            }
            removed
        };
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
        id: &str,
    ) -> Result<TransferTaskSnapshot, TransferFailure> {
        let (request, strategy) = {
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
            (task.request.clone(), task.snapshot.strategy)
        };
        self.enqueue(app, workspace, request, strategy).await
    }

    /// 等待并发许可后运行任务，并统一发布文件系统变更和终态。
    async fn run_task(
        self: Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        request: EnqueueTransferRequest,
        strategy: TransferStrategy,
        id: String,
        control: Arc<TaskControl>,
    ) {
        let _permit = match self.scheduler.acquire(&control).await {
            Ok(permit) => permit,
            Err(error) => {
                self.finish_task(&app, &id, Err(error)).await;
                return;
            }
        };
        if let Err(error) = control.checkpoint().await {
            self.finish_task(&app, &id, Err(error)).await;
            return;
        }

        self.set_stage(&app, &id, TransferStage::Scanning).await;
        let mut context = ExecutionContext::new(self.clone(), app.clone(), id.clone(), control);
        let result = match planner::prepare(&workspace, &request, &id, &context).await {
            Ok(prepared) => match self.scheduler.reserve(prepared.target_keys()) {
                Ok(_reservation) => match strategy {
                    TransferStrategy::Direct => direct::execute(prepared, &mut context).await,
                    TransferStrategy::Archive => archive::execute(prepared, &mut context).await,
                },
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        context.flush_pending().await;
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

    /// 将执行结果转换为稳定终态，并移除暂停和取消控制句柄。
    async fn finish_task(&self, app: &AppHandle, id: &str, result: Result<(), TransferRunError>) {
        let _ = self
            .mutate_task(app, id, |task| {
                task.stage = TransferStage::Finished;
                task.current_file = None;
                task.speed_bytes_per_second = 0;
                match &result {
                    Ok(()) => {
                        task.status = TransferStatus::Completed;
                        task.transferred_bytes = task.total_bytes;
                        task.completed_files = task.total_files;
                        task.committed_roots = task.total_roots;
                        task.failure = None;
                    }
                    Err(TransferRunError::Canceled) => {
                        task.status = TransferStatus::Canceled;
                        task.failure = None;
                    }
                    Err(TransferRunError::Failed(failure)) => {
                        task.status = TransferStatus::Failed;
                        task.failure = Some(failure.clone());
                    }
                }
            })
            .await;
        self.controls.write().await.remove(id);
        self.prune_history(app).await;
    }

    /// 取得仍处于活动期的任务控制句柄。
    async fn control(&self, id: &str) -> Result<Arc<TaskControl>, TransferFailure> {
        self.controls
            .read()
            .await
            .get(id)
            .cloned()
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

    /// 保留全部活动任务和最近终态记录，并通知前端同步淘汰结果。
    async fn prune_history(&self, app: &AppHandle) {
        let removed = {
            let mut tasks = self.tasks.write().await;
            let removed = history_prune_ids(&tasks, MAX_HISTORY_TASKS);
            if removed.is_empty() {
                return;
            }
            for id in &removed {
                tasks.remove(id);
            }
            removed
        };
        for id in removed {
            emit_removed(app, &id);
        }
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

fn task_not_found(id: &str) -> TransferFailure {
    TransferFailure::new(
        TransferErrorCode::TaskNotFound,
        format!("transfer task {id} was not found"),
    )
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

fn history_matching_ids(
    tasks: &HashMap<String, ManagedTask>,
    matches: impl Fn(TransferStatus) -> bool,
) -> Vec<String> {
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
                total_roots: 0,
                committed_roots: 0,
                speed_bytes_per_second: 0,
                current_file: None,
                failure: None,
                created_at,
                updated_at: created_at,
            },
            request: EnqueueTransferRequest {
                direction: TransferDirection::Upload,
                sources: vec![id.into()],
                destination: "/tmp".into(),
            },
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
                "canceled".into(),
                managed_task("canceled", TransferStatus::Canceled, 3),
            ),
        ]);

        assert_eq!(
            history_matching_ids(&tasks, |status| status == TransferStatus::Completed),
            vec!["completed"]
        );
        assert_eq!(
            history_matching_ids(&tasks, TransferStatus::is_terminal),
            vec!["completed", "failed", "canceled"]
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
}
