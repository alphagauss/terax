pub mod background;
pub mod ringbuffer;
pub mod session;

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use shared_child::SharedChild;

use crate::modules::remote;
#[cfg(windows)]
use crate::modules::workspace::validate_wsl_distro_name;
use crate::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};

use background::{BackgroundLogResponse, BackgroundProc, BackgroundProcInfo};
use session::{SessionRunOutput, ShellSession};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Runs a one-shot command via the user's login shell. Output is capped and
/// the process is force-killed on timeout. We deliberately do NOT pipe into
/// the user's interactive PTY — that would fight their input. AI tool calls
/// are presented in chat as their own structured result.
#[tauri::command]
pub async fn shell_run_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<CommandOutput, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    let cwd_path = cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    tauri::async_runtime::spawn_blocking(move || run_blocking(trimmed, cwd_path, workspace, dur))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn run_blocking_inner(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
) -> Result<CommandOutput, String> {
    run_blocking(command, cwd, workspace, dur)
}

fn run_blocking(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
) -> Result<CommandOutput, String> {
    if let WorkspaceEnv::Ssh { profile_id } = &workspace {
        let output = remote::manager::exec_blocking(profile_id, &command, cwd.as_deref(), dur)?;
        return Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.exit_code,
            timed_out: output.timed_out,
            truncated: output.truncated,
        });
    }
    let mut cmd = build_oneshot_command(&command, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(dir)) = (&workspace, cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| {
        log::warn!("shell_run_command spawn failed: {e}");
        e.to_string()
    })?);
    let mut stdout_pipe = child.take_stdout().ok_or_else(|| {
        let _ = child.kill();
        "no stdout pipe".to_string()
    })?;
    let mut stderr_pipe = child.take_stderr().ok_or_else(|| {
        let _ = child.kill();
        "no stderr pipe".to_string()
    })?;

    let stdout_handle = thread::spawn(move || drain(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || drain(&mut stderr_pipe));

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let (exit_code, timed_out) = match rx.recv_timeout(dur) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("shell wait thread disconnected".into());
        }
    };

    let (stdout_bytes, stdout_truncated) = stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_truncated) = stderr_handle.join().unwrap_or((Vec::new(), false));

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Persistent agent shell state + background process state.
// ──────────────────────────────────────────────────────────────────────────

