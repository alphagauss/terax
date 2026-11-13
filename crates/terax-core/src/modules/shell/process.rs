//! AI Agent 统一进程实例及 Local、WSL、SSH 执行后端。
//!
//! 每个命令都进入同一个有界生命周期模型。Local 与 WSL 使用受管子进程，SSH
//! 使用长生命周期 exec channel；三者共享 stdin、输出 offset、超时和终止语义。
//! 普通 Shell 正常退出后释放 POSIX 后代；显式后台化并重定向标准流的服务由用户管理。
//! SSH Profile 目录只决定默认位置，不限制用户明确选择的 Agent 工作目录。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

#[cfg(feature = "workspace-runtime")]
use russh::{ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use shared_child::SharedChild;
#[cfg(feature = "workspace-runtime")]
use tokio::sync::{mpsc, oneshot};

#[cfg(test)]
use crate::modules::proc::group::posix_group_kill_command;

use super::output::{OutputLog, OutputSlice, OutputStream};
#[cfg(feature = "workspace-runtime")]
use crate::modules::remote;
use crate::modules::workspace::WorkspaceEnv;

#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(1);
const INTERNAL_READ_LIMIT: usize = 4 * 1024 * 1024;
const FINISHED_OUTPUT_CAPACITY: usize = 256 * 1024;

/// 提供给模型的解释器身份；kind 同时是工具的显式选择值。
#[derive(Clone, Debug, Serialize)]
pub struct ShellIdentity {
    pub kind: ShellKind,
    pub executable: String,
    pub version: Option<String>,
}

/// 每个执行环境首次使用时探测一次；提示和执行复用同一快照，失败不缓存。
/// SSH 调用必须位于阻塞线程，避免阻塞连接运行时。
pub fn agent_shells(workspace: &WorkspaceEnv) -> Result<Vec<ShellIdentity>, String> {
    static SHELLS: OnceLock<Mutex<HashMap<String, Vec<ShellIdentity>>>> = OnceLock::new();
    let key = serde_json::to_string(workspace).map_err(|error| error.to_string())?;
    let mut cache = SHELLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some(shells) = cache.get(&key) {
        return Ok(shells.clone());
    }
    let shells = match workspace {
        WorkspaceEnv::Local => {
            #[cfg(windows)]
            {
                resolve_shells(
                    &WINDOWS_SHELLS,
                    |program| {
                        let path = if program == "cmd" {
                            which::which(
                                std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
                            )
                            .ok()
                        } else {
                            which::which(program).ok()
                        };
                        path.map(|path| path.to_string_lossy().into_owned())
                    },
                    |kind, path| shell_version(kind, std::path::Path::new(path)),
                )
            }
            #[cfg(unix)]
            {
                resolve_posix_shells(
                    |path| which::which(path).is_ok(),
                    |kind, path| shell_version(kind, std::path::Path::new(path)),
                )
            }
        }
        WorkspaceEnv::Wsl { distro } => {
            #[cfg(windows)]
            {
                crate::modules::workspace::validate_wsl_distro_name(distro)?;
                let mut command = Command::new("wsl.exe");
                command.args(["-d", distro, "--exec", "/bin/sh", "-c", POSIX_SHELL_PROBE]);
                parse_posix_shell_probe(&probe_output(&mut command, Duration::from_secs(15))?)?
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                return Err("WSL is only available on Windows".into());
            }
        }
        WorkspaceEnv::Ssh { profile_id } => {
            #[cfg(feature = "workspace-runtime")]
            {
                let command = format!(
                    "/bin/sh -c {}",
                    super::quote::shell_quote(POSIX_SHELL_PROBE)
                );
                let output = remote::manager::exec_blocking(
                    profile_id,
                    &command,
                    None,
                    Duration::from_secs(15),
                )?;
                if output.timed_out || output.truncated || output.exit_code != Some(0) {
                    return Err("SSH shell discovery failed or timed out".into());
                }
                parse_posix_shell_probe(&String::from_utf8_lossy(&output.stdout))?
            }
            #[cfg(not(feature = "workspace-runtime"))]
            {
                let _ = profile_id;
                return Err("SSH requires a desktop workspace in this build".into());
            }
        }
    };
    cache.insert(key, shells.clone());
    Ok(shells)
}

/// 远端只执行封闭探测；缺少 timeout 时省略版本，不影响解释器可用性。
#[cfg(any(windows, feature = "workspace-runtime", test))]
const POSIX_SHELL_PROBE: &str = r#"printf 'TERAX_SHELLS_BEGIN\n'
for path in /bin/bash /bin/sh /bin/zsh; do
  [ -f "$path" ] && [ -x "$path" ] || continue
  printf '%s\t' "$path"
  if [ "$path" != /bin/sh ] && command -v timeout >/dev/null 2>&1; then
    timeout -k 1 3 "$path" --version 2>/dev/null | head -n 1
  fi
  printf '\n'
done
printf 'TERAX_SHELLS_END\n'"#;

#[cfg(any(windows, feature = "workspace-runtime", test))]
fn parse_posix_shell_probe(output: &str) -> Result<Vec<ShellIdentity>, String> {
    let body = output
        .trim()
        .strip_prefix("TERAX_SHELLS_BEGIN\n")
        .and_then(|value| value.strip_suffix("TERAX_SHELLS_END"))
        .ok_or("Incomplete shell discovery response")?;
    let versions: HashMap<_, _> = body
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .collect();
    Ok(resolve_posix_shells(
        |path| versions.contains_key(path),
        |_, path| parse_shell_version(versions[path]),
    ))
}

fn resolve_posix_shells(
    mut available: impl FnMut(&str) -> bool,
    probe_version: impl FnMut(ShellKind, &str) -> Option<String>,
) -> Vec<ShellIdentity> {
    resolve_shells(
        &[
            (ShellKind::Bash, "/bin/bash"),
            (ShellKind::Sh, "/bin/sh"),
            (ShellKind::Zsh, "/bin/zsh"),
        ],
        |path| available(path).then(|| path.to_string()),
        probe_version,
    )
}

#[cfg(windows)]
const WINDOWS_SHELLS: [(ShellKind, &str); 3] = [
    (ShellKind::Pwsh, "pwsh"),
    (ShellKind::Powershell, "powershell"),
    (ShellKind::Cmd, "cmd"),
];

fn resolve_shells(
    candidates: &[(ShellKind, &str)],
    mut find: impl FnMut(&str) -> Option<String>,
    mut probe_version: impl FnMut(ShellKind, &str) -> Option<String>,
) -> Vec<ShellIdentity> {
    candidates
        .iter()
        .filter_map(|&(kind, program)| {
            let executable = find(program)?;
            // 版本只是提示信息，探测失败不改变解释器可用项及默认优先级。
            let version = if matches!(kind, ShellKind::Sh | ShellKind::Cmd) {
                None
            } else {
                probe_version(kind, &executable)
            };
            Some(ShellIdentity {
                kind,
                executable,
                version,
            })
        })
        .collect()
}

/// 版本探测禁用输入，使用有界等待并清理进程树；失败仅表示版本未知。
fn shell_version(kind: ShellKind, path: &std::path::Path) -> Option<String> {
    let mut command = Command::new(path);
    match kind {
        ShellKind::Pwsh | ShellKind::Powershell => {
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "($PSVersionTable.PSVersion.Major.ToString() + '.' + $PSVersionTable.PSVersion.Minor)"]);
        }
        ShellKind::Bash | ShellKind::Zsh => {
            command.arg("--version");
        }
        _ => return None,
    }
    probe_output(&mut command, Duration::from_secs(3))
        .ok()
        .and_then(|output| parse_shell_version(&output))
}

fn probe_output(command: &mut Command, timeout: Duration) -> Result<String, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    let (child, job) =
        crate::modules::proc::job::ProcessJob::spawn(command).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        SharedChild::spawn(command).map_err(|error| error.to_string())?
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Err(_) => break None,
            Ok(None) if Instant::now() >= deadline => break None,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
        }
    };
    #[cfg(windows)]
    drop(job);
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.wait();
    if !status.is_some_and(|status| status.success()) {
        return Err("Shell probe failed or timed out".into());
    }
    let mut output = String::new();
    child
        .take_stdout()
        .ok_or("Shell probe stdout is unavailable")?
        .take(4096)
        .read_to_string(&mut output)
        .map_err(|error| error.to_string())?;
    Ok(output)
}

/// Bash、Zsh 的版本横幅和 PowerShell 的纯版本号统一缩短为主、次版本。
fn parse_shell_version(output: &str) -> Option<String> {
    let token = output
        .lines()
        .next()?
        .split_whitespace()
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()))?;
    let mut parts = token.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor: String = parts
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    Some(format!("{major}.{}", minor.parse::<u32>().ok()?))
}

