//! 文件传输的运行许可与目标 reservation。
//!
//! Scheduler 只管理可运行性和进程内目标冲突，不持有任务快照。暂停任务在取得
//! 许可前保持等待，已运行任务则在安全检查点协作暂停。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::errors::TransferErrorCode;
use super::manager::{TaskControl, TransferRunError};

/// 统一管理传输并发和当前进程正在写入的最终目标。
pub(crate) struct TransferScheduler {
    permits: Arc<Semaphore>,
    reserved_targets: Arc<Mutex<HashSet<String>>>,
}

impl TransferScheduler {
    /// 创建具有固定运行上限的调度器。
    pub(crate) fn new(concurrency: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(concurrency.max(1))),
            reserved_targets: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 等待任务可运行并取得许可，暂停中的排队任务不会占用许可。
    pub(crate) async fn acquire(
        &self,
        control: &TaskControl,
    ) -> Result<OwnedSemaphorePermit, TransferRunError> {
        loop {
            control.checkpoint().await?;
            tokio::select! {
                permit = self.permits.clone().acquire_owned() => {
                    let permit = permit.map_err(|_| {
                        TransferRunError::failed(
                            TransferErrorCode::Internal,
                            "transfer scheduler is closed",
                        )
                    })?;
                    if control.is_paused() {
                        drop(permit);
                        continue;
                    }
                    control.checkpoint().await?;
                    return Ok(permit);
                }
                changed = control.wait_for_change() => {
                    changed?;
                }
            }
        }
    }

    /// 原子保留计划中的全部最终目标，任一冲突都会拒绝整个任务。
    pub(crate) fn reserve(
        &self,
        targets: Vec<String>,
    ) -> Result<TargetReservation, TransferRunError> {
        let mut reserved = self
            .reserved_targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(target) = targets.iter().find(|target| reserved.contains(*target)) {
            return Err(TransferRunError::failed(
                TransferErrorCode::DestinationBusy,
                format!("another transfer is already writing to {target}"),
            ));
        }
        reserved.extend(targets.iter().cloned());
        Ok(TargetReservation {
            targets,
            reserved: self.reserved_targets.clone(),
        })
    }
}

/// 在任务结束或失败时自动释放进程内目标 reservation。
pub(crate) struct TargetReservation {
    targets: Vec<String>,
    reserved: Arc<Mutex<HashSet<String>>>,
}

impl Drop for TargetReservation {
    fn drop(&mut self) {
        let mut reserved = self
            .reserved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for target in &self.targets {
            reserved.remove(target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paused_queued_task_does_not_hold_a_permit() {
        let scheduler = Arc::new(TransferScheduler::new(1));
        let running_control = TaskControl::new();
        let running_permit = scheduler.acquire(&running_control).await.unwrap();

        let paused_control = Arc::new(TaskControl::new());
        paused_control.pause();
        let paused_waiter = {
            let scheduler = scheduler.clone();
            let control = paused_control.clone();
            tokio::spawn(async move { scheduler.acquire(&control).await })
        };
        tokio::task::yield_now().await;
        drop(running_permit);

        let active_control = TaskControl::new();
        let active_permit = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            scheduler.acquire(&active_control),
        )
        .await
        .expect("active task did not receive the available permit")
        .unwrap();
        drop(active_permit);

        paused_control.cancel();
        assert!(matches!(
            paused_waiter.await.unwrap(),
            Err(TransferRunError::Canceled)
        ));
    }

    #[test]
    fn reservations_are_all_or_nothing_and_release_on_drop() {
        let scheduler = TransferScheduler::new(2);
        let first = scheduler
            .reserve(vec!["local:/a".into(), "local:/b".into()])
            .unwrap();
        assert!(scheduler.reserve(vec!["local:/b".into()]).is_err());
        assert!(scheduler.reserve(vec!["local:/c".into()]).is_ok());
        drop(first);
        assert!(scheduler.reserve(vec!["local:/a".into()]).is_ok());
    }
}
