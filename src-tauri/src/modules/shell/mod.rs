//! AI Shell 统一进程管理与通用一次性命令执行。
//!
//! Agent 命令统一登记为可交互进程，并在 Local、WSL、SSH 后端共享输出、超时、
//! stdin 和生命周期契约。非 AI 调用方继续使用有界的一次性命令接口。

mod output;
mod process;

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use shared_child::SharedChild;

use crate::modules::remote;
#[cfg(windows)]
use crate::modules::workspace::validate_wsl_distro_name;
use crate::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};

pub(crate) use process::{AgentProcess, ProcessPurpose};
pub use process::{ProcessInfo, ProcessResponse, ProcessStatus, ShellKind};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_ONESHOT_TIMEOUT_SECS: u64 = 300;
const MAX_AGENT_TIMEOUT_SECS: u64 = 3600;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_COMMAND_BYTES: usize = 256 * 1024;
const MAX_CWD_BYTES: usize = 32 * 1024;
const MAX_STDIN_WRITE_BYTES: usize = 256 * 1024;
const MAX_WAIT_FOR_BYTES: usize = 4096;
const DEFAULT_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_RUNNING_PER_OWNER: usize = 4;
const MAX_RUNNING_PER_APP: usize = 16;
const MAX_FINISHED_RECORDS: usize = 50;
const FINISHED_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// 运行非 AI 模块使用的一次性命令，输出有界且超时后终止进程树。
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
    let cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let timeout = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_ONESHOT_TIMEOUT_SECS),
    );
    tauri::async_runtime::spawn_blocking(move || run_blocking(trimmed, cwd, workspace, timeout))
        .await
        .map_err(|error| error.to_string())?
}

/// 当前应用进程内的 Agent 进程注册表与聊天 cwd。
pub struct ShellState {
    processes: RwLock<HashMap<String, Arc<AgentProcess>>>,
    owner_cwds: RwLock<HashMap<String, String>>,
    owner_exec_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    spawn_lock: tokio::sync::Mutex<()>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            processes: RwLock::new(HashMap::new()),
            owner_cwds: RwLock::new(HashMap::new()),
            owner_exec_locks: Mutex::new(HashMap::new()),
            spawn_lock: tokio::sync::Mutex::new(()),
        }
    }
}

