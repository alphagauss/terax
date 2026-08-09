//! Alpha 开发源码监听与服务 revision 协调。
//!
//! 本模块仅编译进 Debug 构建，使用系统原生文件通知合并编辑器的一次保存事件，并且
//! 只协调已经运行的服务。多窗口重复事件最终由服务操作锁和锁内 revision 检查收敛。

use super::{runtime_files, service};
use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(400);
const MAX_WINDOW: Duration = Duration::from_secs(1);

/// 启动当前 Terax 进程唯一的 Alpha 开发源码监听器。
pub(super) fn start() -> Result<(), String> {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.get().is_some() {
        return Ok(());
    }

    let alpha_root = runtime_files::code_root()?.join("alpha");
    let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&alpha_root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    std::thread::Builder::new()
        .name("terax-alpha-dev-watch".into())
        .spawn(move || drain_events(watcher, receiver, alpha_root))
        .map_err(|error| error.to_string())?;
    let _ = STARTED.set(());
    Ok(())
}

/// 合并短时间内的文件事件，避免编辑器原子保存导致同一 revision 被协调多次。
fn drain_events(
    _watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<notify::Result<Event>>,
    alpha_root: PathBuf,
) {
    loop {
        let first = match receiver.recv() {
            Ok(event) => event,
            Err(_) => return,
        };
        let mut changed = event_affects_runtime(&alpha_root, first);
        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let timeout = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
            match receiver.recv_timeout(timeout) {
                Ok(event) => changed |= event_affects_runtime(&alpha_root, event),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        if !changed {
            continue;
        }
        tauri::async_runtime::spawn(async {
            if let Err(error) = service::reconcile(false).await {
                log::warn!("Alpha development reconciliation failed: {error}");
            }
        });
    }
}

/// 判断文件事件是否影响 Alpha 生产运行文件集合。
fn event_affects_runtime(alpha_root: &Path, event: notify::Result<Event>) -> bool {
    let Ok(event) = event else { return false };
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    let may_change_directory = matches!(
        event.kind,
        EventKind::Any
            | EventKind::Create(CreateKind::Any | CreateKind::Folder)
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Remove(RemoveKind::Any | RemoveKind::Folder)
    );
    event.paths.iter().any(|path| {
        runtime_files::is_development_runtime_path(alpha_root, path)
            || (may_change_directory
                && runtime_files::is_development_runtime_scope_path(alpha_root, path))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: EventKind, path: &Path) -> notify::Result<Event> {
        Ok(Event {
            kind,
            paths: vec![path.to_path_buf()],
            attrs: Default::default(),
        })
    }

    #[test]
    fn runtime_events_include_files_and_directory_removal() {
        let root = Path::new("C:/project/alpha");

        assert!(event_affects_runtime(
            root,
            event(
                EventKind::Modify(ModifyKind::Any),
                &root.join("api/routes/health.py"),
            )
        ));
        assert!(event_affects_runtime(
            root,
            event(
                EventKind::Remove(RemoveKind::Folder),
                &root.join("api/routes"),
            )
        ));
        assert!(!event_affects_runtime(
            root,
            event(EventKind::Remove(RemoveKind::Folder), &root.join("tests"),)
        ));
        assert!(!event_affects_runtime(
            root,
            event(EventKind::Modify(ModifyKind::Any), &root.join("README.md"),)
        ));
    }
}
