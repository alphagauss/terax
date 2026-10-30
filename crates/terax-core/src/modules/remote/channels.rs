//! 当前 transport 的 session 准入、占用账本与压力诊断。
//!
//! 只在收到服务端关闭确认后归还额度。打开请求独立完成，调用方取消时关闭迟到的
//! channel；业务不持有账本锁进行网络 I/O，转发 channel 不计入 session 预算。

use std::collections::{HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::{client::Msg, Channel};
use tokio::sync::{oneshot, Notify};

use super::session::RemoteWorkspace;

pub(crate) const RESOURCE_BUSY: &str = "ssh_session_capacity_busy";
const WAIT_LIMIT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct Entry {
    purpose: &'static str,
    started: Instant,
    task: Option<Arc<str>>,
    request: u64,
}

struct State {
    budget: usize,
    opening: usize,
    probing: bool,
    probe_rejected: bool,
    closed: bool,
    active: HashMap<u32, Entry>,
    early_closed: HashSet<u32>,
    transfer: Option<Arc<str>>,
    transfer_opening: usize,
    blocked_until_close: bool,
    last_pressure: Option<Instant>,
    close_revision: u64,
}

impl State {
    fn occupants(&self) -> Vec<String> {
        self.active
            .iter()
            .map(|(id, entry)| {
                format!(
                    "channel={id} request={} purpose={} task={:?} age_ms={}",
                    entry.request,
                    entry.purpose,
                    entry.task,
                    entry.started.elapsed().as_millis()
                )
            })
            .collect()
    }
}

tokio::task_local! {
    static TRANSFER: (Arc<SessionChannels>, Arc<str>);
    static TRANSFER_CANCELLATION: tokio_util::sync::CancellationToken;
}

/// 一条连接的共享 session 账本，等待不占 channel。
pub(crate) struct SessionChannels {
    pub(crate) connection: uuid::Uuid,
    next_request: AtomicU64,
    state: Mutex<State>,
    changed: Notify,
}

impl Default for SessionChannels {
    fn default() -> Self {
        Self {
            connection: uuid::Uuid::new_v4(),
            next_request: AtomicU64::new(1),
            state: Mutex::new(State {
                budget: 10,
                opening: 0,
                probing: false,
                probe_rejected: false,
                closed: false,
                active: HashMap::new(),
                early_closed: HashSet::new(),
                transfer: None,
                transfer_opening: 0,
                blocked_until_close: false,
                last_pressure: None,
                close_revision: 0,
            }),
            changed: Notify::new(),
        }
    }
}

impl SessionChannels {
    fn reserve(self: &Arc<Self>) -> Result<Option<Opening>, String> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err("SSH transport closed".into());
        }
        if state.blocked_until_close {
            return Ok(None);
        }
        let task = TRANSFER
            .try_with(|(channels, task)| Arc::ptr_eq(channels, self).then(|| task.clone()))
            .ok()
            .flatten();
        let transfer_used = state
            .active
            .values()
            .filter(|entry| same_transfer(&entry.task, &state.transfer))
            .count()
            + state.transfer_opening;
        let reserved = if state.transfer.is_some() {
            2usize.saturating_sub(transfer_used)
        } else {
            0
        };
        if same_transfer(&task, &state.transfer) && transfer_used >= 2 {
            return Ok(None);
        }
        let allocated = state.active.len() + state.opening;
        // 预留空间不是已验证的服务器占用，不能借试探之名挤占传输所需额度。
        if task.is_none() && reserved > 0 && allocated + reserved >= state.budget {
            return Ok(None);
        }
        let probe = allocated >= state.budget;
        if probe && (state.probing || state.probe_rejected) {
            return Ok(None);
        }
        state.opening += 1;
        if task.is_some() {
            state.transfer_opening += 1;
        }
        state.probing |= probe;
        Ok(Some(Opening {
            channels: self.clone(),
            probe,
            task,
        }))
    }

    /// 打开 session；额度不足时回收空闲缓存并等待，服务器拒绝后最多重试一次。
    pub(crate) async fn open(
        self: &Arc<Self>,
        workspace: &RemoteWorkspace,
        purpose: &'static str,
    ) -> Result<SessionChannel, String> {
        if TRANSFER
            .try_with(|(channels, _)| !Arc::ptr_eq(channels, self))
            .unwrap_or(false)
        {
            return Err("SSH transfer transport changed".into());
        }
        let cancellation = TRANSFER_CANCELLATION
            .try_with(Clone::clone)
            .unwrap_or_default();
        let connection = self.connection;
        let request = self.next_request.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + WAIT_LIMIT;
        let mut retried = false;
        let mut waiting = false;
        let mut reclaim_requested = None;
        let mut cache_closing = None;
        loop {
            if cancellation.is_cancelled() {
                return Err(super::session::EXEC_CANCELLED_ERROR.into());
            }
            if tokio::time::Instant::now() >= deadline {
                let state = self.state.lock().unwrap();
                log::warn!("SSH_SESSION event=wait_timeout connection={connection} request={request} epoch={} purpose={purpose} budget={} active={} occupants={:?}", workspace.epoch(), state.budget, state.active.len(), state.occupants());
                return Err(RESOURCE_BUSY.into());
            }
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(opening) = self.reserve()? {
                let handle = workspace.handle.clone();
                let channels = self.clone();
                let epoch = workspace.epoch();
                let (send, receive) = oneshot::channel();
                // 调用方取消不能丢弃尚未得到响应的 SSH_OPEN 请求。
                tokio::spawn(async move {
                    let result = handle.channel_open_session().await;
                    let result = match result {
                        Ok(channel) => {
                            channels.register(
                                channel.id().into(),
                                purpose,
                                opening.probe,
                                epoch,
                                opening.task.clone(),
                                request,
                            );
                            Ok(SessionChannel(Some(channel)))
                        }
                        Err(error) => {
                            let mut state = channels.state.lock().unwrap();
                            let capacity = matches!(
                                error,
                                russh::Error::ChannelOpenFailure(
                                    russh::ChannelOpenFailure::ConnectFailed
                                        | russh::ChannelOpenFailure::ResourceShortage
                                )
                            );
                            if capacity {
                                state.probe_rejected = true;
                                state.blocked_until_close = !state.active.is_empty();
                            }
                            log::warn!("SSH_SESSION event=rejected connection={connection} request={request} epoch={epoch} purpose={purpose} budget={} active={} opening={} error={error:?} occupants={:?}", state.budget, state.active.len(), state.opening, state.occupants());
                            Err((format!("open SSH {purpose} channel: {error}"), capacity))
                        }
                    };
                    drop(opening);
                    let _ = send.send(result);
                });
                let response = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(super::session::EXEC_CANCELLED_ERROR.into()),
                    response = tokio::time::timeout_at(deadline, receive) => response,
                };
                let result = response
                    .map_err(|_| RESOURCE_BUSY.to_string())?
                    .map_err(|_| "SSH session opener stopped".to_string())?;
                match result {
                    Ok(channel) => {
                        if waiting {
                            log::info!("SSH_SESSION event=ready connection={connection} request={request} epoch={} purpose={purpose} wait_ms={}", workspace.epoch(), started.elapsed().as_millis());
                        }
                        return Ok(channel);
                    }
                    Err((error, capacity)) => {
                        if !capacity || workspace.is_closed() {
                            return Err(error);
                        }
                        if retried {
                            return Err(format!("{RESOURCE_BUSY}: {error}"));
                        }
                        retried = true;
                        if self.state.lock().unwrap().active.is_empty() {
                            return Err(error);
                        }
                        let revision = self.state.lock().unwrap().close_revision;
                        if workspace.remote_fs.reclaim_idle().await {
                            cache_closing = Some(revision);
                        }
                    }
                }
            } else {
                let revision = self.state.lock().unwrap().close_revision;
                if workspace.remote_fs.reclaim_idle().await {
                    cache_closing = Some(revision);
                }
            }
            if !waiting {
                waiting = true;
                log::info!("SSH_SESSION event=waiting connection={connection} request={request} epoch={} purpose={purpose}", workspace.epoch());
            }
            let revision = self.state.lock().unwrap().close_revision;
            if reclaim_requested != Some(revision)
                && cache_closing != Some(revision)
                && started.elapsed() >= Duration::from_secs(1)
                && workspace.request_session_reclaim()
            {
                reclaim_requested = Some(revision);
            }
            // 空闲使用者释放 Arc 不产生协议事件，短周期仅检查本地缓存，不发远端请求。
            let wake = tokio::time::sleep(Duration::from_millis(100));
            tokio::select! {
                _ = cancellation.cancelled() => return Err(super::session::EXEC_CANCELLED_ERROR.into()),
                _ = &mut changed => {},
                _ = wake => {},
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    fn register(
        &self,
        id: u32,
        purpose: &'static str,
        probe: bool,
        epoch: u64,
        task: Option<Arc<str>>,
        request: u64,
    ) {
        let connection = self.connection;
        let mut state = self.state.lock().unwrap();
        if probe {
            state.budget += 1;
        }
        if !state.closed && !state.early_closed.remove(&id) {
            state.active.insert(
                id,
                Entry {
                    purpose,
                    started: Instant::now(),
                    task: task.clone(),
                    request,
                },
            );
        }
        log::info!("SSH_SESSION event=opened connection={connection} request={request} epoch={epoch} channel={id} purpose={purpose} task={task:?} probe={probe} budget={} active={}", state.budget, state.active.len());
    }

    /// 传输在扫描前预留两个并发 session，元数据与数据或命令共存，避免持有后再争抢。
    pub(crate) async fn transfer_scope<T>(
        self: &Arc<Self>,
        workspace: &RemoteWorkspace,
        task: String,
        cancellation: &tokio_util::sync::CancellationToken,
        work: impl std::future::Future<Output = T>,
    ) -> Result<T, String> {
        // 每次执行有独立身份，同一任务重试不能与取消后迟到的申请混用额度。
        let task: Arc<str> = task.into();
        let deadline = tokio::time::Instant::now() + WAIT_LIMIT;
        let started = Instant::now();
        let mut reclaim_requested = None;
        let mut cache_closing = None;
        log::info!(
            "SSH_SESSION event=wait_transfer connection={} epoch={} task={task}",
            self.connection,
            workspace.epoch()
        );
        loop {
            {
                let mut state = self.state.lock().unwrap();
                if state.closed {
                    return Err("SSH transport closed".into());
                }
                if state.transfer.is_none()
                    && (state.active.len() + state.opening + 2 <= state.budget
                        || !state.probe_rejected)
                {
                    state.transfer = Some(task.clone());
                    break;
                }
            }
            let revision = self.state.lock().unwrap().close_revision;
            if workspace.remote_fs.reclaim_idle().await {
                cache_closing = Some(revision);
            }
            let revision = self.state.lock().unwrap().close_revision;
            if reclaim_requested != Some(revision)
                && cache_closing != Some(revision)
                && started.elapsed() >= Duration::from_secs(1)
                && workspace.request_session_reclaim()
            {
                reclaim_requested = Some(revision);
            }
            if tokio::time::Instant::now() >= deadline {
                let state = self.state.lock().unwrap();
                log::warn!("SSH_SESSION event=transfer_wait_timeout connection={} epoch={} task={task} occupants={:?}", self.connection, workspace.epoch(), state.occupants());
                return Err(RESOURCE_BUSY.into());
            }
            tokio::select! {
                _ = cancellation.cancelled() => return Err("transfer cancelled".into()),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
        let _reservation = TransferReservation(self.clone());
        log::info!(
            "SSH_SESSION event=reserve_transfer epoch={} task={task} slots=2",
            workspace.epoch()
        );
        Ok(TRANSFER_CANCELLATION
            .scope(
                cancellation.clone(),
                TRANSFER.scope((self.clone(), task), work),
            )
            .await)
    }

    pub(crate) fn closed(&self, id: u32) {
        let connection = self.connection;
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.active.remove(&id) {
            state.close_revision += 1;
            state.blocked_until_close = false;
            log::info!("SSH_SESSION event=closed connection={connection} channel={id} request={} purpose={} lifetime_ms={} active={}", entry.request, entry.purpose, entry.started.elapsed().as_millis(), state.active.len());
        } else if state.opening > 0 {
            state.early_closed.insert(id);
        }
        self.changed.notify_waiters();
    }

    /// 多个等待者共享一个回收请求，避免一次压力事件关闭多余终端。
    pub(crate) fn request_reclaim(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if state
            .last_pressure
            .is_some_and(|last| last.elapsed() < Duration::from_secs(2))
        {
            return false;
        }
        state.last_pressure = Some(Instant::now());
        true
    }

    pub(crate) fn disconnect(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.active.clear();
        state.early_closed.clear();
        self.changed.notify_waiters();
    }
}

fn same_transfer(left: &Option<Arc<str>>, right: &Option<Arc<str>>) -> bool {
    matches!((left, right), (Some(left), Some(right)) if Arc::ptr_eq(left, right))
}

struct Opening {
    channels: Arc<SessionChannels>,
    probe: bool,
    task: Option<Arc<str>>,
}

impl Drop for Opening {
    fn drop(&mut self) {
        let mut state = self.channels.state.lock().unwrap();
        state.opening -= 1;
        if same_transfer(&self.task, &state.transfer) {
            state.transfer_opening -= 1;
        }
        if self.probe {
            state.probing = false;
        }
        if state.opening == 0 {
            state.early_closed.clear();
        }
        self.channels.changed.notify_waiters();
    }
}

struct TransferReservation(Arc<SessionChannels>);
impl Drop for TransferReservation {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        log::info!(
            "SSH_SESSION event=release_transfer task={:?}",
            state.transfer
        );
        state.transfer = None;
        // 迟到的旧任务申请仍计入总 opening，但不占下一项任务的预留额度。
        state.transfer_opening = 0;
        self.0.changed.notify_waiters();
    }
}

/// 尚未移交给 stream 或终端桥接的 channel 在错误、取消时自动关闭。
pub(crate) struct SessionChannel(Option<Channel<Msg>>);

impl Deref for SessionChannel {
    type Target = Channel<Msg>;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}

impl DerefMut for SessionChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().unwrap()
    }
}