impl Drop for ShellState {
    fn drop(&mut self) {
        for process in self.processes.get_mut().unwrap().values() {
            process.stop_on_drop();
        }
        self.processes.get_mut().unwrap().clear();
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessAction {
    Poll,
    Write,
    CloseStdin,
    Terminate,
}

/// 启动统一 Agent 进程，并等待首轮时限或终态。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn shell_exec(
    state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    owner_session_id: String,
    command: String,
    initial_cwd: String,
    cwd: Option<String>,
    timeout_secs: u64,
    yield_time_ms: u64,
    max_output_bytes: usize,
    shell: ShellKind,
    login: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<ProcessResponse, String> {
    validate_owner(&owner_session_id)?;
    validate_agent_command(&command)?;
    validate_cwd(&initial_cwd)?;
    if let Some(cwd) = cwd.as_deref() {
        validate_cwd(cwd)?;
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    let explicit_cwd = cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let _owner_guard = if explicit_cwd.is_none() {
        Some(state.owner_exec_lock(&owner_session_id).lock_owned().await)
    } else {
        None
    };
    let effective_cwd = explicit_cwd.clone().unwrap_or_else(|| {
        state
            .owner_cwds
            .read()
            .unwrap()
            .get(&owner_session_id)
            .cloned()
            .unwrap_or_else(|| initial_cwd.clone())
    });
    validate_cwd(&effective_cwd)?;
    let authorized = authorize_spawn_cwd(&registry, Some(&effective_cwd), &workspace)?
        .ok_or_else(|| "Agent process cwd is required".to_string())?;
    let effective_cwd = if workspace.is_ssh() || workspace.is_wsl() {
        effective_cwd.replace('\\', "/")
    } else {
        crate::modules::fs::to_canon(authorized)
    };

    // 容量检查与登记必须覆盖同一个 spawn 临界区，否则并发调用可以穿透进程上限。
    // 锁在登记后立即释放，不占用后续首次等待时间。
    let spawn_guard = state.spawn_lock.lock().await;
    state.cleanup();
    state.enforce_limits(&owner_session_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let process = if workspace.is_ssh() {
        AgentProcess::spawn_remote(
            id.clone(),
            owner_session_id.clone(),
            workspace.clone(),
            command,
            effective_cwd,
            shell,
            login,
            ProcessPurpose::Shell,
        )
        .await?
    } else {
        AgentProcess::spawn_local(
            id.clone(),
            owner_session_id.clone(),
            workspace.clone(),
            command,
            effective_cwd,
            shell,
            login,
            ProcessPurpose::Shell,
        )?
    };
    state.processes.write().unwrap().insert(id, process.clone());
    drop(spawn_guard);

    if timeout_secs > 0 {
        let timeout = timeout_secs.clamp(1, MAX_AGENT_TIMEOUT_SECS);
        let timed = Arc::downgrade(&process);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(timeout)).await;
            if let Some(timed) = timed.upgrade() {
                if timed.is_running() {
                    let _ = timed.terminate_as(ProcessStatus::TimedOut).await;
                }
            }
        });
    }

    let wait = Duration::from_millis(yield_time_ms.min(30_000));
    let max_output = normalize_output_limit(max_output_bytes);
    let waited = process.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        waited.wait_snapshot(0, wait, None, max_output)
    })
    .await
    .map_err(|error| error.to_string())?;
    if explicit_cwd.is_none() && response.status != ProcessStatus::Running {
        if let Some(cwd_after) = response.cwd_after.clone() {
            state
                .owner_cwds
                .write()
                .unwrap()
                .insert(owner_session_id, cwd_after);
        }
    }
    Ok(response)
}

/// 轮询、写入、关闭 stdin 或终止一个已登记的 Agent 进程。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn shell_process(
    state: tauri::State<'_, ShellState>,
    owner_session_id: String,
    process_id: String,
    action: ProcessAction,
    input: Option<String>,
    close_stdin: bool,
    since_offset: Option<u64>,
    yield_time_ms: Option<u64>,
    wait_for: Option<String>,
    wait_timeout_ms: Option<u64>,
    max_output_bytes: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<ProcessResponse, String> {
    validate_owner(&owner_session_id)?;
    validate_process_id(&process_id)?;
    validate_process_request(action, input.as_deref(), close_stdin, wait_for.as_deref())?;
    state.cleanup();
    let workspace = WorkspaceEnv::from_option(workspace);
    if input
        .as_ref()
        .is_some_and(|value| value.len() > MAX_STDIN_WRITE_BYTES)
    {
        return Err("Agent process stdin write exceeds the size limit".into());
    }
    if wait_for
        .as_ref()
        .is_some_and(|value| value.len() > MAX_WAIT_FOR_BYTES)
    {
        return Err("Agent process wait target exceeds the size limit".into());
    }
    let process = state.owned_process(&process_id, &owner_session_id, &workspace)?;

    match action {
        ProcessAction::Poll => {}
        ProcessAction::Write => {
            process.write(input.unwrap_or_default()).await?;
            if close_stdin {
                process.close_stdin().await?;
            }
        }
        ProcessAction::CloseStdin => process.close_stdin().await?,
        ProcessAction::Terminate => {
            process.terminate_as(ProcessStatus::Terminated).await?;
        }
    }

    let since = since_offset.unwrap_or(0);
    let wait_ms = if wait_for.is_some() {
        wait_timeout_ms.unwrap_or(10_000).min(120_000)
    } else {
        yield_time_ms.unwrap_or(1_000).min(30_000)
    };
    let max_output = normalize_output_limit(max_output_bytes.unwrap_or(DEFAULT_TOOL_OUTPUT_BYTES));
    let waited = process.clone();
    tauri::async_runtime::spawn_blocking(move || {
        waited.wait_snapshot(
            since,
            Duration::from_millis(wait_ms),
            wait_for.as_deref(),
            max_output,
        )
    })
    .await
    .map_err(|error| error.to_string())
}