fn select_shell(shells: &[ShellIdentity], shell: ShellKind) -> Result<&ShellIdentity, String> {
    let selected = if shell == ShellKind::Default {
        shells.first()
    } else {
        shells.iter().find(|entry| entry.kind == shell)
    };
    selected.ok_or_else(|| {
        format!("Selected shell {shell:?} is unavailable in the environment snapshot")
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    Default,
    Bash,
    Sh,
    Zsh,
    Pwsh,
    Powershell,
    Cmd,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Running,
    Exited,
    TimedOut,
    Terminated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProcessPurpose {
    Shell,
    #[cfg(any(feature = "workspace-runtime", test))]
    ExternalAgent,
}

struct RuntimeState {
    status: ProcessStatus,
    exit_code: Option<i32>,
    finished_at: Option<Instant>,
}

struct ProcessShared {
    output: Mutex<OutputLog>,
    state: Mutex<RuntimeState>,
    changed: Condvar,
}

impl ProcessShared {
    fn new() -> Self {
        Self {
            output: Mutex::new(OutputLog::default()),
            state: Mutex::new(RuntimeState {
                status: ProcessStatus::Running,
                exit_code: None,
                finished_at: None,
            }),
            changed: Condvar::new(),
        }
    }

    fn push(&self, stream: OutputStream, bytes: &[u8]) {
        self.output.lock().unwrap().push(stream, bytes);
        self.changed.notify_all();
    }

    fn finish_stream(&self, stream: OutputStream) {
        self.output.lock().unwrap().finish_stream(stream);
        self.changed.notify_all();
    }

    fn finish(&self, status: ProcessStatus, exit_code: Option<i32>) {
        let mut state = self.state.lock().unwrap();
        if state.status != ProcessStatus::Running {
            return;
        }
        state.status = status;
        state.exit_code = exit_code;
        state.finished_at = Some(Instant::now());
        self.compact_output();
        self.changed.notify_all();
    }

    fn compact_output(&self) {
        self.output
            .lock()
            .unwrap()
            .compact(FINISHED_OUTPUT_CAPACITY);
    }

    fn is_running(&self) -> bool {
        self.state.lock().unwrap().status == ProcessStatus::Running
    }
}

struct LocalControl {
    child: Arc<SharedChild>,
    stdin: Mutex<Option<ChildStdin>>,
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
    wsl_termination: Option<WslTermination>,
}

#[derive(Clone)]
struct WslTermination {
    distro: String,
    pid_file: String,
    cleanup_pending: Arc<AtomicBool>,
}

#[cfg(feature = "workspace-runtime")]
enum RemoteAction {
    Write(Vec<u8>, oneshot::Sender<Result<(), String>>),
    Eof(oneshot::Sender<Result<(), String>>),
    Terminate(ProcessStatus, oneshot::Sender<Result<(), String>>),
}

#[cfg(feature = "workspace-runtime")]
struct RemoteControl {
    tx: mpsc::Sender<RemoteAction>,
    workspace: Arc<remote::session::RemoteWorkspace>,
    pid_file: String,
    cleanup_pending: Arc<AtomicBool>,
}

enum ProcessControl {
    Local(Arc<LocalControl>),
    #[cfg(feature = "workspace-runtime")]
    Remote(RemoteControl),
}

pub struct AgentProcess {
    pub id: String,
    pub owner_session_id: String,
    pub workspace: WorkspaceEnv,
    pub command: String,
    pub cwd: String,
    pub shell: ShellKind,
    pub started_at_ms: u64,
    pub(crate) purpose: ProcessPurpose,
    started: Instant,
    timeout_deadline: Mutex<Option<Instant>>,
    last_access: Mutex<Instant>,
    last_read_offset: AtomicU64,
    marker: String,
    cwd_after: Mutex<Option<String>>,
    shared: Arc<ProcessShared>,
    control: ProcessControl,
    termination_lock: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
pub struct ProcessResponse {
    pub process_id: String,
    pub status: ProcessStatus,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub output_idle_ms: u64,
    pub remaining_timeout_ms: Option<u64>,
    pub truncated: bool,
    pub dropped_bytes: u64,
    pub next_offset: u64,
    pub available_from: u64,
    pub cwd: String,
    pub cwd_after: Option<String>,
    pub wait_for_matched: Option<bool>,
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pub execution_id: Option<String>,
    pub task_id: Option<String>,
    pub process_id: String,
    pub command: String,
    pub cwd: String,
    pub shell: ShellKind,
    pub workspace: &'static str,
    pub status: ProcessStatus,
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
    pub idle_ms: u64,
    pub output_idle_ms: u64,
    pub remaining_timeout_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub unread_output: bool,
}

impl AgentProcess {
    /// 启动 Local 或 WSL Agent 进程，并立即登记输出与终态监听。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_local(
        id: String,
        owner_session_id: String,
        workspace: WorkspaceEnv,
        command: String,
        cwd: String,
        shell: ShellKind,
        login: bool,
        purpose: ProcessPurpose,
    ) -> Result<Arc<Self>, String> {
        let shells = agent_shells(&workspace)?;
        let selected = select_shell(&shells, shell)?;
        let marker = format!("__TERAX_AGENT_CWD_{id}__");
        let (mut native, wsl_termination) = build_local_command(
            &id, &workspace, &command, &cwd, selected, login, &marker, purpose,
        )?;
        native
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        apply_minimal_environment(&mut native);
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
        let (child, job) = crate::modules::proc::job::ProcessJob::spawn(&mut native)
            .map_err(|error| format!("start Agent process: {error}"))?;
        #[cfg(not(windows))]
        let child = SharedChild::spawn(&mut native)
            .map_err(|error| format!("start Agent process: {error}"))?;
        let child = Arc::new(child);
        let stdin = child.take_stdin().ok_or_else(|| {
            let _ = child.kill();
            "Agent process stdin is unavailable".to_string()
        })?;
        let stdout = child.take_stdout().ok_or_else(|| {
            let _ = child.kill();
            "Agent process stdout is unavailable".to_string()
        })?;
        let stderr = child.take_stderr().ok_or_else(|| {
            let _ = child.kill();
            "Agent process stderr is unavailable".to_string()
        })?;

        let control = Arc::new(LocalControl {
            child: child.clone(),
            stdin: Mutex::new(Some(stdin)),
            #[cfg(windows)]
            job: Mutex::new(Some(job)),
            wsl_termination,
        });
        let shared = Arc::new(ProcessShared::new());
        let process = Arc::new(Self {
            id,
            owner_session_id,
            workspace,
            command,
            cwd,
            shell,
            started_at_ms: now_ms(),
            purpose,
            started: Instant::now(),
            timeout_deadline: Mutex::new(None),
            last_access: Mutex::new(Instant::now()),
            last_read_offset: AtomicU64::new(0),
            marker,
            cwd_after: Mutex::new(None),
            shared: shared.clone(),
            control: ProcessControl::Local(control.clone()),
            termination_lock: tokio::sync::Mutex::new(()),
        });

        let stdout_reader = spawn_reader(stdout, OutputStream::Stdout, shared.clone());
        let stderr_reader = spawn_reader(stderr, OutputStream::Stderr, shared);
        let waiter = Arc::downgrade(&process);
        let waited_child = child;
        let waited_control = control;
        thread::spawn(move || {
            let code = waited_child.wait().ok().and_then(|status| status.code());
            let release_posix_children = purpose == ProcessPurpose::Shell && code.is_some();
            stop_descendants_after_exit(&waited_control, release_posix_children);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            if let Some(waiter) = waiter.upgrade() {
                // 必须在输出收口后加锁，否则继承管道的后代会阻塞取消。
                // 与显式终止串行，避免正常收尾抢先删除清理失败后仍需重试的进程组登记。
                let _guard = waiter.termination_lock.blocking_lock();
                if release_posix_children && waiter.shared.is_running() {
                    if let Some(wsl) = &waited_control.wsl_termination {
                        let _ = terminate_wsl_group(wsl, true);
                    }
                }
                waiter.capture_cwd();
                waiter.shared.finish(ProcessStatus::Exited, code);
                // terminate/drop 可能先锁定终态；reader 收口后再压缩一次才是最终上限。
                waiter.shared.compact_output();
            }
        });
        Ok(process)
    }

    /// 启动 SSH exec channel，并保留其输入和输出直到命令终止。
    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "workspace-runtime")]
    pub(crate) async fn spawn_remote(
        id: String,
        owner_session_id: String,
        workspace_env: WorkspaceEnv,
        command: String,
        cwd: String,
        shell: ShellKind,
        login: bool,
        purpose: ProcessPurpose,
    ) -> Result<Arc<Self>, String> {
        let WorkspaceEnv::Ssh { profile_id } = &workspace_env else {
            return Err("remote process requires an SSH workspace".into());
        };
        let manager = remote::manager::global_manager()?;
        let workspace = manager.workspace(profile_id).await?;
        let marker = format!("__TERAX_AGENT_CWD_{id}__");
        let pid_file = format!("/tmp/terax-agent-{id}.pid");
        let shells = super::shell_environment(Some(workspace_env.clone())).await?;
        let selected = select_shell(&shells, shell)?;
        let remote_command =
            build_remote_command(&command, &cwd, selected, login, &marker, &pid_file, purpose)?;
        let channel = workspace.open_exec_channel().await?;
        channel
            .exec(true, remote_command.into_bytes())
            .await
            .map_err(|error| format!("start remote Agent process: {error}"))?;
        let (mut read, write) = channel.split();
        let (tx, mut rx) = mpsc::channel(16);
        let cleanup_pending = Arc::new(AtomicBool::new(true));
        let shared = Arc::new(ProcessShared::new());
        let process = Arc::new(Self {
            id,
            owner_session_id,
            workspace: workspace_env,
            command,
            cwd,
            shell,
            started_at_ms: now_ms(),
            purpose,
            started: Instant::now(),
            timeout_deadline: Mutex::new(None),
            last_access: Mutex::new(Instant::now()),
            last_read_offset: AtomicU64::new(0),
            marker,
            cwd_after: Mutex::new(None),
            shared: shared.clone(),
            control: ProcessControl::Remote(RemoteControl {
                tx,
                workspace: workspace.clone(),
                pid_file: pid_file.clone(),
                cleanup_pending: cleanup_pending.clone(),
            }),
            termination_lock: tokio::sync::Mutex::new(()),
        });

        let worker = Arc::downgrade(&process);
        tokio::spawn(async move {
            let mut exit_code = None;
            loop {
                tokio::select! {
                    message = read.wait() => match message {
                        Some(ChannelMsg::Data { data }) => {
                            if let Some(worker) = worker.upgrade() {
                                worker.shared.push(OutputStream::Stdout, &data);
                            } else {
                                let _ = write.close().await;
                                return;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if let Some(worker) = worker.upgrade() {
                                worker.shared.push(OutputStream::Stderr, &data);
                            } else {
                                let _ = write.close().await;
                                return;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status as i32);
                        }
                        Some(ChannelMsg::ExitSignal { .. }) => {
                            exit_code = None;
                        }
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    action = rx.recv() => match action {
                        Some(RemoteAction::Write(bytes, reply)) => {
                            let result = write.data_bytes(bytes).await
                                .map_err(|error| format!("write remote stdin: {error}"));
                            let _ = reply.send(result);
                        }
                        Some(RemoteAction::Eof(reply)) => {
                            let result = write.eof().await
                                .map_err(|error| format!("close remote stdin: {error}"));
                            let _ = reply.send(result);
                        }
                        Some(RemoteAction::Terminate(status, reply)) => {
                            let kill = remote_group_kill(&workspace, &pid_file, false).await;
                            if kill.is_ok() { cleanup_pending.store(false, Ordering::Release); }
                            let _ = write.signal(Sig::TERM).await;
                            let _ = write.signal(Sig::KILL).await;
                            let _ = write.close().await;
                            if let Some(worker) = worker.upgrade() {
                                worker.shared.finish_stream(OutputStream::Stdout);
                                worker.shared.finish_stream(OutputStream::Stderr);
                                worker.capture_cwd();
                                worker.shared.finish(status, None);
                            }
                            let _ = reply.send(kill);
                            return;
                        }
                        None => {
                            let _ = write.close().await;
                            break;
                        }
                    }
                }
            }
            // 连接丢失不等于命令正常完成；只有收到退出状态才允许释放后台后代。
            if remote_group_kill(&workspace, &pid_file, exit_code.is_some())
                .await
                .is_ok()
            {
                cleanup_pending.store(false, Ordering::Release);
            }
            if let Some(worker) = worker.upgrade() {
                worker.shared.finish_stream(OutputStream::Stdout);
                worker.shared.finish_stream(OutputStream::Stderr);
                worker.capture_cwd();
                worker.shared.finish(ProcessStatus::Exited, exit_code);
            }
            let _ = write.close().await;
        });
        Ok(process)
    }

    /// 写入进程 stdin，内容不做换行或编码改写。
    pub async fn write(&self, input: String) -> Result<(), String> {
        self.touch();
        if !self.shared.is_running() {
            return Err("Agent process has already exited".into());
        }
        match &self.control {
            ProcessControl::Local(control) => {
                let control = control.clone();
                tokio::task::spawn_blocking(move || {
                    let mut stdin = control.stdin.lock().unwrap();
                    let stdin = stdin
                        .as_mut()
                        .ok_or_else(|| "Agent process stdin is closed".to_string())?;
                    stdin
                        .write_all(input.as_bytes())
                        .and_then(|_| stdin.flush())
                        .map_err(|error| format!("write Agent process stdin: {error}"))
                })
                .await
                .map_err(|error| error.to_string())?
            }
            #[cfg(feature = "workspace-runtime")]
            ProcessControl::Remote(control) => {
                let (reply, result) = oneshot::channel();
                control
                    .tx
                    .send(RemoteAction::Write(input.into_bytes(), reply))
                    .await
                    .map_err(|_| "remote Agent process is unavailable".to_string())?;
                result
                    .await
                    .map_err(|_| "remote Agent process stopped before stdin write".to_string())?
            }
        }
    }

    /// 关闭进程 stdin，但继续保留输出读取和终态等待。
    pub async fn close_stdin(&self) -> Result<(), String> {
        self.touch();
        match &self.control {
            ProcessControl::Local(control) => {
                control.stdin.lock().unwrap().take();
                Ok(())
            }
            #[cfg(feature = "workspace-runtime")]
            ProcessControl::Remote(control) => {
                let (reply, result) = oneshot::channel();
                control
                    .tx
                    .send(RemoteAction::Eof(reply))
                    .await
                    .map_err(|_| "remote Agent process is unavailable".to_string())?;
                result
                    .await
                    .map_err(|_| "remote Agent process stopped before EOF".to_string())?
            }
        }
    }

    /// 终止完整受管进程树，并锁定指定终态。
    pub async fn terminate_as(&self, status: ProcessStatus) -> Result<(), String> {
        self.touch();
        // 并发停止必须等待同一次进程树清理结束，不能仅凭提前写入的终态返回。
        let _guard = self.termination_lock.lock().await;
        if !self.shared.is_running() {
            let release_exited = self.shared.state.lock().unwrap().status == ProcessStatus::Exited;
            match &self.control {
                ProcessControl::Local(control) => {
                    if let Some(wsl) = control
                        .wsl_termination
                        .clone()
                        .filter(|wsl| wsl.cleanup_pending.load(Ordering::Acquire))
                    {
                        tokio::task::spawn_blocking(move || {
                            terminate_wsl_group(&wsl, release_exited)
                        })
                        .await
                        .map_err(|error| error.to_string())??;
                    }
                }
                #[cfg(feature = "workspace-runtime")]
                ProcessControl::Remote(control) => {
                    if control.cleanup_pending.load(Ordering::Acquire) {
                        remote_group_kill(&control.workspace, &control.pid_file, release_exited)
                            .await?;
                        control.cleanup_pending.store(false, Ordering::Release);
                    }
                }
            }
            return Ok(());
        }
        match &self.control {
            ProcessControl::Local(control) => {
                // 先锁定调用方终态，避免 Job Object 关闭后 wait 线程抢先写成 Exited。
                self.shared.finish(status, None);
                let control = control.clone();
                tokio::task::spawn_blocking(move || terminate_local(&control))
                    .await
                    .map_err(|error| error.to_string())??;
                self.capture_cwd();
                self.shared.compact_output();
                Ok(())
            }
            #[cfg(feature = "workspace-runtime")]
            ProcessControl::Remote(control) => {
                let (reply, result) = oneshot::channel();
                if control
                    .tx
                    .send(RemoteAction::Terminate(status, reply))
                    .await
                    .is_ok()
                {
                    if let Ok(result) = result.await {
                        return result;
                    }
                }
                // Channel 关闭后仍可能有远端子孙，保留连接与 pid 文件以便重试。
                remote_group_kill(&control.workspace, &control.pid_file, false).await?;
                control.cleanup_pending.store(false, Ordering::Release);
                self.shared.finish_stream(OutputStream::Stdout);
                self.shared.finish_stream(OutputStream::Stderr);
                self.capture_cwd();
                self.shared.finish(status, None);
                Ok(())
            }
        }
    }

    /// 等待输出、目标文本或终态，然后返回当前增量快照。
    pub fn wait_snapshot(
        &self,
        since: u64,
        wait: Duration,
        wait_for: Option<&str>,
        max_bytes: usize,
    ) -> ProcessResponse {
        self.touch();
        let deadline = Instant::now() + wait;
        let mut guard = self.shared.state.lock().unwrap();
        let mut matched = None;
        loop {
            let found = wait_for.is_some_and(|needle| {
                let output = self
                    .shared
                    .output
                    .lock()
                    .unwrap()
                    .read(since, INTERNAL_READ_LIMIT);
                output.stdout.contains(needle) || output.stderr.contains(needle)
            });
            if wait_for.is_some() {
                matched = Some(found);
            }
            if found || guard.status != ProcessStatus::Running || Instant::now() >= deadline {
                break;
            }
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100));
            let (next, _) = self.shared.changed.wait_timeout(guard, remaining).unwrap();
            guard = next;
        }
        drop(guard);
        let mut response = self.response(since, max_bytes);
        response.wait_for_matched = matched;
        response
    }

    /// 等待输出 offset 前移或进程进入终态，用于把受管进程桥接为推送事件。
    #[cfg(feature = "workspace-runtime")]
    pub fn wait_for_change(&self, since: u64, wait: Duration, max_bytes: usize) -> ProcessResponse {
        self.touch();
        let deadline = Instant::now() + wait;
        let mut guard = self.shared.state.lock().unwrap();
        loop {
            let has_output = self.shared.output.lock().unwrap().next_offset() > since;
            if has_output || guard.status != ProcessStatus::Running || Instant::now() >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (next, _) = self.shared.changed.wait_timeout(guard, remaining).unwrap();
            guard = next;
        }
        drop(guard);
        self.response(since, max_bytes)
    }

    pub fn response(&self, since: u64, max_bytes: usize) -> ProcessResponse {
        self.touch();
        let output = self.shared.output.lock().unwrap().read(since, max_bytes);
        self.response_from(output)
    }

    pub fn info(&self) -> ProcessInfo {
        let state = self.shared.state.lock().unwrap();
        let last_access = *self.last_access.lock().unwrap();
        ProcessInfo {
            execution_id: None,
            task_id: None,
            process_id: self.id.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            shell: self.shell,
            workspace: workspace_name(&self.workspace),
            status: state.status,
            started_at_ms: self.started_at_ms,
            elapsed_ms: elapsed_ms(self.started, state.finished_at),
            idle_ms: last_access.elapsed().as_millis() as u64,
            output_idle_ms: self.output_idle_ms(state.finished_at),
            remaining_timeout_ms: self.remaining_timeout_ms(state.status),
            exit_code: state.exit_code,
            unread_output: self.shared.output.lock().unwrap().next_offset()
                > self.last_read_offset.load(Ordering::Acquire),
        }
    }

    pub fn is_running(&self) -> bool {
        self.shared.is_running()
    }

    /// 硬截止时间仅在启动时设置，轮询、写入和输出不会延长预算。
    pub fn set_timeout(&self, timeout: Duration) -> Instant {
        let deadline = Instant::now() + timeout;
        *self.timeout_deadline.lock().unwrap() = Some(deadline);
        deadline
    }

    fn output_idle_ms(&self, finished_at: Option<Instant>) -> u64 {
        let last = self
            .shared
            .output
            .lock()
            .unwrap()
            .last_output_at()
            .unwrap_or(self.started);
        finished_at
            .unwrap_or_else(Instant::now)
            .saturating_duration_since(last)
            .as_millis() as u64
    }

    fn remaining_timeout_ms(&self, status: ProcessStatus) -> Option<u64> {
        self.timeout_deadline.lock().unwrap().map(|deadline| {
            if status == ProcessStatus::Running {
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64
            } else {
                0
            }
        })
    }

    /// 清理失败的远端进程仍占资源额度，不能按普通已完成记录淘汰。
    pub fn holds_resources(&self) -> bool {
        self.is_running()
            || self.termination_lock.try_lock().is_err()
            || match &self.control {
                ProcessControl::Local(control) => control
                    .wsl_termination
                    .as_ref()
                    .is_some_and(|wsl| wsl.cleanup_pending.load(Ordering::Acquire)),
                #[cfg(feature = "workspace-runtime")]
                ProcessControl::Remote(control) => control.cleanup_pending.load(Ordering::Acquire),
            }
    }

    pub fn finished_age(&self) -> Option<Duration> {
        self.shared
            .state
            .lock()
            .unwrap()
            .finished_at
            .map(|finished| finished.elapsed())
    }

    /// 应用关闭或注册表丢弃时立即撤销进程所有权，不等待温和终止宽限期。
    pub fn stop_on_drop(&self) {
        if !self.shared.is_running() {
            return;
        }
        self.shared.finish(ProcessStatus::Terminated, None);
        match &self.control {
            ProcessControl::Local(control) => stop_local_now(control),
            #[cfg(feature = "workspace-runtime")]
            ProcessControl::Remote(control) => {
                let (reply, _) = oneshot::channel();
                let _ = control
                    .tx
                    .try_send(RemoteAction::Terminate(ProcessStatus::Terminated, reply));
            }
        }
    }

    fn response_from(&self, mut output: OutputSlice) -> ProcessResponse {
        let parsed = strip_cwd_marker(&output.stdout, &self.marker);
        output.stdout = parsed.0;
        if let Some(cwd) = parsed.1 {
            *self.cwd_after.lock().unwrap() = Some(cwd);
        }
        let state = self.shared.state.lock().unwrap();
        self.last_read_offset
            .fetch_max(output.next_offset, Ordering::AcqRel);
        ProcessResponse {
            process_id: self.id.clone(),
            status: state.status,
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code: state.exit_code,
            elapsed_ms: elapsed_ms(self.started, state.finished_at),
            output_idle_ms: self.output_idle_ms(state.finished_at),
            remaining_timeout_ms: self.remaining_timeout_ms(state.status),
            truncated: output.truncated || output.dropped_bytes > 0,
            dropped_bytes: output.dropped_bytes,
            next_offset: output.next_offset,
            available_from: output.available_from,
            cwd: self.cwd.clone(),
            cwd_after: self.cwd_after.lock().unwrap().clone(),
            wait_for_matched: None,
        }
    }

    fn capture_cwd(&self) {
        let output = self
            .shared
            .output
            .lock()
            .unwrap()
            .read(0, INTERNAL_READ_LIMIT);
        if let Some(cwd) = strip_cwd_marker(&output.stdout, &self.marker).1 {
            *self.cwd_after.lock().unwrap() = Some(cwd);
        }
    }

    fn touch(&self) {
        *self.last_access.lock().unwrap() = Instant::now();
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.stop_on_drop();
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: OutputStream,
    shared: Arc<ProcessShared>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => shared.push(stream, &buffer[..read]),
                Err(_) => break,
            }
        }
        shared.finish_stream(stream);
    })
}

