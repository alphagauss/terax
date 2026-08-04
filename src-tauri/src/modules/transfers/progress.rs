//! 文件传输进度聚合与速度采样。
//!
//! 执行器按固定窗口合并字节进度，避免逐块 IPC 和 React 更新；已提交根与文件数量
//! 在不可回滚的发布边界同步写入 Journal。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::manager::{TaskControl, TransferManager, TransferRunError};
use super::models::{
    TransferConflict, TransferConflictDecision, TransferFileFailure, TransferStage,
};

const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(200);

/// 执行器共享的任务控制和节流进度上下文。
pub(crate) struct ExecutionContext {
    manager: Arc<TransferManager>,
    app: AppHandle,
    task_id: String,
    control: Arc<TaskControl>,
    pending_bytes: u64,
    pending_current_file: Option<String>,
    committed_roots: u64,
    file_retry: bool,
    sample_started: Instant,
}

impl ExecutionContext {
    /// 创建一个绑定任务状态与控制信号的执行上下文。
    pub(crate) fn new(
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
            pending_current_file: None,
            committed_roots: 0,
            file_retry: false,
            sample_started: Instant::now(),
        }
    }

    /// 创建复用原文件夹任务行的单文件重试上下文。
    ///
    /// 重试仍报告阶段、冲突和当前文件，但不会覆盖原任务的总量或重复累计字节。
    pub(crate) fn new_file_retry(
        manager: Arc<TransferManager>,
        app: AppHandle,
        task_id: String,
        control: Arc<TaskControl>,
    ) -> Self {
        let mut context = Self::new(manager, app, task_id, control);
        context.file_retry = true;
        context
    }

    /// 等待暂停结束或返回取消信号。
    pub(crate) async fn checkpoint(&self) -> Result<(), TransferRunError> {
        self.control.checkpoint().await
    }

    /// 返回阻塞归档读写使用的任务控制句柄。
    pub(crate) fn control(&self) -> Arc<TaskControl> {
        self.control.clone()
    }

    /// 返回接收状态更新和历史清理约束的聚合任务 ID。
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }

    /// 发布冲突并等待与冲突 ID 严格匹配的用户决策。
    pub(crate) async fn request_conflict(
        &mut self,
        conflict: TransferConflict,
    ) -> Result<super::manager::ConflictResolution, TransferRunError> {
        self.flush_progress().await;
        let conflict_id = conflict.id.clone();
        self.control.begin_conflict(conflict_id.clone()).await?;
        if let Err(error) = self
            .manager
            .begin_conflict(&self.app, &self.task_id, conflict)
            .await
        {
            self.control.clear_conflict(&conflict_id).await;
            return Err(error);
        }
        let resolution = self.control.wait_for_conflict(&conflict_id).await;
        self.control.clear_conflict(&conflict_id).await;
        let resume = resolution
            .as_ref()
            .is_ok_and(|resolution| resolution.decision != TransferConflictDecision::Cancel);
        self.manager
            .end_conflict(&self.app, &self.task_id, resume)
            .await?;
        resolution
    }

    /// 记录一个已经隔离且不会阻止其余 Direct 文件继续执行的失败。
    pub(crate) async fn record_file_failure(
        &mut self,
        failure: TransferFileFailure,
    ) -> Result<(), TransferRunError> {
        self.flush_progress().await;
        self.manager
            .record_file_failure(&self.app, &self.task_id, failure)
            .await
    }

    /// 在规划期记录已确认是文件的来源元数据失败，此时还没有待刷新的复制进度。
    pub(crate) async fn record_scan_failure(
        &self,
        failure: TransferFileFailure,
    ) -> Result<(), TransferRunError> {
        self.manager
            .record_file_failure(&self.app, &self.task_id, failure)
            .await
    }

    /// 设置任务阶段并保留暂停状态。
    pub(crate) async fn set_stage(&mut self, stage: TransferStage) {
        self.flush_progress().await;
        self.manager
            .set_stage(&self.app, &self.task_id, stage)
            .await;
    }

    /// 在公开 staging 前同步写入提交意图，持久化失败会阻止破坏性操作。
    pub(crate) async fn begin_finalizing(&mut self) -> Result<(), TransferRunError> {
        self.flush_progress().await;
        self.manager
            .begin_finalizing(&self.app, &self.task_id)
            .await
    }

    /// 在扫描完成后发布稳定的文件数和总字节数。
    pub(crate) async fn set_totals(
        &self,
        total_files: u64,
        total_bytes: u64,
        total_roots: u64,
        is_directory: bool,
    ) -> Result<(), TransferRunError> {
        if self.file_retry {
            return Ok(());
        }
        self.manager
            .set_totals(
                &self.app,
                &self.task_id,
                total_files,
                total_bytes,
                total_roots,
                is_directory,
            )
            .await
    }

    /// 同步记录已经公开且后续失败也不会回滚的顶层项目。
    ///
    /// Direct 每次传入一个根；Archive 的多根事务必须一次传入全部根，避免恢复时
    /// 形成实际上不可能存在的部分提交状态。
    pub(crate) async fn roots_committed(
        &mut self,
        roots: u64,
        files: u64,
    ) -> Result<(), TransferRunError> {
        self.committed_roots = self.committed_roots.saturating_add(roots);
        if self.file_retry {
            return Ok(());
        }
        let committed_roots = self.committed_roots;
        self.manager
            .set_committed_progress(&self.app, &self.task_id, committed_roots, files)
            .await
    }

    /// 返回任务是否已经产生不可回滚的最终输出。
    pub(crate) fn has_committed_roots(&self) -> bool {
        self.committed_roots > 0
    }

    /// Archive 完成打包后把字节进度切换为实际单流归档大小。
    pub(crate) async fn set_archive_size(
        &mut self,
        total_bytes: u64,
    ) -> Result<(), TransferRunError> {
        self.flush_progress().await;
        self.manager
            .set_archive_size(&self.app, &self.task_id, total_bytes)
            .await
    }

    /// 聚合当前处理路径，前端展示时仅截取 basename。
    pub(crate) async fn set_current_file(&mut self, path: String) {
        self.pending_current_file = Some(path);
        if self.sample_started.elapsed() >= PROGRESS_EVENT_INTERVAL {
            self.flush_progress().await;
        }
    }

    /// Archive 在不预扫描子树时，打包或安全解包完成后再发布实际文件总数。
    pub(crate) async fn set_archive_file_count(
        &self,
        total_files: u64,
    ) -> Result<(), TransferRunError> {
        self.manager
            .set_archive_file_count(&self.app, &self.task_id, total_files)
            .await
    }

    /// 聚合字节增量，并以固定频率更新前端快照。
    pub(crate) async fn report_bytes(&mut self, bytes: u64) {
        if self.file_retry {
            return;
        }
        self.pending_bytes = self.pending_bytes.saturating_add(bytes);
        if self.sample_started.elapsed() >= PROGRESS_EVENT_INTERVAL {
            self.flush_progress().await;
        }
    }

    /// 在任务进入终态前提交尚未达到节流窗口的最后一批进度。
    pub(crate) async fn flush_pending(&mut self) {
        self.flush_progress().await;
    }

    /// 一次性提交节流窗口内累计的字节、文件数与当前文件。
    async fn flush_progress(&mut self) {
        if self.pending_bytes == 0 && self.pending_current_file.is_none() {
            self.sample_started = Instant::now();
            return;
        }
        let elapsed = self.sample_started.elapsed().as_secs_f64().max(0.001);
        let bytes = std::mem::take(&mut self.pending_bytes);
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
                task.speed_bytes_per_second = speed;
                if current_file.is_some() {
                    task.current_file = current_file;
                }
            })
            .await;
    }
}