pub struct ShellState {
    sessions: RwLock<HashMap<u32, Arc<ShellSession>>>,
    bg: RwLock<HashMap<u32, Arc<BackgroundProc>>>,
    remote_bg: RwLock<HashMap<u32, RemoteBackgroundProc>>,
    next_session_id: AtomicU32,
    next_bg_id: AtomicU32,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            bg: RwLock::new(HashMap::new()),
            remote_bg: RwLock::new(HashMap::new()),
            next_session_id: AtomicU32::new(1),
            next_bg_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
pub async fn shell_session_open(
    state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    let initial = match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(c) => c.to_string(),
        None => match &workspace {
            WorkspaceEnv::Wsl { distro } => crate::modules::workspace::wsl_home(distro.clone())?,
            WorkspaceEnv::Ssh { profile_id } => {
                let manager = remote::manager::global_manager()?;
                manager.home(profile_id).await?
            }
            WorkspaceEnv::Local => {
                crate::modules::fs::to_canon(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
            }
        },
    };
    let session = Arc::new(ShellSession::new(initial, workspace));
    let id = state.next_session_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().unwrap().insert(id, session);
    Ok(id)
}

#[tauri::command]
pub async fn shell_session_run(
    state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    id: u32,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
) -> Result<SessionRunOutput, String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    let effective_workspace = workspace
        .clone()
        .unwrap_or_else(|| session.workspace.clone());
    authorize_spawn_cwd(&registry, cwd.as_deref(), &effective_workspace)?;
    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    tauri::async_runtime::spawn_blocking(move || session.run(command, cwd, workspace, dur))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn shell_session_close(state: tauri::State<ShellState>, id: u32) -> Result<(), String> {
    state.sessions.write().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn shell_bg_spawn(
    state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    command: String,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, cwd.as_deref(), &workspace)?;
    if let WorkspaceEnv::Ssh { profile_id } = &workspace {
        let id = state.next_bg_id.fetch_add(1, Ordering::Relaxed);
        let proc = RemoteBackgroundProc::spawn(profile_id.clone(), command, cwd).await?;
        state.remote_bg.write().unwrap().insert(id, proc);
        return Ok(id);
    }
    let proc = background::spawn(command, cwd, workspace)?;
    let id = state.next_bg_id.fetch_add(1, Ordering::Relaxed);
    state.bg.write().unwrap().insert(id, proc);
    Ok(id)
}

#[tauri::command]
pub async fn shell_bg_logs(
    state: tauri::State<'_, ShellState>,
    handle: u32,
    since_offset: Option<u64>,
) -> Result<BackgroundLogResponse, String> {
    let remote_proc = state.remote_bg.read().unwrap().get(&handle).cloned();
    if let Some(proc) = remote_proc {
        return proc.read_logs(since_offset.unwrap_or(0)).await;
    }
    let proc = state
        .bg
        .read()
        .unwrap()
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no background handle".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub async fn shell_bg_kill(state: tauri::State<'_, ShellState>, handle: u32) -> Result<(), String> {
    let remote_proc = state.remote_bg.write().unwrap().remove(&handle);
    if let Some(proc) = remote_proc {
        return proc.kill().await;
    }
    if let Some(proc) = state.bg.read().unwrap().get(&handle).cloned() {
        proc.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn shell_bg_list(
    state: tauri::State<'_, ShellState>,
) -> Result<Vec<BackgroundProcInfo>, String> {
    let mut out = {
        let map = state.bg.read().unwrap();
        let mut local = Vec::with_capacity(map.len());
        for (id, proc) in map.iter() {
            local.push(proc.info(*id));
        }
        local
    };
    let remote: Vec<_> = {
        let map = state.remote_bg.read().unwrap();
        map.iter().map(|(id, proc)| (*id, proc.clone())).collect()
    };
    for (id, proc) in remote {
        out.push(proc.info(id).await);
    }
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

#[derive(Clone)]
struct RemoteBackgroundProc {
    profile_id: String,
    command: String,
    cwd: Option<String>,
    pid: u32,
    log_path: String,
    started_at_ms: u64,
}

impl RemoteBackgroundProc {
    async fn spawn(
        profile_id: String,
        command: String,
        cwd: Option<String>,
    ) -> Result<Self, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("empty command".into());
        }
        let log_path = format!("/tmp/terax-bg-{}.log", uuid::Uuid::new_v4());
        let inner = match cwd.as_deref().filter(|value| !value.trim().is_empty()) {
            Some(cwd) => format!(
                "cd -- {} && exec /bin/bash -lc {}",
                remote::session::shell_quote(cwd),
                remote::session::shell_quote(&command)
            ),
            None => format!(
                "exec /bin/bash -lc {}",
                remote::session::shell_quote(&command)
            ),
        };
        let launch = format!(
            "nohup sh -c {} >{} 2>&1 </dev/null & echo $!",
            remote::session::shell_quote(&inner),
            remote::session::shell_quote(&log_path)
        );
        let manager = remote::manager::global_manager()?;
        let output = manager
            .exec(&profile_id, &launch, None, Duration::from_secs(15))
            .await?;
        if output.exit_code != Some(0) {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        let pid = String::from_utf8_lossy(&output.stdout)
            .lines()
            .last()
            .unwrap_or("")
            .trim()
            .parse::<u32>()
            .map_err(|_| "remote background command did not return a PID".to_string())?;
        let started_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        Ok(Self {
            profile_id,
            command,
            cwd,
            pid,
            log_path,
            started_at_ms,
        })
    }

    async fn read_logs(&self, since: u64) -> Result<BackgroundLogResponse, String> {
        let command = format!(
            "if [ -f {log} ]; then tail -c +{start} -- {log}; fi",
            log = remote::session::shell_quote(&self.log_path),
            start = since.saturating_add(1),
        );
        let manager = remote::manager::global_manager()?;
        let output = manager
            .exec(&self.profile_id, &command, None, Duration::from_secs(10))
            .await?;
        let bytes = output.stdout;
        let running = self.is_running().await;
        Ok(BackgroundLogResponse {
            next_offset: since.saturating_add(bytes.len() as u64),
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            dropped: 0,
            exited: !running,
            exit_code: None,
        })
    }

    async fn is_running(&self) -> bool {
        let Ok(manager) = remote::manager::global_manager() else {
            return false;
        };
        manager
            .exec(
                &self.profile_id,
                &format!("kill -0 {} 2>/dev/null", self.pid),
                None,
                Duration::from_secs(5),
            )
            .await
            .is_ok_and(|output| output.exit_code == Some(0))
    }

    async fn kill(&self) -> Result<(), String> {
        let command = format!(
            "kill -- -{pid} 2>/dev/null || kill {pid} 2>/dev/null || true; rm -f -- {log}",
            pid = self.pid,
            log = remote::session::shell_quote(&self.log_path),
        );
        remote::manager::global_manager()?
            .exec(&self.profile_id, &command, None, Duration::from_secs(10))
            .await
            .map(|_| ())
    }

    async fn info(&self, handle: u32) -> BackgroundProcInfo {
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited: !self.is_running().await,
            exit_code: None,
        }
    }
}

pub(crate) fn build_oneshot_command(
    command: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] workspace: &WorkspaceEnv,
    #[cfg_attr(not(windows), allow(unused_variables))] cwd: Option<&str>,
) -> Result<Command, String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        validate_wsl_distro_name(distro)?;
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            cmd.arg("--cd").arg(cwd);
        }
        cmd.arg("--exec").arg("sh").arg("-lc").arg(command);
        return Ok(cmd);
    }
    #[cfg(unix)]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command);
        for (key, value) in crate::modules::workspace::appimage_env_overrides() {
            match value {
                Some(v) => {
                    cmd.env(key, v);
                }
                None => {
                    cmd.env_remove(key);
                }
            }
        }
        Ok(cmd)
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let mut cmd = Command::new(&shell);
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        if is_cmd {
            cmd.arg("/C").arg(command);
        } else {
            cmd.arg("-NoProfile").arg("-Command").arg(command);
        }
        Ok(cmd)
    }
}