fn terminate_local(control: &LocalControl) -> Result<(), String> {
    control.stdin.lock().unwrap().take();
    let cleanup = control
        .wsl_termination
        .as_ref()
        .map(|wsl| terminate_wsl_group(wsl, false))
        .transpose();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(control.child.id() as libc::pid_t), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        control.job.lock().unwrap().take();
    }
    #[cfg(unix)]
    thread::sleep(TERMINATE_GRACE);
    #[cfg(unix)]
    unsafe {
        // 主 Shell 可能先响应 TERM 退出，子孙仍须收到进程组 KILL。
        libc::kill(-(control.child.id() as libc::pid_t), libc::SIGKILL);
    }
    if control.child.try_wait().ok().flatten().is_none() {
        let _ = control.child.kill();
    }
    cleanup.map(|_| ())
}

fn stop_local_now(control: &LocalControl) {
    control.stdin.lock().unwrap().take();
    if let Some(wsl) = &control.wsl_termination {
        let wsl = wsl.clone();
        thread::spawn(move || terminate_wsl_group(&wsl, false));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(control.child.id() as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        control.job.lock().unwrap().take();
    }
    let _ = control.child.kill();
}

fn stop_descendants_after_exit(control: &LocalControl, release_posix_children: bool) {
    control.stdin.lock().unwrap().take();
    if !release_posix_children {
        if let Some(wsl) = &control.wsl_termination {
            let _ = terminate_wsl_group(wsl, false);
        }
    }
    #[cfg(unix)]
    if !release_posix_children {
        unsafe {
            libc::kill(-(control.child.id() as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        control.job.lock().unwrap().take();
    }
}

fn terminate_wsl_group(termination: &WslTermination, release_exited: bool) -> Result<(), String> {
    crate::modules::proc::group::terminate_wsl_group(
        &termination.distro,
        &termination.pid_file,
        release_exited,
    )?;
    termination.cleanup_pending.store(false, Ordering::Release);
    Ok(())
}

#[cfg(feature = "workspace-runtime")]
async fn remote_group_kill(
    workspace: &Arc<remote::session::RemoteWorkspace>,
    pid_file: &str,
    release_exited: bool,
) -> Result<(), String> {
    workspace
        .terminate_process_group(pid_file, release_exited)
        .await
}

/// 构造本地或 WSL 命令，进程身份仅用于 WSL 进程组控制文件。
#[allow(clippy::too_many_arguments)]
fn build_local_command(
    _id: &str,
    workspace: &WorkspaceEnv,
    command: &str,
    cwd: &str,
    identity: &ShellIdentity,
    login: bool,
    marker: &str,
    _purpose: ProcessPurpose,
) -> Result<(Command, Option<WslTermination>), String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        crate::modules::workspace::validate_wsl_distro_name(distro)?;
        posix_shell(identity.kind)?;
        let shell_program = identity.executable.as_str();
        let payload = posix_payload(command, marker);
        let pid_file = format!("/tmp/terax-agent-{_id}.pid");
        let wrapper = posix_group_wrapper(&payload, &pid_file, shell_program, login, _purpose);
        let mut native = Command::new("wsl.exe");
        native.args(["-d", distro]);
        if !cwd.trim().is_empty() {
            native.args(["--cd", cwd]);
        }
        native.args(["--exec", "setsid", "--wait", "/bin/sh", "-c", &wrapper]);
        return Ok((
            native,
            Some(WslTermination {
                distro: distro.clone(),
                pid_file,
                cleanup_pending: Arc::new(AtomicBool::new(true)),
            }),
        ));
    }
    #[cfg(not(windows))]
    if workspace.is_wsl() {
        return Err("WSL Agent processes are only available on Windows".into());
    }

    if workspace.is_ssh() {
        return Err("SSH Agent processes require the remote backend".into());
    }
    #[cfg(unix)]
    {
        let shell_program = identity.executable.as_str();
        let mut native = Command::new(shell_program);
        if login {
            if !matches!(shell_program, "/bin/bash" | "/bin/zsh") {
                return Err("login is only supported by bash or zsh".into());
            }
            native.arg("-l");
        }
        native.arg("-c").arg(posix_payload(command, marker));
        native.current_dir(cwd);
        Ok((native, None))
    }
    #[cfg(windows)]
    {
        if login {
            return Err("login is not supported by Windows shells".into());
        }
        let mut native = match identity.kind {
            ShellKind::Cmd => {
                let mut command_line = Command::new(&identity.executable);
                command_line.args(["/D", "/V:ON", "/C"]);
                command_line.arg(format!(
                    "{command}\r\n\r\nset \"__terax_rc=!ERRORLEVEL!\"\r\necho {marker}%CD%\r\nexit /b !__terax_rc!"
                ));
                command_line
            }
            _ => {
                let mut command_line = Command::new(&identity.executable);
                command_line.args(["-NoLogo", "-NoProfile", "-Command"]);
                // 在格式化管道完成前保存命令状态；直接 exit 会丢失延迟格式化的对象输出。
                // 动态解析使语法错误也能进入 catch，避免 -Command 静默退出。
                let script = format!(
                    "{command}\n\n$__terax_rc = if ($?) {{ 0 }} elseif ($LASTEXITCODE) {{ $LASTEXITCODE }} else {{ 1 }}"
                );
                // PowerShell 将弯引号也视为单引号分隔符，嵌入源码时一并双写。
                let mut quoted = String::new();
                for character in script.chars() {
                    quoted.push(character);
                    if matches!(character, '\'' | '‘' | '’' | '‚' | '‛') {
                        quoted.push(character);
                    }
                }
                command_line.arg(format!(
                    "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\ntry {{\n$__terax_script = [scriptblock]::Create('{quoted}')\n}} catch {{\n[Console]::Error.WriteLine($_.ToString())\nexit 1\n}}\n. $__terax_script | Out-Default\n[Console]::WriteLine(\"{marker}$($PWD.Path)\")\nexit $__terax_rc"
                ));
                command_line
            }
        };
        native.current_dir(cwd);
        Ok((native, None))
    }
}

#[cfg(any(feature = "workspace-runtime", test))]
fn build_remote_command(
    command: &str,
    cwd: &str,
    identity: &ShellIdentity,
    login: bool,
    marker: &str,
    pid_file: &str,
    purpose: ProcessPurpose,
) -> Result<String, String> {
    posix_shell(identity.kind)?;
    let shell_program = identity.executable.as_str();
    let payload = posix_payload(command, marker);
    let command = format!(
        "cd -- {} && {payload}",
        crate::modules::shell::quote::shell_quote(cwd),
    );
    let wrapper = posix_group_wrapper(&command, pid_file, shell_program, login, purpose);
    let trap = format!(
        "if read -r pid < {}; then kill -TERM -\"$pid\" 2>/dev/null || true; fi",
        crate::modules::shell::quote::shell_quote(pid_file)
    );
    Ok(format!(
        "command -v setsid >/dev/null 2>&1 || exit 72; trap {} TERM INT HUP; setsid --wait /bin/sh -c {}; rc=$?; trap - TERM INT HUP; exit $rc",
        crate::modules::shell::quote::shell_quote(&trap),
        crate::modules::shell::quote::shell_quote(&wrapper),
    ))
}

#[cfg(any(feature = "workspace-runtime", windows, test))]
fn posix_group_wrapper(
    payload: &str,
    pid_file: &str,
    shell: &str,
    login: bool,
    purpose: ProcessPurpose,
) -> String {
    crate::modules::proc::group::posix_group_wrapper(
        payload,
        pid_file,
        shell,
        login,
        purpose == ProcessPurpose::Shell,
    )
}

fn posix_payload(command: &str, marker: &str) -> String {
    format!(
        "{command}\n\n__terax_rc=$?\nprintf '\\n%s%s\\n' '{}' \"$(pwd)\"\nexit $__terax_rc",
        marker
    )
}

#[cfg(any(windows, feature = "workspace-runtime", test))]
fn posix_shell(shell: ShellKind) -> Result<&'static str, String> {
    match shell {
        ShellKind::Bash => Ok("/bin/bash"),
        ShellKind::Default => {
            Err("default shell must be resolved from the environment snapshot".into())
        }
        ShellKind::Sh => Ok("/bin/sh"),
        ShellKind::Zsh => Ok("/bin/zsh"),
        ShellKind::Pwsh | ShellKind::Powershell | ShellKind::Cmd => {
            Err("selected shell is not supported by a POSIX workspace".into())
        }
    }
}

fn apply_minimal_environment(command: &mut Command) {
    command.env_clear();
    #[cfg(unix)]
    for key in ["HOME", "PATH", "LANG", "LC_ALL", "TERM", "TMPDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(unix)]
    for (key, value) in crate::modules::workspace::appimage_env_overrides() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    #[cfg(windows)]
    for key in [
        "SYSTEMROOT",
        "COMSPEC",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "TEMP",
        "TMP",
        "PATH",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("TERAX_AGENT_SHELL", "1");
}

fn strip_cwd_marker(stdout: &str, marker: &str) -> (String, Option<String>) {
    let Some(index) = stdout.rfind(marker) else {
        return (stdout.to_string(), None);
    };
    let after = &stdout[index + marker.len()..];
    let cwd = after.lines().next().unwrap_or("").trim();
    if cwd.is_empty() {
        return (stdout.to_string(), None);
    }
    (
        stdout[..index].trim_end_matches(['\r', '\n']).to_string(),
        Some(cwd.replace('\\', "/")),
    )
}

fn workspace_name(workspace: &WorkspaceEnv) -> &'static str {
    match workspace {
        WorkspaceEnv::Local => "local",
        WorkspaceEnv::Wsl { .. } => "wsl",
        WorkspaceEnv::Ssh { .. } => "ssh",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn elapsed_ms(started: Instant, finished_at: Option<Instant>) -> u64 {
    finished_at
        .unwrap_or_else(Instant::now)
        .saturating_duration_since(started)
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    #[test]
    fn posix_group_cleanup_reports_signal_failure_and_keeps_retry_file() {
        // Windows 开发环境可选装 POSIX Shell；Unix 上必须能够执行真实脚本。
        if let Err(error) = Command::new("sh").args(["-c", "exit 0"]).status() {
            #[cfg(windows)]
            if error.kind() == std::io::ErrorKind::NotFound {
                return;
            }
            panic!("POSIX Shell unavailable: {error}");
        }
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("process.pid");
        let script_path = if cfg!(windows) {
            // Git Bash 接受 Windows 绝对路径中的正斜杠。
            pid_file.to_string_lossy().replace('\\', "/")
        } else {
            pid_file.to_string_lossy().into_owned()
        };
        let script = posix_group_kill_command(&script_path, false);
        for (kill, success) in [
            ("", true),
            ("kill() { printf '%s\n' 'kill: Operation not permitted' >&2; return 1; };", false),
            ("kill() { [ \"$1\" = -TERM ] && return 0; printf '%s\n' 'kill: Operation not permitted' >&2; return 1; };", false),
            ("kill() { [ \"$1\" = -TERM ] && return 0; printf '%s\n' 'kill: No such process' >&2; return 1; };", true),
        ] {
            std::fs::write(&pid_file, "2147483647\n").unwrap();
            let output = Command::new("sh").arg("-c")
                .arg(format!("sleep() {{ :; }}; {kill}\n{script}"))
                .output().unwrap();
            assert_eq!(output.status.success(), success, "{}", String::from_utf8_lossy(&output.stderr));
            assert_eq!(pid_file.exists(), !success);
            if !success {
                assert!(String::from_utf8_lossy(&output.stderr).contains("Operation not permitted"));
            }
        }
    }

    use super::*;

    fn interactive_command() -> &'static str {
        #[cfg(windows)]
        {
            "$line = [Console]::In.ReadLine(); Write-Output \"got:$line\""
        }
        #[cfg(unix)]
        {
            "IFS= read -r line; printf 'got:%s\\n' \"$line\""
        }
    }

    #[test]
    fn strips_only_the_process_specific_cwd_marker() {
        let marker = "__TERAX_AGENT_CWD_id__";
        let (stdout, cwd) = strip_cwd_marker(
            "visible\n__TERAX_AGENT_CWD_other__/bad\n__TERAX_AGENT_CWD_id__/work\n",
            marker,
        );
        assert!(stdout.contains("other"));
        assert_eq!(cwd.as_deref(), Some("/work"));
    }

    #[test]
    fn remote_wrapper_quotes_cwd_and_command() {
        let command = build_remote_command(
            "printf \"it's fine\"",
            "/srv/it's here",
            &ShellIdentity {
                kind: ShellKind::Bash,
                executable: "/bin/bash".into(),
                version: None,
            },
            false,
            "marker",
            "/tmp/pid",
            ProcessPurpose::Shell,
        )
        .unwrap();
        assert!(command.contains("setsid"));
        assert!(command.contains("/tmp/pid"));
        assert!(command.contains("/srv/"));
    }

    #[test]
    fn rejects_windows_shells_for_remote_processes() {
        let result = build_remote_command(
            "echo ok",
            "/tmp",
            &ShellIdentity {
                kind: ShellKind::Powershell,
                executable: "powershell".into(),
                version: None,
            },
            false,
            "marker",
            "/tmp/pid",
            ProcessPurpose::Shell,
        );
        assert!(result.is_err());
    }

    #[test]
    fn posix_command_builders_require_a_resolved_default() {
        assert!(posix_shell(ShellKind::Default).is_err());
        assert_eq!(posix_shell(ShellKind::Bash).unwrap(), "/bin/bash");
    }

    #[test]
    fn posix_snapshot_selects_first_available_without_requiring_versions() {
        let shells = resolve_posix_shells(|path| path != "/bin/bash", |_, _| None);
        assert_eq!(
            shells
                .iter()
                .map(|entry| entry.executable.as_str())
                .collect::<Vec<_>>(),
            ["/bin/sh", "/bin/zsh"]
        );
        assert!(shells.iter().all(|entry| entry.version.is_none()));
        assert_eq!(
            select_shell(&shells, ShellKind::Default)
                .unwrap()
                .executable,
            "/bin/sh"
        );
        assert!(select_shell(&shells, ShellKind::Bash).is_err());
        let only_zsh = resolve_posix_shells(|path| path == "/bin/zsh", |_, _| None);
        assert_eq!(
            select_shell(&only_zsh, ShellKind::Default)
                .unwrap()
                .executable,
            "/bin/zsh"
        );
        assert!(select_shell(&[], ShellKind::Default).is_err());
        assert_eq!(
            select_shell(&shells, ShellKind::Sh).unwrap().executable,
            "/bin/sh"
        );
        assert_eq!(
            select_shell(&shells, ShellKind::Zsh).unwrap().executable,
            "/bin/zsh"
        );
        let shells = resolve_posix_shells(
            |_| true,
            |kind, path| {
                assert_ne!(kind, ShellKind::Sh);
                (path == "/bin/bash").then(|| "5.2".into())
            },
        );
        assert_eq!(
            select_shell(&shells, ShellKind::Default)
                .unwrap()
                .executable,
            "/bin/bash"
        );
        assert_eq!(shells[0].version.as_deref(), Some("5.2"));
        assert!(shells[2].version.is_none());
    }

    #[test]
    fn remote_shell_probe_preserves_availability_when_versions_are_missing() {
        let shells = parse_posix_shell_probe(
            "TERAX_SHELLS_BEGIN\n/bin/sh\t\n/bin/zsh\tzsh 5.9 (linux)\n\nTERAX_SHELLS_END\n",
        )
        .unwrap();
        assert_eq!(
            select_shell(&shells, ShellKind::Default).unwrap().kind,
            ShellKind::Sh
        );
        assert!(select_shell(&shells, ShellKind::Bash).is_err());
        assert!(shells[0].version.is_none());
        assert_eq!(shells[1].version.as_deref(), Some("5.9"));
        assert!(
            parse_posix_shell_probe("TERAX_SHELLS_BEGIN\nTERAX_SHELLS_END\n")
                .unwrap()
                .is_empty()
        );
        assert!(parse_posix_shell_probe("connection error").is_err());
        assert!(parse_posix_shell_probe("TERAX_SHELLS_BEGIN\n/bin/bash\t").is_err());
    }

    #[test]
    fn shell_version_banners_keep_only_major_and_minor() {
        for (output, expected) in [
            (
                "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\nCopyright",
                Some("5.2"),
            ),
            (
                "GNU bash, version 3.2.57(1)-release (arm64-apple-darwin)",
                Some("3.2"),
            ),
            ("zsh 5.9 (x86_64-ubuntu-linux-gnu)", Some("5.9")),
            ("7.6\r\n", Some("7.6")),
            ("", None),
            ("not available", None),
            ("5.invalid", None),
        ] {
            assert_eq!(parse_shell_version(output).as_deref(), expected);
        }
    }

    #[cfg(unix)]
    #[test]
    fn local_posix_snapshot_matches_execution_and_reported_version() {
        let shells = agent_shells(&WorkspaceEnv::Local).unwrap();
        for identity in &shells {
            let (mut command, _) = build_local_command(
                "identity",
                &WorkspaceEnv::Local,
                "printf '%s\\n' ready",
                "/tmp",
                identity,
                false,
                "__CWD__",
                ProcessPurpose::Shell,
            )
            .unwrap();
            assert_eq!(
                command.get_program(),
                std::ffi::OsStr::new(&identity.executable)
            );
            assert!(command.output().unwrap().status.success());
            if identity.kind == ShellKind::Sh {
                assert!(identity.version.is_none());
            }
            if let Some(version) = &identity.version {
                assert_eq!(version.split('.').count(), 2);
                assert_eq!(
                    shell_version(identity.kind, std::path::Path::new(&identity.executable))
                        .as_ref(),
                    Some(version)
                );
            }
        }
        let default = select_shell(&shells, ShellKind::Default).and_then(|identity| {
            build_local_command(
                "default",
                &WorkspaceEnv::Local,
                "printf ready",
                "/tmp",
                identity,
                false,
                "__CWD__",
                ProcessPurpose::Shell,
            )
        });
        if let Some(first) = shells.first() {
            assert_eq!(
                default.unwrap().0.get_program(),
                std::ffi::OsStr::new(&first.executable)
            );
        } else {
            assert!(default.is_err());
        }
    }

    #[test]
    fn minimal_environment_marks_agent_and_unbuffers_python() {
        let mut command = Command::new("unused");
        apply_minimal_environment(&mut command);
        let env: std::collections::HashMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect();

        assert_eq!(
            env.get(std::ffi::OsStr::new("TERAX_AGENT_SHELL")).unwrap(),
            "1"
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("PYTHONUNBUFFERED")).unwrap(),
            "1"
        );
        assert!(!env.keys().any(|key| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            key.contains("TOKEN") || key.contains("SECRET") || key.contains("API_KEY")
        }));
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_selection_preserves_priority_and_explicit_identity() {
        for available in [
            vec!["pwsh", "powershell", "cmd"],
            vec!["powershell", "cmd"],
            vec!["cmd"],
            vec![],
        ] {
            // 模拟全部版本探测失败，路径存在的解释器仍必须保留。
            let shells = resolve_shells(
                &WINDOWS_SHELLS,
                |name| {
                    available
                        .contains(&name)
                        .then(|| format!("C:/shells/{name}.exe"))
                },
                |_, _| None,
            );
            assert!(shells.iter().all(|shell| shell.version.is_none()));
            assert_eq!(shells.len(), available.len());
            if let Some(first) = shells.first() {
                assert_eq!(first.executable, format!("C:/shells/{}.exe", available[0]));
                assert_eq!(
                    select_shell(&shells, ShellKind::Default)
                        .unwrap()
                        .executable,
                    first.executable
                );
            } else {
                assert!(select_shell(&shells, ShellKind::Default).is_err());
            }
            for (name, kind) in [
                ("pwsh", ShellKind::Pwsh),
                ("powershell", ShellKind::Powershell),
                ("cmd", ShellKind::Cmd),
            ] {
                let selected = select_shell(&shells, kind);
                if available.contains(&name) {
                    assert_eq!(
                        selected.unwrap().executable,
                        format!("C:/shells/{name}.exe")
                    );
                } else {
                    assert!(selected.is_err());
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn cmd_becomes_default_without_powershell_and_snapshot_stays_fixed() {
        const CHILD: &str = "TERAX_CMD_DEFAULT_TEST";
        if std::env::var_os(CHILD).is_none() {
            // 独立进程隔离 PATH 和 OnceLock，避免影响并行测试。
            let directory = tempfile::tempdir().unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "modules::shell::process::tests::cmd_becomes_default_without_powershell_and_snapshot_stays_fixed"])
                .env(CHILD, std::env::var_os("PATH").unwrap())
                .env("PATH", directory.path())
                .current_dir(directory.path())
                .output().unwrap();
            assert!(output.status.success(), "{:?}", output);
            return;
        }
        let workspace = WorkspaceEnv::Local;
        let shells = agent_shells(&workspace).unwrap();
        assert_eq!(shells.len(), 1);
        assert_eq!(shells[0].kind, ShellKind::Cmd);
        std::env::set_var("PATH", std::env::var_os(CHILD).unwrap());
        assert_eq!(agent_shells(&workspace).unwrap().len(), 1);
        let cwd = std::env::current_dir().unwrap();
        for shell in [ShellKind::Pwsh, ShellKind::Powershell] {
            assert!(select_shell(&shells, shell).is_err());
        }
        for shell in [ShellKind::Default, ShellKind::Cmd] {
            let (mut command, _) = build_local_command(
                "cmd",
                &workspace,
                "echo ready",
                cwd.to_str().unwrap(),
                select_shell(&shells, shell).unwrap(),
                false,
                "__CWD__",
                ProcessPurpose::Shell,
            )
            .unwrap();
            assert_eq!(
                command.get_program(),
                std::ffi::OsStr::new(&shells[0].executable)
            );
            let output = command.output().unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8(output.stdout).unwrap().contains("ready"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn powershell_selectors_execute_the_reported_program_version_and_utf8_script() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("check.ps1");
        let shells = agent_shells(&WorkspaceEnv::Local).unwrap();
        for identity in shells
            .iter()
            .filter(|entry| matches!(entry.kind, ShellKind::Pwsh | ShellKind::Powershell))
        {
            // Windows PowerShell 的脚本读取使用 BOM；pwsh 验证无 BOM 中文脚本。
            let bom = if identity.kind == ShellKind::Powershell {
                "\u{feff}"
            } else {
                ""
            };
            std::fs::write(&script, format!("{bom}[Console]::WriteLine('中文脚本'); [Console]::WriteLine((Get-Process -Id $PID).Path); [Console]::WriteLine(($PSVersionTable.PSVersion.Major.ToString() + '.' + $PSVersionTable.PSVersion.Minor))")).unwrap();
            let (mut command, _) = build_local_command(
                "identity",
                &WorkspaceEnv::Local,
                "& './check.ps1'",
                directory.path().to_str().unwrap(),
                identity,
                false,
                "__CWD__",
                ProcessPurpose::Shell,
            )
            .unwrap();
            assert_eq!(
                command.get_program(),
                std::ffi::OsStr::new(&identity.executable)
            );
            let output = command.output().unwrap();
            assert!(output.status.success());
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(stdout.contains("中文脚本"));
            assert_eq!(
                std::fs::canonicalize(stdout.lines().nth(1).unwrap()).unwrap(),
                std::fs::canonicalize(&identity.executable).unwrap()
            );
            if let Some(version) = &identity.version {
                assert_eq!(version.split('.').count(), 2);
                assert_eq!(stdout.lines().nth(2), Some(version.as_str()));
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_objects_errors_and_native_status_survive_wrapping() {
        let directory = tempfile::tempdir().unwrap();
        for shell in [ShellKind::Pwsh, ShellKind::Powershell] {
            if select_shell(&agent_shells(&WorkspaceEnv::Local).unwrap(), shell).is_err() {
                continue;
            }
            // 测试只依赖系统模块，避免命令发现扫描用户和 runner 安装的模块。
            for (command, code, stdout, stderr) in [
                (
                    "[pscustomobject]@{Name='hello';Value=1}; 'after'",
                    0,
                    "after",
                    "",
                ),
                (
                    "$PSModuleAutoLoadingPreference = 'None'; & $env:ComSpec /d /c exit 0; missing_terax_test_command",
                    1,
                    "",
                    "missing_terax_test_command",
                ),
                ("& $env:ComSpec /d /c exit 7", 7, "", ""),
                ("& $env:ComSpec /d /c exit 7; 'recovered'", 0, "recovered", ""),
                (
                    "$PSModuleAutoLoadingPreference = 'None'; missing_terax_test_command; 'recovered'",
                    0,
                    "recovered",
                    "missing_terax_test_command",
                ),
                (
                    "Write-Output \"don't ‘quote’ me\"",
                    0,
                    "don't ‘quote’ me",
                    "",
                ),
                ("Write-Error 'test failure'", 1, "", "test failure"),
                ("throw 'test throw'", 1, "", "test throw"),
                ("foreach ($x in 'x') { 'hello'", 1, "", "}"),
            ] {
                let process = AgentProcess::spawn_local(
                    uuid::Uuid::new_v4().to_string(),
                    uuid::Uuid::new_v4().to_string(),
                    WorkspaceEnv::Local,
                    format!("$env:PSModulePath = \"$PSHOME\\Modules\"\n{command}"),
                    directory.path().to_string_lossy().into_owned(),
                    shell,
                    false,
                    ProcessPurpose::Shell,
                )
                .unwrap();
                process.close_stdin().await.unwrap();
                let response = process.wait_snapshot(0, Duration::from_secs(15), None, 8192);
                assert_eq!(
                    response.exit_code,
                    Some(code),
                    "{shell:?}: {command}: {}",
                    serde_json::to_string(&response).unwrap()
                );
                assert!(
                    response.stdout.contains(stdout),
                    "{shell:?}: {command}: {}",
                    response.stdout
                );
                assert!(
                    response.stderr.contains(stderr),
                    "{shell:?}: {command}: {}",
                    response.stderr
                );
                if !command.starts_with("throw ") && !command.starts_with("foreach ") {
                    assert_eq!(
                        response.cwd_after,
                        Some(crate::modules::fs::to_canon(
                            std::fs::canonicalize(directory.path()).unwrap()
                        )),
                        "{shell:?}: {command}"
                    );
                }
                if command.starts_with("[pscustomobject]") {
                    assert!(response.stdout.contains("hello"));
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn python_pipe_output_is_utf8() {
        if which::which("python").is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            WorkspaceEnv::Local,
            "python -c \"import sys; print(chr(0x4e2d)+chr(0x6587)); sys.stderr.write(chr(0x4e2d)+chr(0x6587))\"".into(),
            directory.path().to_string_lossy().into_owned(),
            ShellKind::Default,
            false,
            ProcessPurpose::Shell,
        ).unwrap();
        let response = process.wait_snapshot(0, Duration::from_secs(15), None, 8192);
        assert_eq!(response.exit_code, Some(0), "{}", response.stderr);
        assert_eq!(response.stdout.trim(), "中文");
        assert_eq!(response.stderr, "中文");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_utf8_pipes_preserve_text_cwd_and_exit_code() {
        const PIPE_EXIT_CODE: &str = "TERAX_TEST_UTF8_PIPE_EXIT_CODE";
        if let Ok(code) = std::env::var(PIPE_EXIT_CODE) {
            // 作为原生子进程，直接按 UTF-8 读取父 Shell 写入管道的字节。
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            println!("pipe:{}", line.trim_end_matches(['\r', '\n']));
            std::process::exit(code.parse().unwrap());
        }

        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("中文目录");
        std::fs::create_dir(&cwd).unwrap();
        let pipe_reader = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .replace('\'', "''");
        let test_name = concat!(
            "modules::shell::process::tests::",
            "powershell_utf8_pipes_preserve_text_cwd_and_exit_code"
        );
        let mut tested = 0;
        for identity in agent_shells(&WorkspaceEnv::Local)
            .unwrap()
            .iter()
            .filter(|entry| matches!(entry.kind, ShellKind::Pwsh | ShellKind::Powershell))
        {
            let shell = &identity.executable;
            tested += 1;
            for exit_code in [0, 7] {
                // 子进程显式按 UTF-8 接收管道，验证父 Shell 的 $OutputEncoding。
                let script = format!(
                    r#"[System.Globalization.CultureInfo]::CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN')
[Console]::WriteLine([datetime]::new(2026, 9, 8).ToString('yyyy-MM-dd dddd'))
[Console]::Error.WriteLine('中文错误')
$line = [Console]::ReadLine()
[Console]::WriteLine("stdin:$line")
$env:{PIPE_EXIT_CODE} = '{exit_code}'
$line | & '{pipe_reader}' --exact '{test_name}' --nocapture"#
                );
                let process = AgentProcess::spawn_local(
                    uuid::Uuid::new_v4().to_string(),
                    uuid::Uuid::new_v4().to_string(),
                    WorkspaceEnv::Local,
                    script,
                    cwd.to_string_lossy().into_owned(),
                    identity.kind,
                    false,
                    ProcessPurpose::Shell,
                )
                .unwrap();
                process.write("中文输入\n".into()).await.unwrap();
                process.close_stdin().await.unwrap();
                let response = process.wait_snapshot(0, Duration::from_secs(15), None, 8192);
                assert_eq!(
                    response.exit_code,
                    Some(exit_code),
                    "{shell}: {}",
                    serde_json::to_string(&response).unwrap()
                );
                for expected in ["2026-09-08 星期二", "stdin:中文输入", "pipe:中文输入"]
                {
                    assert!(
                        response.stdout.contains(expected),
                        "{shell}: {}",
                        response.stdout
                    );
                }
                assert_eq!(response.stderr.trim(), "中文错误", "{shell}");
                assert_eq!(
                    response.cwd_after,
                    Some(crate::modules::fs::to_canon(
                        std::fs::canonicalize(&cwd).unwrap()
                    )),
                    "{shell}"
                );
            }
        }
        assert!(tested > 0, "no PowerShell executable available");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires TERAX_TEST_WSL_DISTRO pointing to an installed distribution"]
    fn wsl_discovery_and_default_execution_use_the_same_snapshot() {
        let workspace = WorkspaceEnv::Wsl {
            distro: std::env::var("TERAX_TEST_WSL_DISTRO").unwrap(),
        };
        let shells = agent_shells(&workspace).unwrap();
        assert!(!shells.is_empty());
        println!("{}", serde_json::to_string(&shells).unwrap());
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            workspace.clone(),
            "printf 'shell-snapshot-ready\\n'".into(),
            "/tmp".into(),
            ShellKind::Default,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();
        let response = process.wait_snapshot(0, Duration::from_secs(15), None, 8192);
        assert_eq!(response.status, ProcessStatus::Exited);
        assert_eq!(response.exit_code, Some(0));
        assert!(response.stdout.contains("shell-snapshot-ready"));
        assert_eq!(
            serde_json::to_value(agent_shells(&workspace).unwrap()).unwrap(),
            serde_json::to_value(shells).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn wsl_command_uses_sets_id_and_a_private_pid_file() {
        let id = uuid::Uuid::new_v4().to_string();
        let (command, termination) = build_local_command(
            &id,
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
            "echo ok",
            "/work",
            &ShellIdentity {
                kind: ShellKind::Bash,
                executable: "/bin/bash".into(),
                version: None,
            },
            false,
            "marker",
            ProcessPurpose::Shell,
        )
        .unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|argument| argument == "setsid"));
        assert!(args.iter().any(|argument| argument == "--wait"));
        assert!(args.iter().any(|argument| argument.contains(&id)));
        assert_eq!(termination.unwrap().distro, "Ubuntu");
    }

    #[tokio::test]
    async fn local_process_accepts_stdin_and_reaches_terminal_state() {
        let directory = tempfile::tempdir().unwrap();
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            WorkspaceEnv::Local,
            interactive_command().into(),
            directory.path().to_string_lossy().into_owned(),
            ShellKind::Default,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();

        process.write("hello\n".into()).await.unwrap();
        let observed = process.wait_snapshot(0, Duration::from_secs(5), Some("got:hello"), 8192);
        assert_eq!(observed.wait_for_matched, Some(true));
        let response =
            process.wait_snapshot(observed.next_offset, Duration::from_secs(5), None, 8192);
        assert_eq!(response.status, ProcessStatus::Exited);
        assert!(observed.stdout.contains("got:hello"));
        assert_eq!(response.exit_code, Some(0));
        // 匹配包含指定 offset 之后仍保留的旧输出，不要求输出在等待期间产生。
        assert_eq!(
            process
                .wait_snapshot(0, Duration::ZERO, Some("got:hello"), 8192)
                .wait_for_matched,
            Some(true)
        );
        assert_eq!(
            process
                .wait_snapshot(
                    observed.next_offset,
                    Duration::ZERO,
                    Some("got:hello"),
                    8192
                )
                .wait_for_matched,
            Some(false)
        );
    }

    #[tokio::test]
    async fn closing_stdin_delivers_eof_after_written_input() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine('got:' + $line) }; [Console]::WriteLine('eof')";
        #[cfg(unix)]
        let command =
            "while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done; printf 'eof\\n'";
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

        process.write("hello\n".into()).await.unwrap();
        let observed = process.wait_snapshot(0, Duration::from_secs(5), Some("got:hello"), 8192);
        assert_eq!(observed.wait_for_matched, Some(true));
        assert_eq!(observed.status, ProcessStatus::Running);
        assert!(!observed.stdout.contains("eof"));
        // 必须继续读取到 EOF 才能退出，避免只验证固定行数读取完成。
        process.close_stdin().await.unwrap();
        let response =
            process.wait_snapshot(observed.next_offset, Duration::from_secs(5), None, 8192);
        assert_eq!(response.status, ProcessStatus::Exited);
        assert_eq!(response.exit_code, Some(0));
        assert!(response.stdout.contains("eof"));
    }

    #[tokio::test]
    async fn polling_silence_preserves_activity_time_and_hard_deadline() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "[Console]::Write('ready'); $null = [Console]::ReadLine(); [Console]::Error.Write('partial'); $null = [Console]::ReadLine()";
        #[cfg(unix)]
        let command = "printf ready; IFS= read -r line; printf partial >&2; IFS= read -r line";
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
        let ready = process.wait_snapshot(0, Duration::from_secs(5), Some("ready"), 8192);
        assert_eq!(ready.wait_for_matched, Some(true));
        assert_eq!(ready.remaining_timeout_ms, None);
        process.set_timeout(Duration::from_secs(20));
        let before = process.response(ready.next_offset, 8192);
        let last_output = process.shared.output.lock().unwrap().last_output_at();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let silent = process.response(ready.next_offset, 8192);
        assert_eq!(silent.status, ProcessStatus::Running);
        assert!(silent.output_idle_ms >= before.output_idle_ms + 20);
        assert!(silent.remaining_timeout_ms.unwrap() < before.remaining_timeout_ms.unwrap());
        assert_eq!(
            process.shared.output.lock().unwrap().last_output_at(),
            last_output
        );
        process.write("continue\n".into()).await.unwrap();
        let partial = process.wait_snapshot(
            ready.next_offset,
            Duration::from_secs(5),
            Some("partial"),
            8192,
        );
        assert_eq!(partial.wait_for_matched, Some(true));
        assert!(partial.stderr.contains("partial"));
        assert!(process.shared.output.lock().unwrap().last_output_at() > last_output);
        assert!(partial.remaining_timeout_ms.unwrap() <= silent.remaining_timeout_ms.unwrap());
        process
            .terminate_as(ProcessStatus::Terminated)
            .await
            .unwrap();
        assert_eq!(process.response(0, 8192).remaining_timeout_ms, Some(0));
    }

    #[tokio::test]
    async fn local_termination_locks_terminated_state() {
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

        process
            .terminate_as(ProcessStatus::Terminated)
            .await
            .unwrap();
        assert_eq!(process.response(0, 8192).status, ProcessStatus::Terminated);
    }

    #[tokio::test]
    async fn normal_exit_cannot_publish_completion_during_termination() {
        let directory = tempfile::tempdir().unwrap();
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            WorkspaceEnv::Local,
            interactive_command().into(),
            directory.path().to_string_lossy().into_owned(),
            ShellKind::Default,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();
        // 模拟终止正在等待原生清理；命令先行退出不能抢占取消的终态。
        let guard = process.termination_lock.lock().await;
        process.write("finish\n".into()).await.unwrap();
        let child = match &process.control {
            ProcessControl::Local(control) => control.child.clone(),
            #[cfg(feature = "workspace-runtime")]
            ProcessControl::Remote(_) => unreachable!(),
        };
        tokio::task::spawn_blocking(move || child.wait())
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(process.response(0, 8192).status, ProcessStatus::Running);
        process.shared.finish(ProcessStatus::Terminated, None);
        drop(guard);
        assert_eq!(process.response(0, 8192).status, ProcessStatus::Terminated);
    }

    #[tokio::test]
    async fn terminal_elapsed_time_stops_advancing() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "Write-Output done";
        #[cfg(unix)]
        let command = "printf 'done\\n'";
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

        let first = process.wait_snapshot(0, Duration::from_secs(5), None, 8192);
        assert_eq!(first.status, ProcessStatus::Exited);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            process.response(first.next_offset, 8192).elapsed_ms,
            first.elapsed_ms
        );
    }

    #[tokio::test]
    async fn local_termination_kills_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("descendant-survived.txt");
        #[cfg(windows)]
        let (command, shell) = (
            format!(
                "start \"\" /B cmd /C \"ping -n 4 127.0.0.1 ^> nul ^& echo survived ^> {}\" & ping -n 30 127.0.0.1 > nul",
                marker.display()
            ),
            ShellKind::Cmd,
        );
        #[cfg(unix)]
        let (command, shell) = (
            format!(
                "(sleep 2; touch -- {}) & sleep 30",
                crate::modules::shell::quote::shell_quote(&marker.to_string_lossy())
            ),
            ShellKind::Sh,
        );
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            WorkspaceEnv::Local,
            command,
            directory.path().to_string_lossy().into_owned(),
            shell,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();

        tokio::time::sleep(Duration::from_millis(200)).await;
        process
            .terminate_as(ProcessStatus::Terminated)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(
            !marker.exists(),
            "descendant survived Agent process termination"
        );
    }

    #[tokio::test]
    async fn external_agent_root_exit_reaps_descendants() {
        #[cfg(windows)]
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        #[cfg(windows)]
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        #[cfg(windows)]
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let marker = directory.path().join("normal-exit-descendant.txt");
        #[cfg(windows)]
        let (command, shell) = (
            r#"$info = [System.Diagnostics.ProcessStartInfo]::new("$env:SystemRoot\System32\ping.exe", '-n 60 127.0.0.1')
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = [System.Diagnostics.Process]::Start($info)
[Console]::WriteLine($child.Id)
[Console]::WriteLine('descendant-ready')
$null = [Console]::ReadLine()
exit 0"#
                .to_string(),
            ShellKind::Powershell,
        );
        #[cfg(unix)]
        let (command, shell) = (
            format!(
                "(sleep 2; touch -- {}) & exit 0",
                crate::modules::shell::quote::shell_quote(&marker.to_string_lossy())
            ),
            ShellKind::Sh,
        );
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            WorkspaceEnv::Local,
            command,
            directory.path().to_string_lossy().into_owned(),
            shell,
            false,
            ProcessPurpose::ExternalAgent,
        )
        .unwrap();

        #[cfg(windows)]
        let descendant = {
            // 先持有仍在运行的子进程句柄，再让根 Shell 退出。
            let ready =
                process.wait_snapshot(0, Duration::from_secs(15), Some("descendant-ready"), 8192);
            assert_eq!(
                ready.wait_for_matched,
                Some(true),
                "{}",
                serde_json::to_string(&ready).unwrap()
            );
            let pid = ready.stdout.lines().next().unwrap().parse().unwrap();
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
            let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
                WAIT_TIMEOUT
            );
            process.close_stdin().await.unwrap();
            handle
        };

        let response = process.wait_snapshot(0, Duration::from_secs(15), None, 8192);
        assert_eq!(
            (response.status, response.exit_code),
            (ProcessStatus::Exited, Some(0)),
            "{}",
            serde_json::to_string(&response).unwrap()
        );
        #[cfg(windows)]
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 4000) },
            WAIT_OBJECT_0,
            "descendant survived after the root shell exited"
        );
        #[cfg(unix)]
        {
            tokio::time::sleep(Duration::from_secs(4)).await;
            assert!(
                !marker.exists(),
                "descendant survived after the root shell exited"
            );
        }
    }

    fn posix_test_workspace(directory: &std::path::Path) -> (WorkspaceEnv, String) {
        #[cfg(windows)]
        {
            let distro = std::env::var("TERAX_TEST_WSL_DISTRO").unwrap();
            let output = Command::new("wsl.exe")
                .args(["-d", &distro, "--exec", "wslpath", "-u"])
                .arg(directory)
                .output()
                .unwrap();
            assert!(output.status.success());
            (
                WorkspaceEnv::Wsl { distro },
                String::from_utf8(output.stdout).unwrap().trim().into(),
            )
        }
        #[cfg(unix)]
        {
            (
                WorkspaceEnv::Local,
                directory.to_string_lossy().into_owned(),
            )
        }
    }

    #[test]
    #[cfg_attr(windows, ignore = "requires TERAX_TEST_WSL_DISTRO")]
    fn posix_nohup_survives_launcher_exit_and_drop() {
        let directory = tempfile::tempdir().unwrap();
        let (workspace, cwd) = posix_test_workspace(directory.path());
        let process = AgentProcess::spawn_local(
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            workspace,
            "nohup sh -c 'touch ready; i=0; while [ ! -e release ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done; [ ! -e release ] || echo survived > survived' </dev/null >service.log 2>&1 &".into(),
            cwd,
            ShellKind::Sh,
            false,
            ProcessPurpose::Shell,
        )
        .unwrap();
        let response = process.wait_snapshot(0, Duration::from_secs(10), None, 8192);
        assert_eq!(
            response.status,
            ProcessStatus::Exited,
            "{}",
            response.stderr
        );
        assert_eq!(response.exit_code, Some(0));
        assert!(
            !process.holds_resources(),
            "launcher retained cleanup ownership"
        );
        drop(process);
        std::fs::write(directory.path().join("release"), "continue").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !directory.path().join("survived").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(directory.path().join("survived").exists());
    }

    #[tokio::test]
    #[cfg_attr(windows, ignore = "requires TERAX_TEST_WSL_DISTRO")]
    async fn posix_cancel_still_terminates_nohup_children_of_active_launcher() {
        // 既覆盖启动 Shell 仍在等待，也覆盖 Shell 已退出但后代仍持有输出管道的情况。
        for tail in ["</dev/null >service.log 2>&1 & wait", "</dev/null &"] {
            let directory = tempfile::tempdir().unwrap();
            let (workspace, cwd) = posix_test_workspace(directory.path());
            let process = AgentProcess::spawn_local(
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
                workspace,
                format!("nohup sh -c 'touch ready; i=0; while [ ! -e release ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done; [ ! -e release ] || echo survived > survived' {tail}"),
                cwd,
                ShellKind::Sh,
                false,
                ProcessPurpose::Shell,
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !directory.path().join("ready").exists() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(directory.path().join("ready").exists());
            assert!(process.is_running());
            let stopped = process.terminate_as(ProcessStatus::Terminated).await;
            std::fs::write(directory.path().join("release"), "continue").unwrap();
            stopped.unwrap();
            // wait 线程可能刚接手最终输出收尾，等它释放清理锁再检查资源归属。
            let deadline = Instant::now() + Duration::from_secs(5);
            while process.holds_resources() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!process.holds_resources());
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(!directory.path().join("survived").exists());
        }
    }

    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    #[cfg_attr(windows, ignore = "requires TERAX_TEST_WSL_DISTRO")]
    fn remote_wrapper_releases_normal_launch_but_cleans_interrupted_launch() {
        let directory = tempfile::Builder::new()
            .prefix("terax ' service ")
            .tempdir()
            .unwrap();
        let (workspace, cwd) = posix_test_workspace(directory.path());
        let execute = |script: &str| {
            #[cfg(windows)]
            let mut command = {
                let WorkspaceEnv::Wsl { distro } = &workspace else {
                    unreachable!()
                };
                let mut command = Command::new("wsl.exe");
                command.args(["-d", distro, "--exec", "/bin/sh"]);
                command
            };
            #[cfg(unix)]
            let mut command = {
                let _ = &workspace;
                Command::new("/bin/sh")
            };
            command.args(["-c", script]);
            command
        };
        for (interrupted, release_exited) in [(false, true), (false, false), (true, false)] {
            let suffix = if interrupted {
                "cancel"
            } else if release_exited {
                "normal"
            } else {
                "unconfirmed"
            };
            let pid_file = format!("/tmp/terax-agent-test-{}.pid", uuid::Uuid::new_v4());
            let payload = format!(
                "nohup sh -c 'touch ready-{suffix}; i=0; while [ ! -e release-{suffix} ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done; [ ! -e release-{suffix} ] || echo survived > survived-{suffix}' </dev/null >service-{suffix}.log 2>&1 & {}",
                if interrupted { "wait" } else { "" },
            );
            let script = build_remote_command(
                &payload,
                &cwd,
                &ShellIdentity {
                    kind: ShellKind::Bash,
                    executable: "/bin/bash".into(),
                    version: None,
                },
                false,
                "marker",
                &pid_file,
                ProcessPurpose::Shell,
            )
            .unwrap();
            let mut launcher = execute(&script)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !directory.path().join(format!("ready-{suffix}")).exists()
                && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(directory.path().join(format!("ready-{suffix}")).exists());
            if !interrupted {
                assert!(launcher.wait().unwrap().success());
            }
            let cleanup = execute(&posix_group_kill_command(&pid_file, release_exited))
                .output()
                .unwrap();
            std::fs::write(
                directory.path().join(format!("release-{suffix}")),
                "continue",
            )
            .unwrap();
            assert!(
                cleanup.status.success(),
                "{}",
                String::from_utf8_lossy(&cleanup.stderr)
            );
            assert_eq!(launcher.wait().unwrap().success(), !interrupted);
            if !release_exited {
                thread::sleep(Duration::from_millis(500));
                assert!(!directory.path().join(format!("survived-{suffix}")).exists());
            } else {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !directory.path().join(format!("survived-{suffix}")).exists()
                    && Instant::now() < deadline
                {
                    thread::sleep(Duration::from_millis(20));
                }
                assert!(directory.path().join(format!("survived-{suffix}")).exists());
            }
        }
    }
}
