//! 文件传输进度聚合与速度采样。
//!
//! 执行器只报告字节和文件增量；本模块按固定窗口合并快照，避免逐块 IPC 和 React 更新。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::manager::{TaskControl, TransferManager, TransferRunError};
use super::models::TransferStage;

const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(200);

/// 执行器共享的任务控制和节流进度上下文。
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
            pending_files: 0,
            pending_current_file: None,
            sample_started: Instant::now(),
        }
    }

    /// 等待暂停结束或返回取消信号。
    pub(crate) async fn checkpoint(&self) -> Result<(), TransferRunError> {
        self.control.checkpoint().await
    }

    /// 返回阻塞归档读写使用的任务控制句柄。
    pub(crate) fn control(&self) -> Arc<TaskControl> {
        self.control.clone()
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

    /// Archive 完成打包后把字节进度切换为实际单流归档大小。
    pub(crate) async fn set_archive_size(&mut self, total_bytes: u64) {
        self.flush_progress().await;
        let _ = self
            .manager
            .mutate_task(&self.app, &self.task_id, |task| {
                task.total_bytes = total_bytes;
                task.transferred_bytes = 0;
                task.speed_bytes_per_second = 0;
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

    /// 在任务进入终态前提交尚未达到节流窗口的最后一批进度。
    pub(crate) async fn flush_pending(&mut self) {
        self.flush_progress().await;
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