fn drain<R: Read>(reader: &mut R) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= MAX_OUTPUT_BYTES {
                    truncated = true;
                    continue;
                }
                let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn run(cmd: &str, timeout_secs: u64) -> CommandOutput {
        run_blocking_inner(
            cmd.into(),
            None,
            WorkspaceEnv::Local,
            Duration::from_secs(timeout_secs),
        )
        .expect("run")
    }

    #[test]
    fn run_blocking_captures_stdout_and_zero_exit() {
        let out = run("printf 'hello\\n'", 5);
        assert_eq!(out.stdout, "hello\n");
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert!(!out.truncated);
    }

    #[test]
    fn run_blocking_captures_stderr_and_nonzero_exit() {
        let out = run("printf 'oops\\n' >&2; exit 3", 5);
        assert!(out.stderr.contains("oops"));
        assert_eq!(out.exit_code, Some(3));
    }

    #[test]
    fn run_blocking_times_out_long_running_command() {
        let out = run("sleep 10", 1);
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
    }

    #[test]
    fn run_blocking_truncates_huge_output() {
        let big = MAX_OUTPUT_BYTES + 4096;
        let out = run(&format!("head -c {big} /dev/zero"), 10);
        assert!(out.truncated);
        assert!(out.stdout.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn build_oneshot_command_uses_sh_minus_c_on_unix() {
        let cmd = build_oneshot_command("echo hi", &WorkspaceEnv::Local, None).unwrap();
        assert_eq!(cmd.get_program(), "/bin/sh");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-c", "echo hi"]);
    }
}
