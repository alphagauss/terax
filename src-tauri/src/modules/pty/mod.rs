mod activity;
mod agent_detect;
mod da_filter;
mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};

use crate::modules::remote::{self, RemoteState};
use crate::modules::workspace::{user_spawn_cwd_or_home, WorkspaceEnv, WorkspaceRegistry};
use session::Session;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    remote_sessions: RwLock<HashMap<u32, Arc<remote::terminal::RemoteTerminalHandle>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            remote_sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl PtyState {
    pub(super) fn take(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.write().unwrap().remove(&id)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    remote: tauri::State<'_, RemoteState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let blocks = blocks.unwrap_or(false);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    if let WorkspaceEnv::Ssh { profile_id } = &workspace {
        let remote_workspace = remote.manager.workspace(profile_id).await?;
        let prepared = remote
            .manager
            .take_prepared_terminal(profile_id, cwd.as_deref(), blocks)
            .await;
        if prepared.is_none() && remote.manager.should_gate_background_terminal() {
            remote_workspace.wait_for_foreground_filesystem().await;
        }
        let session = match prepared {
            Some(prepared) => {
                remote::terminal::attach_prepared(
                    remote_workspace,
                    prepared,
                    cols,
                    rows,
                    on_data,
                    on_exit,
                )
                .await?
            }
            None => {
                remote::terminal::open(remote_workspace, cols, rows, cwd, blocks, on_data, on_exit)
                    .await?
            }
        };
        state
            .remote_sessions
            .write()
            .unwrap()
            .insert(id, Arc::new(session));
        log::info!("remote PTY opened id={id} profile={profile_id} cols={cols} rows={rows}");
        return Ok(id);
    }
    let cwd = user_spawn_cwd_or_home(&registry, cwd.as_deref(), &workspace);
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(
            id, app, cols, rows, cwd, workspace, blocks, shell, on_data, on_exit,
        )
        .map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    // The shell can exit before this insert (instant failure, `exit` in an rc
    // file); the waiter's reap then ran with the id absent. Re-check and reap
    // so the pseudoconsole isn't stranded.
    let exited = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.exited.load(Ordering::Acquire))
        .unwrap_or(false);
    if exited {
        if let Some(s) = state.take(id) {
            thread::Builder::new()
                .name(format!("terax-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
    }
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

// Input is the latency-critical path: raw body + id header skips JSON
// serialization of every keystroke on both sides of the IPC boundary.
#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pty_write: expected raw body".to_string());
    };
    if bytes.len() > 1024 * 1024 {
        return Err("pty_write: input chunk exceeds 1 MiB".to_string());
    }
    let session = state.sessions.read().unwrap().get(&id).cloned();
    if session.is_none() {
        let remote = state
            .remote_sessions
            .read()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                log::warn!("pty_write: unknown id={id}");
                "no session".to_string()
            })?;
        return remote.write(bytes.to_vec()).await;
    }
    let session = session.expect("checked above");
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(bytes)
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state.sessions.read().unwrap().get(&id).cloned();
    if session.is_none() {
        let remote = state
            .remote_sessions
            .read()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                log::warn!("pty_resize: unknown id={id}");
                "no session".to_string()
            })?;
        return remote.resize(cols, rows);
    }
    let session = session.expect("checked above");
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(
    state: tauri::State<PtyState>,
    id: u32,
    reclaimed: Option<bool>,
) -> Result<(), String> {
    if let Some(remote) = state.remote_sessions.write().unwrap().remove(&id) {
        remote.close();
        log::info!(
            "SSH_SESSION event=terminal_close epoch={} pty={id} reclaimed={}",
            remote.workspace.epoch(),
            reclaimed.unwrap_or(false)
        );
        return Ok(());
    }
    let session = state.sessions.write().unwrap().remove(&id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

/// 在 PTY 所属宿主中核对后台作业；缺少远端 Shell 身份时返回未知。
#[tauri::command]
pub async fn pty_has_running_tasks(
    state: tauri::State<'_, PtyState>,
    id: u32,
    shell_pid: Option<u32>,
    background_pids: Option<Vec<u32>>,
) -> Result<Option<bool>, String> {
    let remote = state.remote_sessions.read().unwrap().get(&id).cloned();
    if let Some(remote) = remote {
        let Some(pid) = shell_pid.filter(|pid| *pid > 0) else {
            return Ok(None);
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            remote.workspace.exec(
                activity::PROCESS_LIST_COMMAND,
                None,
                std::time::Duration::from_secs(2),
            ),
        )
        .await
        .map_err(|_| "terminal process check timed out".to_string())??;
        if result.exit_code != Some(0) || result.timed_out || result.truncated {
            return Err("terminal process check failed".into());
        }
        return activity::has_posix_tasks(
            &String::from_utf8_lossy(&result.stdout),
            pid,
            background_pids.as_deref(),
        )
        .map(Some);
    }
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("no session")?;
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = &session.workspace {
        let Some(pid) = shell_pid.filter(|pid| *pid > 0) else {
            return Ok(None);
        };
        let mut command = tokio::process::Command::new("wsl.exe");
        command.args(["-d", distro, "--exec", "ps"]);
        return activity::query_posix_tasks(command, pid, background_pids.as_deref())
            .await
            .map(Some);
    }
    if session.shell_pid == 0 {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        activity::query_posix_tasks(
            tokio::process::Command::new("ps"),
            session.shell_pid,
            background_pids.as_deref(),
        )
        .await
        .map(Some)
    }
    #[cfg(windows)]
    {
        // Git Bash 等入口可能先启动包装进程，集成报告的是实际 Shell 的原生 PID。
        let pid = shell_pid
            .filter(|pid| *pid > 0)
            .unwrap_or(session.shell_pid);
        tauri::async_runtime::spawn_blocking(move || shell_has_children(pid).map(Some))
            .await
            .map_err(|e| e.to_string())?
    }
}

// renderer 休眠仅关心前台占用；关闭保护还包含后台作业。
#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    if state.remote_sessions.read().unwrap().contains_key(&id) {
        return Ok(false);
    }
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_job: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let leader = session.master.lock().unwrap().process_group_leader();
        Ok(matches!(leader, Some(pid) if pid > 0 && pid as u32 != shell_pid))
    }
    #[cfg(windows)]
    {
        shell_has_children(shell_pid)
    }
}

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> Result<bool, String> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        let mut has_entry = Process32First(snapshot, &mut entry);
        let result = loop {
            if has_entry == 0 {
                let error = std::io::Error::last_os_error();
                break if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    Ok(false)
                } else {
                    Err(error.to_string())
                };
            }
            if entry.th32ParentProcessID == shell_pid {
                let name = std::ffi::CStr::from_ptr(entry.szExeFile.as_ptr()).to_string_lossy();
                // 控制台宿主不属于用户任务，cmd 等 Shell 也可能自行创建它。
                if !name.eq_ignore_ascii_case("conhost.exe")
                    && !name.eq_ignore_ascii_case("OpenConsole.exe")
                {
                    break Ok(true);
                }
            }
            has_entry = Process32Next(snapshot, &mut entry);
        };
        CloseHandle(snapshot);
        result
    }
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let remote: Vec<_> = state
        .remote_sessions
        .write()
        .unwrap()
        .drain()
        .map(|(_, session)| session)
        .collect();
    let remote_count = remote.len();
    for session in remote {
        session.close();
    }
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len() + remote_count;
    for (id, s) in drained {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    shell_init::detect_shell_name()
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<shell_init::ShellInfo> {
    shell_init::list_shells()
}
