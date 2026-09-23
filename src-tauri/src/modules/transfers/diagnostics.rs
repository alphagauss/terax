//! Archive 性能诊断：只记录阶段和计数，不扫描文件树或输出文件路径。
//!
//! 使用本机单调时钟，每个阶段退出时只记录一条汇总；失败和取消同样会退出阶段，
//! 不代表任务成功，暂停时间也计入墙钟耗时。不向远端注入诊断脚本。

use std::time::Instant;

pub(crate) struct PhaseTimer {
    task_id: String,
    phase: &'static str,
    started: Instant,
}

impl PhaseTimer {
    pub(crate) fn new(task_id: &str, phase: &'static str) -> Self {
        Self {
            task_id: task_id.to_string(),
            phase,
            started: Instant::now(),
        }
    }
}

impl Drop for PhaseTimer {
    fn drop(&mut self) {
        log::info!(
            "TERAX_TRANSFER_PERF task={} phase={} event=exit elapsed_ms={}",
            self.task_id,
            self.phase,
            self.started.elapsed().as_millis()
        );
    }
}
