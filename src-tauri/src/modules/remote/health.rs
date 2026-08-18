//! SSH transport 的进程级健康状态与 RTT 快照。
//!
//! 所有 channel 共享最近入站活动和失败信号；只有统一监督器可以主动发送健康探测。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio_util::sync::CancellationToken;

use super::models::SshHealthSnapshot;

const NO_RTT: u64 = u64::MAX;

/// 一条 SSH transport 的单调健康状态。
pub(crate) struct SshTransportHealth {
    origin: Instant,
    last_inbound_ms: AtomicU64,
    last_probe_ms: AtomicU64,
    rtt_ms: AtomicU64,
    sampled_at_ms: AtomicU64,
    failed: AtomicBool,
    failure: CancellationToken,
}

impl SshTransportHealth {
    /// 创建尚未取得 RTT 样本的新 transport 健康状态。
    pub(crate) fn new() -> Self {
        Self {
            origin: Instant::now(),
            last_inbound_ms: AtomicU64::new(0),
            last_probe_ms: AtomicU64::new(0),
            rtt_ms: AtomicU64::new(NO_RTT),
            sampled_at_ms: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            failure: CancellationToken::new(),
        }
    }

    /// 记录 transport 收到的有效字节，使业务通信可以替代重复保活。
    pub(crate) fn record_inbound(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.last_inbound_ms
            .store(self.elapsed_ms(), Ordering::Release);
    }

    /// 记录一次成功 SSH ping，并发布供状态栏展示的往返时间。
    pub(crate) fn record_probe(&self, elapsed: Duration) {
        let now = self.elapsed_ms();
        self.last_probe_ms.store(now, Ordering::Release);
        self.rtt_ms.store(
            elapsed.as_millis().max(1).min(u128::from(u64::MAX)) as u64,
            Ordering::Release,
        );
        self.sampled_at_ms.store(unix_time_ms(), Ordering::Release);
    }

    /// 判断近期业务流量或健康探测是否已经证明 transport 可用。
    pub(crate) fn is_fresh(&self, max_age: Duration) -> bool {
        if self.is_failed() {
            return false;
        }
        let latest = self
            .last_inbound_ms
            .load(Ordering::Acquire)
            .max(self.last_probe_ms.load(Ordering::Acquire));
        self.elapsed_ms().saturating_sub(latest) < duration_ms(max_age)
    }

    /// 判断是否需要为空闲保活或状态栏 RTT 采样发送一次 ping。
    pub(crate) fn probe_due(&self, idle_age: Duration, max_rtt_age: Duration) -> bool {
        if self.is_failed() || !self.is_fresh(idle_age) {
            return true;
        }
        let rtt = self.rtt_ms.load(Ordering::Acquire);
        if rtt == NO_RTT {
            return true;
        }
        self.elapsed_ms()
            .saturating_sub(self.last_probe_ms.load(Ordering::Acquire))
            >= duration_ms(max_rtt_age)
    }

    /// 永久标记当前 transport 失效，并唤醒唯一的重连监督器。
    pub(crate) fn mark_failed(&self) {
        if !self.failed.swap(true, Ordering::AcqRel) {
            self.failure.cancel();
        }
    }

    pub(crate) fn is_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    /// 等待 transport 被底层事件或业务错误确认失效。
    pub(crate) async fn failed(&self) {
        self.failure.cancelled().await;
    }

    /// 返回与指定 Runtime epoch 绑定的只读 RTT 快照。
    pub(crate) fn snapshot(&self, epoch: u64) -> SshHealthSnapshot {
        let rtt = self.rtt_ms.load(Ordering::Acquire);
        SshHealthSnapshot {
            epoch: Some(epoch),
            rtt_ms: (rtt != NO_RTT).then_some(rtt),
            sampled_at: (rtt != NO_RTT).then(|| self.sampled_at_ms.load(Ordering::Acquire)),
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.origin.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn business_inbound_activity_suppresses_idle_probe() {
        let health = SshTransportHealth::new();
        health.record_probe(Duration::from_millis(100));
        health.record_inbound(16);

        assert!(health.is_fresh(Duration::from_secs(1)));
        assert!(!health.probe_due(Duration::from_secs(1), Duration::from_secs(60)));
    }

    #[test]
    fn successful_probe_produces_epoch_bound_rtt_snapshot() {
        let health = SshTransportHealth::new();
        health.record_probe(Duration::from_millis(268));

        let snapshot = health.snapshot(7);
        assert_eq!(snapshot.epoch, Some(7));
        assert_eq!(snapshot.rtt_ms, Some(268));
        assert!(snapshot.sampled_at.is_some());
    }

    #[tokio::test]
    async fn failure_signal_wakes_waiters_once() {
        let health = std::sync::Arc::new(SshTransportHealth::new());
        let waiter = tokio::spawn({
            let health = health.clone();
            async move { health.failed().await }
        });

        health.mark_failed();
        health.mark_failed();

        tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .unwrap()
            .unwrap();
    }
}