/// 列出当前 Workspace 中运行中或最近结束的 Agent 进程。
#[tauri::command]
pub fn shell_list(
    state: tauri::State<'_, ShellState>,
    owner_session_id: String,
    include_exited: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<ProcessInfo>, String> {
    validate_owner(&owner_session_id)?;
    state.cleanup();
    let workspace = WorkspaceEnv::from_option(workspace);
    let mut processes: Vec<_> = state
        .processes
        .read()
        .unwrap()
        .values()
        .filter(|process| {
            process.purpose == ProcessPurpose::Shell
                && process.workspace == workspace
                && process.owner_session_id == owner_session_id
        })
        .filter(|process| include_exited || process.is_running())
        .map(|process| process.info())
        .collect();
    processes.sort_by_key(|process| process.started_at_ms);
    Ok(processes)
}

/// 删除聊天时终止并清理该 owner 的全部 Agent 进程。
#[tauri::command]
pub async fn shell_clear_owner(
    state: tauri::State<'_, ShellState>,
    owner_session_id: String,
) -> Result<(), String> {
    validate_owner(&owner_session_id)?;
    let _spawn_guard = state.spawn_lock.lock().await;
    let processes: Vec<_> = state
        .processes
        .read()
        .unwrap()
        .values()
        .filter(|process| process.owner_session_id == owner_session_id)
        .cloned()
        .collect();
    for process in &processes {
        process.terminate_as(ProcessStatus::Terminated).await?;
    }
    state
        .processes
        .write()
        .unwrap()
        .retain(|_, process| process.owner_session_id != owner_session_id);
    state.owner_cwds.write().unwrap().remove(&owner_session_id);
    state
        .owner_exec_locks
        .lock()
        .unwrap()
        .remove(&owner_session_id);
    Ok(())
}

impl ShellState {
    /// 在当前 Workspace 中启动由封闭适配器构造的 External Agent 命令。
    pub(crate) async fn spawn_external_agent(
        &self,
        registry: &WorkspaceRegistry,
        owner_session_id: String,
        command: String,
        cwd: String,
        workspace: WorkspaceEnv,
    ) -> Result<Arc<AgentProcess>, String> {
        validate_owner(&owner_session_id)?;
        validate_agent_command(&command)?;
        validate_cwd(&cwd)?;
        let authorized = authorize_spawn_cwd(registry, Some(&cwd), &workspace)?
            .ok_or_else(|| "External Agent cwd is required".to_string())?;
        let cwd = if workspace.is_ssh() || workspace.is_wsl() {
            cwd.replace('\\', "/")
        } else {
            crate::modules::fs::to_canon(authorized)
        };

        let spawn_guard = self.spawn_lock.lock().await;
        self.cleanup();
        self.enforce_limits(&owner_session_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let login = !cfg!(windows) || !matches!(workspace, WorkspaceEnv::Local);
        let process = if workspace.is_ssh() {
            AgentProcess::spawn_remote(
                id.clone(),
                owner_session_id,
                workspace,
                command,
                cwd,
                ShellKind::Default,
                login,
                ProcessPurpose::ExternalAgent,
            )
            .await?
        } else {
            AgentProcess::spawn_local(
                id.clone(),
                owner_session_id,
                workspace,
                command,
                cwd,
                ShellKind::Default,
                login,
                ProcessPurpose::ExternalAgent,
            )?
        };
        self.processes.write().unwrap().insert(id, process.clone());
        drop(spawn_guard);
        Ok(process)
    }

    /// 只返回由 External Agent Runtime 创建且归当前聊天所有的进程。
    pub(crate) fn owned_external_agent(
        &self,
        process_id: &str,
        owner_session_id: &str,
        workspace: &WorkspaceEnv,
    ) -> Result<Arc<AgentProcess>, String> {
        validate_owner(owner_session_id)?;
        validate_process_id(process_id)?;
        self.processes
            .read()
            .unwrap()
            .get(process_id)
            .filter(|process| {
                process.purpose == ProcessPurpose::ExternalAgent
                    && process.owner_session_id == owner_session_id
                    && process.workspace == *workspace
            })
            .cloned()
            .ok_or_else(|| "External Agent process not found".to_string())
    }

    fn owned_process(
        &self,
        process_id: &str,
        owner_session_id: &str,
        workspace: &WorkspaceEnv,
    ) -> Result<Arc<AgentProcess>, String> {
        self.processes
            .read()
            .unwrap()
            .get(process_id)
            .filter(|process| {
                process.purpose == ProcessPurpose::Shell
                    && process.owner_session_id == owner_session_id
                    && process.workspace == *workspace
            })
            .cloned()
            .ok_or_else(|| "Agent process not found".to_string())
    }

    fn owner_exec_lock(&self, owner_session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.owner_exec_locks
            .lock()
            .unwrap()
            .entry(owner_session_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn enforce_limits(&self, owner_session_id: &str) -> Result<(), String> {
        let processes = self.processes.read().unwrap();
        let app_running = processes
            .values()
            .filter(|process| process.is_running())
            .count();
        let owner_running = processes
            .values()
            .filter(|process| process.is_running() && process.owner_session_id == owner_session_id)
            .count();
        validate_running_counts(app_running, owner_running)
    }

    fn cleanup(&self) {
        let mut processes = self.processes.write().unwrap();
        processes.retain(|_, process| {
            process.is_running() || process.finished_age().is_some_and(|age| age < FINISHED_TTL)
        });
        let mut finished: Vec<_> = processes
            .iter()
            .filter(|(_, process)| !process.is_running())
            .filter_map(|(id, process)| process.finished_age().map(|age| (id.clone(), age)))
            .collect();
        if finished.len() > MAX_FINISHED_RECORDS {
            finished.sort_by_key(|(_, age)| std::cmp::Reverse(*age));
            let remove = finished.len() - MAX_FINISHED_RECORDS;
            for (id, _) in finished.into_iter().take(remove) {
                processes.remove(&id);
            }
        }
    }
}

fn validate_running_counts(app_running: usize, owner_running: usize) -> Result<(), String> {
    if app_running >= MAX_RUNNING_PER_APP {
        return Err(format!(
            "maximum running Agent processes reached ({MAX_RUNNING_PER_APP})"
        ));
    }
    if owner_running >= MAX_RUNNING_PER_OWNER {
        return Err(format!(
            "maximum running Agent processes for this chat reached ({MAX_RUNNING_PER_OWNER})"
        ));
    }
    Ok(())
}

fn validate_owner(owner: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(owner).is_err() {
        return Err("invalid Agent process owner session id".into());
    }
    Ok(())
}

fn validate_process_id(process_id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(process_id).is_err() {
        return Err("invalid Agent process id".into());
    }
    Ok(())
}

fn validate_cwd(cwd: &str) -> Result<(), String> {
    if cwd.len() > MAX_CWD_BYTES {
        return Err("Agent process cwd exceeds the size limit".into());
    }
    Ok(())
}

fn validate_process_request(
    action: ProcessAction,
    input: Option<&str>,
    close_stdin: bool,
    wait_for: Option<&str>,
) -> Result<(), String> {
    match action {
        ProcessAction::Write if input.is_none() => {
            return Err("Agent process write requires input".into());
        }
        ProcessAction::Write => {}
        _ if input.is_some() || close_stdin => {
            return Err("stdin options are only valid for Agent process write".into());
        }
        _ => {}
    }
    if wait_for.is_some_and(str::is_empty) {
        return Err("Agent process wait target cannot be empty".into());
    }
    if wait_for.is_some() && !matches!(action, ProcessAction::Poll | ProcessAction::Write) {
        return Err("wait target is only valid for Agent process poll or write".into());
    }
    Ok(())
}

/// 在 Rust IPC 边界拒绝不可审阅或会破坏主机根目录的命令。
fn validate_agent_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if command.len() > MAX_COMMAND_BYTES {
        return Err("command exceeds the Agent Shell size limit".into());
    }
    if trimmed.chars().any(|character| {
        (character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
            || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}' | '\u{061c}')
    })
    {
        return Err("command contains unsafe invisible characters".into());
    }
    let compact = trimmed
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let destructive = [
        "--no-preserve-root",
        "mkfs",
        "fdisk",
        "parted",
        "diskutil erase",
        ":(){:|:&};:",
    ];
    if destructive.iter().any(|pattern| compact.contains(pattern)) {
        return Err("command is blocked by the Agent Shell safety policy".into());
    }
    if attempts_recursive_root_delete(trimmed) {
        return Err("command cannot recursively delete a filesystem or home root".into());
    }
    if (compact.contains("curl ") || compact.contains("wget "))
        && ["| sh", "| bash", "| zsh", "| fish"]
            .iter()
            .any(|pattern| compact.contains(pattern))
    {
        return Err("network downloads cannot be piped directly into a shell".into());
    }
    Ok(())
}

fn attempts_recursive_root_delete(command: &str) -> bool {
    command
        .split([';', '|', '&', '\n', '\r'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .any(|segment| {
            let tokens: Vec<_> = segment
                .split_whitespace()
                .map(|token| token.trim_matches(['\'', '"']).to_ascii_lowercase())
                .collect();
            let Some(command_index) = tokens
                .iter()
                .position(|token| token.rsplit('/').next() == Some("rm"))
            else {
                return false;
            };
            let args = &tokens[command_index + 1..];
            let recursive = args.iter().any(|argument| {
                argument == "--recursive"
                    || (argument.starts_with('-') && argument[1..].contains('r'))
            });
            let force = args.iter().any(|argument| {
                argument == "--force" || (argument.starts_with('-') && argument[1..].contains('f'))
            });
            recursive
                && force
                && args.iter().any(|argument| {
                    let target = argument.trim_end_matches('/');
                    target.is_empty()
                        || target == "/*"
                        || target == "/.*"
                        || target == "~"
                        || target.starts_with("~/")
                        || target == "$home"
                        || target.starts_with("$home/")
                        || target == "${home}"
                        || target.starts_with("${home}/")
                })
        })
}

fn normalize_output_limit(value: usize) -> usize {
    value.clamp(1024, MAX_OUTPUT_BYTES)
}

fn run_blocking(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    if let WorkspaceEnv::Ssh { profile_id } = &workspace {
        let output = remote::manager::exec_blocking(profile_id, &command, cwd.as_deref(), timeout)?;
        return Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.exit_code,
            timed_out: output.timed_out,
            truncated: output.truncated,
        });
    }
    let mut native = build_oneshot_command(&command, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(dir)) = (&workspace, cwd) {
        native.current_dir(dir);
    }
    native
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(not(windows))]
    crate::modules::proc::hide_console(&mut native);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        native.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    #[cfg(windows)]
    let (child, job) =
        crate::modules::proc::job::ProcessJob::spawn(&mut native).map_err(|error| {
            log::warn!("shell_run_command spawn failed: {error}");
            error.to_string()
        })?;
    #[cfg(not(windows))]
    let child = SharedChild::spawn(&mut native).map_err(|error| {
        log::warn!("shell_run_command spawn failed: {error}");
        error.to_string()
    })?;
    let child = Arc::new(child);
    #[cfg(windows)]
    let mut job = Some(job);
    let mut stdout = child.take_stdout().ok_or_else(|| {
        let _ = child.kill();
        "no stdout pipe".to_string()
    })?;
    let mut stderr = child.take_stderr().ok_or_else(|| {
        let _ = child.kill();
        "no stderr pipe".to_string()
    })?;
    let stdout_thread = thread::spawn(move || drain(&mut stdout));
    let stderr_thread = thread::spawn(move || drain(&mut stderr));
    let (sender, receiver) = std::sync::mpsc::channel();
    let waiter = child.clone();
    thread::spawn(move || {
        let _ = sender.send(waiter.wait());
    });
    let (exit_code, timed_out) = match receiver.recv_timeout(timeout) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(error)) => return Err(error.to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
            }
            #[cfg(windows)]
            drop(job.take());
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err("shell wait thread disconnected".into());
        }
    };
    #[cfg(unix)]
    unsafe {
        // Shell 正常退出后仍可能留下继承管道的后台子进程，必须在 join reader 前收口。
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    drop(job.take());
    let (stdout, stdout_truncated) = stdout_thread.join().unwrap_or((Vec::new(), false));
    let (stderr, stderr_truncated) = stderr_thread.join().unwrap_or((Vec::new(), false));
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

pub(crate) fn run_blocking_inner(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    run_blocking(command, cwd, workspace, timeout)
}

pub(crate) fn build_oneshot_command(
    command: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] workspace: &WorkspaceEnv,
    #[cfg_attr(not(windows), allow(unused_variables))] cwd: Option<&str>,
) -> Result<Command, String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        validate_wsl_distro_name(distro)?;
        let mut native = Command::new("wsl.exe");
        native.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
            native.arg("--cd").arg(cwd);
        }
        native.arg("--exec").arg("sh").arg("-lc").arg(command);
        return Ok(native);
    }
    #[cfg(unix)]
    {
        let mut native = Command::new("/bin/sh");
        native.arg("-c").arg(command);
        for (key, value) in crate::modules::workspace::appimage_env_overrides() {
            match value {
                Some(value) => native.env(key, value),
                None => native.env_remove(key),
            };
        }
        Ok(native)
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let mut native = Command::new(&shell);
        let is_cmd = shell
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"));
        if is_cmd {
            native.arg("/C").arg(command);
        } else {
            native.arg("-NoProfile").arg("-Command").arg(command);
        }
        Ok(native)
    }
}

