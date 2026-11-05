//! 单次原生操作的取消句柄，取消与完成串行，避免迟到请求终止后续操作。

use std::sync::Mutex;

pub const PROCESS_CANCELLED: &str = "git_operation_cancelled";
pub const PROCESS_READY: &[u8] = b"TERAX_PROCESS_READY\n";

type Stop = Box<dyn Fn() -> Result<(), String> + Send + Sync>;

#[derive(Default)]
struct State {
    stop: Option<Stop>,
    cancelled: bool,
}

/// 仅登记已具备明确进程身份的任务；终止失败不撤销句柄，允许用户重试。
#[derive(Default)]
pub struct ProcessCancellation(Mutex<State>);

impl ProcessCancellation {
    pub fn register(&self, stop: impl Fn() -> Result<(), String> + Send + Sync + 'static) {
        self.0.lock().expect("process cancellation poisoned").stop = Some(Box::new(stop));
    }

    /// 必须在阻塞线程调用；返回 false 表示尚未启动或已经完成。
    pub fn cancel(&self) -> Result<bool, String> {
        let mut state = self.0.lock().expect("process cancellation poisoned");
        let Some(stop) = &state.stop else {
            return Ok(false);
        };
        if state.cancelled {
            return Ok(true);
        }
        stop()?;
        state.cancelled = true;
        Ok(true)
    }

    /// 收回终止权限，并等待在途取消结束；返回是否确实执行过终止。
    pub fn finish(&self) -> bool {
        let mut state = self.0.lock().expect("process cancellation poisoned");
        state.stop = None;
        state.cancelled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn cancellation_failure_can_retry_and_completed_handles_cannot_stop_again() {
        let control = ProcessCancellation::default();
        assert!(!control.cancel().unwrap());
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        control.register(move || {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("transport unavailable".into())
            } else {
                Ok(())
            }
        });
        assert!(control.cancel().is_err());
        assert!(control.cancel().unwrap());
        assert!(control.cancel().unwrap());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(control.finish());
        assert!(!control.cancel().unwrap());
    }

    #[test]
    fn completion_waits_for_in_flight_termination() {
        let control = Arc::new(ProcessCancellation::default());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        control.register(move || {
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
            Ok(())
        });
        std::thread::scope(|scope| {
            let cancel = scope.spawn(|| control.cancel());
            entered_rx.recv().unwrap();
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let finishing = control.clone();
            scope.spawn(move || {
                done_tx.send(finishing.finish()).unwrap();
            });
            let completed_early = done_rx.recv_timeout(std::time::Duration::from_millis(50));
            release_tx.send(()).unwrap();
            assert!(completed_early.is_err());
            assert!(cancel.join().unwrap().unwrap());
            assert!(done_rx.recv().unwrap());
        });
    }
}
