//! 后台文件传输队列与任务生命周期管理。
//!
//! 管理器限制并发任务数，并通过协作式检查点实现暂停和取消。进度事件经过
//! 节流后发送给 WebView，避免大文件复制产生逐块 IPC 压力。

use std::cmp::Reverse;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::modules::workspace::WorkspaceEnv;

use super::direct;
use super::models::{
    EnqueueTransferRequest, TransferDirection, TransferStage, TransferStatus, TransferTaskSnapshot,
};

const MAX_CONCURRENT_TASKS: usize = 2;
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(200);
const TRANSFER_EVENT: &str = "terax://transfer-updated";

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
    Message(String),
}

impl From<String> for TransferRunError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

/// 单任务的协作式暂停与取消信号。
struct TaskControl {
    paused: AtomicBool,
    pause_changed: Notify,
    cancellation: CancellationToken,
}

impl TaskControl {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            pause_changed: Notify::new(),
            cancellation: CancellationToken::new(),
        }
    }

    /// 在每个文件块和目录项之间执行协作式暂停与取消。
    async fn checkpoint(&self) -> Result<(), TransferRunError> {
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
}

/// 保存当前进程任务快照、控制句柄和全局并发许可。
pub(crate) struct TransferManager {
    tasks: RwLock<HashMap<String, TransferTaskSnapshot>>,
    controls: RwLock<HashMap<String, Arc<TaskControl>>>,
    semaphore: Arc<Semaphore>,
}

impl TransferManager {
    /// 创建具有固定并发上限的进程内任务管理器。
    fn new(concurrency: usize) -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            controls: RwLock::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(concurrency.max(1))),
        }
    }

    /// 创建任务并立即返回快照，扫描与复制在后台异步执行。
    pub(crate) async fn enqueue(
        self: &Arc<Self>,
        app: AppHandle,
        workspace: WorkspaceEnv,
        request: EnqueueTransferRequest,
    ) -> Result<TransferTaskSnapshot, String> {
        let request = request.normalize()?;
        if matches!(workspace, WorkspaceEnv::Local) {
            return Err("file transfer is only available in WSL or SSH workspaces".into());
        }
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let snapshot = TransferTaskSnapshot {
            id: id.clone(),
            direction: request.direction,
            status: TransferStatus::Queued,
            stage: TransferStage::Queued,
            source_count: request.sources.len() as u64,
            destination: request.destination.clone(),
            name: task_name(&request.sources),
            total_bytes: 0,
            transferred_bytes: 0,
            total_files: 0,
            completed_files: 0,
            speed_bytes_per_second: 0,
            current_file: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        let control = Arc::new(TaskControl::new());
        self.tasks
            .write()
            .await
            .insert(id.clone(), snapshot.clone());
        self.controls
            .write()
            .await
            .insert(id.clone(), control.clone());
        emit_snapshot(&app, &snapshot);

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_task(app, workspace, request, id, control).await;
        });
        Ok(snapshot)
    }

    /// 返回按创建时间倒序排列的当前任务快照。
    pub(crate) async fn list(&self) -> Vec<TransferTaskSnapshot> {
        let mut tasks: Vec<_> = self.tasks.read().await.values().cloned().collect();
        tasks.sort_by_key(|task| Reverse(task.created_at));
        tasks
    }

    /// 暂停尚未结束的任务。
    pub(crate) async fn pause(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let control = self.control(id).await?;
        control.paused.store(true, Ordering::Release);
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
    pub(crate) async fn resume(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let control = self.control(id).await?;
        control.paused.store(false, Ordering::Release);
        // 每个任务只有一个执行器，notify_one 会在尚未进入等待时保留许可，避免丢失恢复信号。
        control.pause_changed.notify_one();
        self.mutate_task(app, id, |task| {
            if task.status == TransferStatus::Paused {
                task.status = TransferStatus::Running;
            }
        })
        .await?;
        Ok(())
    }

    /// 请求取消任务，执行器会在下一个安全检查点清理临时目标。
    pub(crate) async fn cancel(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let control = self.control(id).await?;
        control.cancellation.cancel();
        control.pause_changed.notify_one();
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
    pub(crate) async fn remove(&self, id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get(id)
            .ok_or_else(|| format!("transfer task {id} was not found"))?;
        if !task.status.is_terminal() {
            return Err("active transfer task cannot be removed".into());
        }
        tasks.remove(id);
        Ok(())
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
        let permit = tokio::select! {
            permit = self.semaphore.clone().acquire_owned() => permit.ok(),
            _ = control.cancellation.cancelled() => None,
        };
        let Some(_permit) = permit else {
            self.finish_task(&app, &id, Err(TransferRunError::Canceled))
                .await;
            return;
        };
        if let Err(error) = control.checkpoint().await {
            self.finish_task(&app, &id, Err(error)).await;
            return;
        }

        self.set_stage(&app, &id, TransferStage::Scanning).await;
        let mut context = ExecutionContext::new(self.clone(), app.clone(), id.clone(), control);
        let result = direct::execute(&workspace, &request, &id, &mut context).await;
        if let Ok(changed_paths) = &result {
            if request.direction == TransferDirection::Upload && !changed_paths.is_empty() {
                let _ = app.emit(
                    "fs:changed",
                    FsChangedPayload {
                        paths: changed_paths.clone(),
                    },
                );
            }
        }
        self.finish_task(&app, &id, result.map(|_| ())).await;
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
                        task.error = None;
                    }
                    Err(TransferRunError::Canceled) => {
                        task.status = TransferStatus::Canceled;
                        task.error = None;
                    }
                    Err(TransferRunError::Message(error)) => {
                        task.status = TransferStatus::Failed;
                        task.error = Some(error.clone());
                    }
                }
            })
            .await;
        self.controls.write().await.remove(id);
    }

    /// 取得仍处于活动期的任务控制句柄。
    async fn control(&self, id: &str) -> Result<Arc<TaskControl>, String> {
        self.controls
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("active transfer task {id} was not found"))
    }

    /// 推进任务阶段，首次离开队列时同步进入运行态。
    async fn set_stage(&self, app: &AppHandle, id: &str, stage: TransferStage) {
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
    async fn mutate_task(
        &self,
        app: &AppHandle,
        id: &str,
        mutate: impl FnOnce(&mut TransferTaskSnapshot),
    ) -> Result<TransferTaskSnapshot, String> {
        let snapshot = {
            let mut tasks = self.tasks.write().await;
            let task = tasks
                .get_mut(id)
                .ok_or_else(|| format!("transfer task {id} was not found"))?;
            mutate(task);
            task.updated_at = next_updated_at(task.updated_at);
            task.clone()
        };
        emit_snapshot(app, &snapshot);
        Ok(snapshot)
    }
}