impl SessionChannel {
    pub(crate) fn into_stream(mut self) -> russh::ChannelStream<Msg> {
        self.0.take().unwrap().into_stream()
    }

    pub(crate) fn split(mut self) -> (russh::ChannelReadHalf, russh::ChannelWriteHalf<Msg>) {
        self.0.take().unwrap().split()
    }
}

impl Drop for SessionChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                let _ = channel.close().await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occupy(channels: &Arc<SessionChannels>, id: u32) {
        let opening = channels.reserve().unwrap().unwrap();
        channels.register(id, "test", opening.probe, 1, opening.task.clone(), 0);
        drop(opening);
    }

    #[test]
    fn concurrent_openings_allow_only_one_probe_and_close_releases_capacity() {
        let channels = Arc::new(SessionChannels::default());
        for id in 0..10 {
            occupy(&channels, id);
        }
        let probe = channels.reserve().unwrap().unwrap();
        assert!(probe.probe);
        assert!(channels.reserve().unwrap().is_none());
        channels.register(10, "test", true, 1, None, 0);
        drop(probe);
        assert_eq!(channels.state.lock().unwrap().budget, 11);
        channels.state.lock().unwrap().probe_rejected = true;
        assert!(channels.reserve().unwrap().is_none());
        channels.closed(4);
        assert!(!channels.reserve().unwrap().unwrap().probe);
    }

    #[test]
    fn cancelled_opening_and_close_before_registration_do_not_leak() {
        let channels = Arc::new(SessionChannels::default());
        let opening = channels.reserve().unwrap().unwrap();
        channels.closed(42);
        channels.register(42, "test", false, 1, None, 0);
        drop(opening);
        let state = channels.state.lock().unwrap();
        assert!(state.active.is_empty());
        assert!(state.early_closed.is_empty());
        assert_eq!(state.opening, 0);
    }

    #[test]
    fn rejected_openings_wait_for_actual_server_close() {
        let channels = Arc::new(SessionChannels::default());
        occupy(&channels, 1);
        channels.state.lock().unwrap().blocked_until_close = true;
        assert!(channels.reserve().unwrap().is_none());
        channels.closed(999);
        assert!(channels.reserve().unwrap().is_none());
        channels.closed(1);
        assert!(channels.reserve().unwrap().is_some());
        channels.disconnect();
        assert!(channels.reserve().is_err());
    }

    #[tokio::test]
    async fn cancelled_transfer_opening_does_not_consume_next_tasks_reservation() {
        let channels = Arc::new(SessionChannels::default());
        let old_task: Arc<str> = "download".into();
        channels.state.lock().unwrap().transfer = Some(old_task.clone());
        let reservation = TransferReservation(channels.clone());
        let old = TRANSFER
            .scope((channels.clone(), old_task), async {
                channels.reserve().unwrap().unwrap()
            })
            .await;
        drop(reservation);
        let next_task: Arc<str> = "download".into();
        channels.state.lock().unwrap().transfer = Some(next_task.clone());
        TRANSFER
            .scope((channels.clone(), next_task), async {
                let first = channels.reserve().unwrap().unwrap();
                let second = channels.reserve().unwrap().unwrap();
                assert!(channels.reserve().unwrap().is_none());
                channels.register(42, "test", false, 1, old.task.clone(), 0);
                drop(old);
                assert_eq!(channels.state.lock().unwrap().transfer_opening, 2);
                drop(first);
                let replacement = channels.reserve().unwrap().unwrap();
                drop((replacement, second));
                channels.closed(42);
            })
            .await;
        assert_eq!(channels.state.lock().unwrap().opening, 0);
    }

    #[tokio::test]
    async fn transfer_reservation_survives_competing_file_checks() {
        let channels = Arc::new(SessionChannels::default());
        // 三个终端、两个缓存，再加三个检查，占用八个额度。
        for id in 0..8 {
            occupy(&channels, id);
        }
        let task: Arc<str> = "download".into();
        channels.state.lock().unwrap().transfer = Some(task.clone());
        let reservation = TransferReservation(channels.clone());
        assert!(channels.reserve().unwrap().is_none());
        TRANSFER
            .scope((channels.clone(), task), async {
                occupy(&channels, 8);
                occupy(&channels, 9);
                assert!(channels.reserve().unwrap().is_none());
                channels.closed(9);
                occupy(&channels, 10);
            })
            .await;
        drop(reservation);
        assert_eq!(channels.state.lock().unwrap().active.len(), 10);
        channels.closed(8);
        channels.closed(10);
        assert_eq!(channels.state.lock().unwrap().active.len(), 8);
    }
}