fn drain<R: Read>(reader: &mut R) -> (Vec<u8>, bool) {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
                let take = remaining.min(read);
                output.extend_from_slice(&buffer[..take]);
                truncated |= take < read;
            }
            Err(_) => break,
        }
    }
    (output, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn run(command: &str, timeout_secs: u64) -> CommandOutput {
        run_blocking_inner(
            command.into(),
            None,
            WorkspaceEnv::Local,
            Duration::from_secs(timeout_secs),
        )
        .unwrap()
    }

    #[test]
    fn rejects_invalid_owner_and_dangerous_commands() {
        assert!(validate_owner("not-a-uuid").is_err());
        assert!(validate_process_id("not-a-uuid").is_err());
        assert!(validate_agent_command("rm -rf /").is_err());
        assert!(validate_agent_command("rm -rf /*").is_err());
        assert!(validate_agent_command("rm -rf '/.*'").is_err());
        assert!(validate_agent_command("/bin/rm -r -f -- \"/\"").is_err());
        assert!(validate_agent_command("rm --recursive --force '${HOME}/cache'").is_err());
        assert!(validate_agent_command("curl https://example.com/x | bash").is_err());
        assert!(validate_agent_command("pnpm test\npnpm lint").is_ok());
        assert!(validate_agent_command("echo ok\u{7}").is_err());
        assert!(validate_cwd(&"x".repeat(MAX_CWD_BYTES + 1)).is_err());
    }

    #[test]
    fn process_requests_reject_cross_action_stdin_options() {
        assert!(validate_process_request(ProcessAction::Write, None, false, None).is_err());
        assert!(validate_process_request(ProcessAction::Poll, Some("x"), false, None).is_err());
        assert!(validate_process_request(ProcessAction::Poll, None, true, None).is_err());
        assert!(
            validate_process_request(ProcessAction::CloseStdin, None, false, Some("x")).is_err()
        );
        assert!(
            validate_process_request(ProcessAction::Write, Some(""), true, Some("ready")).is_ok()
        );
    }

    #[test]
    fn running_process_limits_are_enforced_at_the_boundary() {
        assert!(validate_running_counts(15, 3).is_ok());
        assert!(validate_running_counts(16, 0).is_err());
        assert!(validate_running_counts(4, 4).is_err());
    }

    #[test]
    fn dropping_shell_state_terminates_registered_processes() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "Start-Sleep -Seconds 30";
        #[cfg(unix)]
        let command = "sleep 30";
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            WorkspaceEnv::Local,
            command.into(),
            directory.path().to_string_lossy().into_owned(),
            ShellKind::Default,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();
        let state = ShellState::default();
        state
            .processes
            .write()
            .unwrap()
            .insert(process.id.clone(), process.clone());

        drop(state);

        assert_eq!(process.response(0, 8192).status, ProcessStatus::Terminated);
    }

    #[test]
    fn process_lookup_is_scoped_to_its_owner() {
        let directory = tempfile::tempdir().unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        #[cfg(windows)]
        let command = "Start-Sleep -Seconds 30";
        #[cfg(unix)]
        let command = "sleep 30";
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            owner.clone(),
            WorkspaceEnv::Local,
            command.into(),
            directory.path().to_string_lossy().into_owned(),
            ShellKind::Default,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();
        let state = ShellState::default();
        state
            .processes
            .write()
            .unwrap()
            .insert(process.id.clone(), process.clone());

        assert!(state
            .owned_process(&process.id, &owner, &WorkspaceEnv::Local)
            .is_ok());
        assert!(state
            .owned_process(
                &process.id,
                &uuid::Uuid::new_v4().to_string(),
                &WorkspaceEnv::Local,
            )
            .is_err());
    }

    #[test]
    fn process_lookup_is_scoped_to_its_purpose() {
        let directory = tempfile::tempdir().unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        #[cfg(windows)]
        let command = "Start-Sleep -Seconds 30";
        #[cfg(unix)]
        let command = "sleep 30";
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            owner.clone(),
            WorkspaceEnv::Local,
            command.into(),
            directory.path().to_string_lossy().into_owned(),
            ShellKind::Default,
            false,
            ProcessPurpose::ExternalAgent,
        )
        .unwrap();
        let state = ShellState::default();
        state
            .processes
            .write()
            .unwrap()
            .insert(process.id.clone(), process.clone());

        assert!(state
            .owned_process(&process.id, &owner, &WorkspaceEnv::Local)
            .is_err());
        assert!(state
            .owned_external_agent(&process.id, &owner, &WorkspaceEnv::Local)
            .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn oneshot_captures_exit_timeout_and_truncation() {
        let success = run("printf 'hello\\n'", 5);
        assert_eq!(success.stdout, "hello\n");
        assert_eq!(success.exit_code, Some(0));

        let failure = run("printf 'oops\\n' >&2; exit 3", 5);
        assert!(failure.stderr.contains("oops"));
        assert_eq!(failure.exit_code, Some(3));

        let timeout = run("sleep 10", 1);
        assert!(timeout.timed_out);
        assert_eq!(timeout.exit_code, None);

        let large = run(&format!("head -c {} /dev/zero", MAX_OUTPUT_BYTES + 1), 5);
        assert!(large.truncated);
        assert!(large.stdout.len() <= MAX_OUTPUT_BYTES);
    }

    #[cfg(unix)]
    #[test]
    fn oneshot_command_uses_posix_shell() {
        let command = build_oneshot_command("echo ok", &WorkspaceEnv::Local, None).unwrap();
        assert_eq!(command.get_program(), "/bin/sh");
    }
}