/// Direct 执行器使用的任务上下文。
pub(crate) struct ExecutionContext {
    manager: Arc<TransferManager>,
    app: AppHandle,
    task_id: String,
    control: Arc<TaskControl>,
    pending_bytes: u64,
    pending_files: u64,
    pending_current_file: Option<String>,
    sample_started: Instant,
}

impl ExecutionContext {
    fn new(
        manager: Arc<TransferManager>,
        app: AppHandle,
        task_id: String,
        control: Arc<TaskControl>,
    ) -> Self {
        Self {
            manager,
            app,
            task_id,
            control,
            pending_bytes: 0,
            pending_files: 0,
            pending_current_file: None,
            sample_started: Instant::now(),
        }
    }

    /// 等待暂停结束或返回取消信号。
    pub(crate) async fn checkpoint(&self) -> Result<(), TransferRunError> {
        self.control.checkpoint().await
    }

    /// 设置任务阶段并保留暂停状态。
    pub(crate) async fn set_stage(&mut self, stage: TransferStage) {
        self.flush_progress().await;
        self.manager
            .set_stage(&self.app, &self.task_id, stage)
            .await;
    }

    /// 在扫描完成后发布稳定的文件数和总字节数。
    pub(crate) async fn set_totals(&self, total_files: u64, total_bytes: u64) {
        let _ = self
            .manager
            .mutate_task(&self.app, &self.task_id, |task| {
                task.total_files = total_files;
                task.total_bytes = total_bytes;
            })
            .await;
    }

    /// 聚合当前处理路径，前端展示时仅截取 basename。
    pub(crate) async fn set_current_file(&mut self, path: String) {
        self.pending_current_file = Some(path);
        if self.sample_started.elapsed() >= PROGRESS_EVENT_INTERVAL {
            self.flush_progress().await;
        }
    }

    /// 聚合字节增量，并以固定频率更新前端快照。
    pub(crate) async fn report_bytes(&mut self, bytes: u64) {
        self.pending_bytes = self.pending_bytes.saturating_add(bytes);
        if self.sample_started.elapsed() >= PROGRESS_EVENT_INTERVAL {
            self.flush_progress().await;
        }
    }

    /// 聚合文件完成计数，小文件批量传输时同样遵循进度节流。
    pub(crate) async fn complete_file(&mut self) {
        self.pending_files = self.pending_files.saturating_add(1);
        if self.sample_started.elapsed() >= PROGRESS_EVENT_INTERVAL {
            self.flush_progress().await;
        }
    }

    /// 一次性提交节流窗口内累计的字节、文件数与当前文件。
    async fn flush_progress(&mut self) {
        if self.pending_bytes == 0 && self.pending_files == 0 && self.pending_current_file.is_none()
        {
            self.sample_started = Instant::now();
            return;
        }
        let elapsed = self.sample_started.elapsed().as_secs_f64().max(0.001);
        let bytes = std::mem::take(&mut self.pending_bytes);
        let files = std::mem::take(&mut self.pending_files);
        let current_file = self.pending_current_file.take();
        let speed = if bytes == 0 {
            0
        } else {
            (bytes as f64 / elapsed) as u64
        };
        self.sample_started = Instant::now();
        let _ = self
            .manager
            .mutate_task(&self.app, &self.task_id, |task| {
                task.transferred_bytes = task.transferred_bytes.saturating_add(bytes);
                task.completed_files = task.completed_files.saturating_add(files);
                task.speed_bytes_per_second = speed;
                if current_file.is_some() {
                    task.current_file = current_file;
                }
            })
            .await;
    }
}

fn emit_snapshot(app: &AppHandle, snapshot: &TransferTaskSnapshot) {
    if let Err(error) = app.emit(TRANSFER_EVENT, snapshot) {
        log::warn!("failed to emit transfer update: {error}");
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn task_control_resumes_and_cancels_waiters() {
        let control = Arc::new(TaskControl::new());
        control.paused.store(true, Ordering::Release);
        let waiter = {
            let control = control.clone();
            tokio::spawn(async move { control.checkpoint().await })
        };
        tokio::task::yield_now().await;
        control.paused.store(false, Ordering::Release);
        control.pause_changed.notify_one();
        assert!(waiter.await.unwrap().is_ok());

        control.paused.store(true, Ordering::Release);
        let canceled = {
            let control = control.clone();
            tokio::spawn(async move { control.checkpoint().await })
        };
        tokio::task::yield_now().await;
        control.cancellation.cancel();
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
}
