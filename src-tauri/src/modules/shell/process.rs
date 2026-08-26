//! AI Agent 统一进程实例及 Local、WSL、SSH 执行后端。
//!
//! 每个命令都进入同一个有界生命周期模型。Local 与 WSL 使用受管子进程，SSH
//! 使用长生命周期 exec channel；三者共享 stdin、输出 offset、超时和终止语义。

use std::io::{Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use russh::{ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use shared_child::SharedChild;
use tokio::sync::{mpsc, oneshot};

use super::output::{OutputLog, OutputSlice, OutputStream};
use crate::modules::remote;
use crate::modules::workspace::WorkspaceEnv;

#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(1);
const INTERNAL_READ_LIMIT: usize = 4 * 1024 * 1024;
const FINISHED_OUTPUT_CAPACITY: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    Default,
    Bash,
    Sh,
    Zsh,
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

struct WslTermination {
    distro: String,
    pid_file: String,
}

enum RemoteAction {
    Write(Vec<u8>, oneshot::Sender<Result<(), String>>),
    Eof(oneshot::Sender<Result<(), String>>),
    Terminate(ProcessStatus, oneshot::Sender<Result<(), String>>),
}

struct RemoteControl {
    tx: mpsc::Sender<RemoteAction>,
}

enum ProcessControl {
    Local(Arc<LocalControl>),
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
    started: Instant,
    last_access: Mutex<Instant>,
    last_read_offset: AtomicU64,
    marker: String,
    cwd_after: Mutex<Option<String>>,
    shared: Arc<ProcessShared>,
    control: ProcessControl,
}

#[derive(Serialize)]
pub struct ProcessResponse {
    pub process_id: String,
    pub status: ProcessStatus,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
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
    pub process_id: String,
    pub command: String,
    pub cwd: String,
    pub shell: ShellKind,
    pub workspace: &'static str,
    pub status: ProcessStatus,
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
    pub idle_ms: u64,
    pub exit_code: Option<i32>,
    pub unread_output: bool,
}

impl AgentProcess {
    /// 启动 Local 或 WSL Agent 进程，并立即登记输出与终态监听。
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_local(
        id: String,
        owner_session_id: String,
        workspace: WorkspaceEnv,
        command: String,
        cwd: String,
        shell: ShellKind,
        login: bool,
    ) -> Result<Arc<Self>, String> {
        let marker = format!("__TERAX_AGENT_CWD_{id}__");
        let (mut native, wsl_termination) =
            build_local_command(&id, &workspace, &command, &cwd, shell, login, &marker)?;
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
            started: Instant::now(),
            last_access: Mutex::new(Instant::now()),
            last_read_offset: AtomicU64::new(0),
            marker,
            cwd_after: Mutex::new(None),
            shared: shared.clone(),
            control: ProcessControl::Local(control.clone()),
        });

        let stdout_reader = spawn_reader(stdout, OutputStream::Stdout, shared.clone());
        let stderr_reader = spawn_reader(stderr, OutputStream::Stderr, shared);
        let waiter = Arc::downgrade(&process);
        let waited_child = child;
        let waited_control = control;
        thread::spawn(move || {
            let code = waited_child.wait().ok().and_then(|status| status.code());
            stop_descendants_after_exit(&waited_control);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            if let Some(waiter) = waiter.upgrade() {
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
    pub async fn spawn_remote(
        id: String,
        owner_session_id: String,
        workspace_env: WorkspaceEnv,
        command: String,
        cwd: String,
        shell: ShellKind,
        login: bool,
    ) -> Result<Arc<Self>, String> {
        let WorkspaceEnv::Ssh { profile_id } = &workspace_env else {
            return Err("remote process requires an SSH workspace".into());
        };
        let manager = remote::manager::global_manager()?;
        let workspace = manager.workspace(profile_id).await?;
        let workspace_root = normalize_remote_root(&workspace.home().await)?;
        if !remote_path_within(&cwd, &workspace_root) {
            return Err("Agent process cwd is outside the SSH Workspace root".into());
        }
        let marker = format!("__TERAX_AGENT_CWD_{id}__");
        let pid_file = format!("/tmp/terax-agent-{id}.pid");
        let remote_command = build_remote_command(
            &command,
            &cwd,
            &workspace_root,
            shell,
            login,
            &marker,
            &pid_file,
        )?;
        let channel = workspace.open_exec_channel().await?;
        channel
            .exec(true, remote_command.into_bytes())
            .await
            .map_err(|error| format!("start remote Agent process: {error}"))?;
        let (mut read, write) = channel.split();
        let (tx, mut rx) = mpsc::channel(16);
        let shared = Arc::new(ProcessShared::new());
        let process = Arc::new(Self {
            id,
            owner_session_id,
            workspace: workspace_env,
            command,
            cwd,
            shell,
            started_at_ms: now_ms(),
            started: Instant::now(),
            last_access: Mutex::new(Instant::now()),
            last_read_offset: AtomicU64::new(0),
            marker,
            cwd_after: Mutex::new(None),
            shared: shared.clone(),
            control: ProcessControl::Remote(RemoteControl { tx }),
        });

        let worker = Arc::downgrade(&process);
        tauri::async_runtime::spawn(async move {
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
                            let kill = remote_group_kill(&workspace, &pid_file).await;
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
            let _ = remote_group_kill(&workspace, &pid_file).await;
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
                let mut stdin = control.stdin.lock().unwrap();
                let stdin = stdin
                    .as_mut()
                    .ok_or_else(|| "Agent process stdin is closed".to_string())?;
                stdin
                    .write_all(input.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|error| format!("write Agent process stdin: {error}"))
            }
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
        if !self.shared.is_running() {
            return Ok(());
        }
        match &self.control {
            ProcessControl::Local(control) => {
                // 先锁定调用方终态，避免 Job Object 关闭后 wait 线程抢先写成 Exited。
                self.shared.finish(status, None);
                let control = control.clone();
                tauri::async_runtime::spawn_blocking(move || terminate_local(&control))
                    .await
                    .map_err(|error| error.to_string())?;
                self.capture_cwd();
                self.shared.compact_output();
                Ok(())
            }
            ProcessControl::Remote(control) => {
                let (reply, result) = oneshot::channel();
                control
                    .tx
                    .send(RemoteAction::Terminate(status, reply))
                    .await
                    .map_err(|_| "remote Agent process is unavailable".to_string())?;
                result
                    .await
                    .map_err(|_| "remote Agent process stopped before termination".to_string())?
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

    pub fn response(&self, since: u64, max_bytes: usize) -> ProcessResponse {
        self.touch();
        let output = self.shared.output.lock().unwrap().read(since, max_bytes);
        self.response_from(output)
    }

    pub fn info(&self) -> ProcessInfo {
        let state = self.shared.state.lock().unwrap();
        let last_access = *self.last_access.lock().unwrap();
        ProcessInfo {
            process_id: self.id.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            shell: self.shell,
            workspace: workspace_name(&self.workspace),
            status: state.status,
            started_at_ms: self.started_at_ms,
            elapsed_ms: elapsed_ms(self.started, state.finished_at),
            idle_ms: last_access.elapsed().as_millis() as u64,
            exit_code: state.exit_code,
            unread_output: self.shared.output.lock().unwrap().next_offset()
                > self.last_read_offset.load(Ordering::Acquire),
        }
    }

    pub fn is_running(&self) -> bool {
        self.shared.is_running()
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

fn terminate_local(control: &LocalControl) {
    control.stdin.lock().unwrap().take();
    if control.child.try_wait().ok().flatten().is_some() {
        return;
    }
    if let Some(wsl) = &control.wsl_termination {
        terminate_wsl_group(wsl);
    }
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
    if control.child.try_wait().ok().flatten().is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(control.child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = control.child.kill();
    }
}

fn stop_local_now(control: &LocalControl) {
    control.stdin.lock().unwrap().take();
    if let Some(wsl) = &control.wsl_termination {
        let distro = wsl.distro.clone();
        let pid_file = wsl.pid_file.clone();
        thread::spawn(move || terminate_wsl_group(&WslTermination { distro, pid_file }));
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

fn stop_descendants_after_exit(control: &LocalControl) {
    control.stdin.lock().unwrap().take();
    if let Some(wsl) = &control.wsl_termination {
        terminate_wsl_group(wsl);
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(control.child.id() as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        control.job.lock().unwrap().take();
    }
}

fn terminate_wsl_group(termination: &WslTermination) {
    let command = posix_group_kill_command(&termination.pid_file);
    let mut process = Command::new("wsl.exe");
    process
        .args([
            "-d",
            &termination.distro,
            "--exec",
            "/bin/sh",
            "-c",
            &command,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::modules::proc::hide_console(&mut process);
    let _ = process.status();
}

async fn remote_group_kill(
    workspace: &Arc<remote::session::RemoteWorkspace>,
    pid_file: &str,
) -> Result<(), String> {
    let output = workspace
        .exec(
            &posix_group_kill_command(pid_file),
            None,
            Duration::from_secs(5),
        )
        .await?;
    if output.exit_code == Some(0) {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn posix_group_kill_command(pid_file: &str) -> String {
    let file = remote::session::shell_quote(pid_file);
    format!(
        "i=0; while [ ! -s {file} ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done; if read -r pid < {file} && kill -TERM -- -\"$pid\" 2>/dev/null; then sleep 1; kill -KILL -- -\"$pid\" 2>/dev/null || true; fi; rm -f -- {file}"
    )
}

fn build_local_command(
    id: &str,
    workspace: &WorkspaceEnv,
    command: &str,
    cwd: &str,
    shell: ShellKind,
    login: bool,
    marker: &str,
) -> Result<(Command, Option<WslTermination>), String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        crate::modules::workspace::validate_wsl_distro_name(distro)?;
        let shell_program = posix_shell(shell)?;
        let payload = posix_payload(command, marker);
        let pid_file = format!("/tmp/terax-agent-{id}.pid");
        let wrapper = posix_group_wrapper(&payload, &pid_file, shell_program, login);
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
        let shell_program = posix_shell(shell)?;
        let mut native = Command::new(shell_program);
        if login {
            if !matches!(shell, ShellKind::Default | ShellKind::Bash | ShellKind::Zsh) {
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
        let selected = match shell {
            ShellKind::Default | ShellKind::Powershell => ShellKind::Powershell,
            ShellKind::Cmd => ShellKind::Cmd,
            _ => return Err("selected shell is not supported by a Windows Local workspace".into()),
        };
        let mut native = match selected {
            ShellKind::Cmd => {
                let mut command_line =
                    Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
                command_line.args(["/D", "/V:ON", "/C"]);
                command_line.arg(format!(
                    "{command}\r\n\r\nset \"__terax_rc=!ERRORLEVEL!\"\r\necho {marker}%CD%\r\nexit /b !__terax_rc!"
                ));
                command_line
            }
            _ => {
                let program = which::which("pwsh")
                    .or_else(|_| which::which("powershell"))
                    .unwrap_or_else(|_| "powershell.exe".into());
                let mut command_line = Command::new(program);
                command_line.args(["-NoLogo", "-NoProfile", "-Command"]);
                command_line.arg(format!(
                    "{command}\n\n$__terax_rc = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\nWrite-Output \"{marker}$($PWD.Path)\"\nexit $__terax_rc"
                ));
                command_line
            }
        };
        native.current_dir(cwd);
        Ok((native, None))
    }
}

fn build_remote_command(
    command: &str,
    cwd: &str,
    workspace_root: &str,
    shell: ShellKind,
    login: bool,
    marker: &str,
    pid_file: &str,
) -> Result<String, String> {
    let shell_program = posix_shell(shell)?;
    let payload = posix_payload(command, marker);
    let command = format!(
        "cd -- {} && __terax_cwd=$(pwd -P) && __terax_root={} && {{ [ \"$__terax_root\" = / ] || case \"$__terax_cwd/\" in \"$__terax_root/\"*) ;; *) exit 73 ;; esac; }} && {payload}",
        remote::session::shell_quote(cwd),
        remote::session::shell_quote(workspace_root),
    );
    let wrapper = posix_group_wrapper(&command, pid_file, shell_program, login);
    let trap = format!(
        "if read -r pid < {}; then kill -TERM -- -\"$pid\" 2>/dev/null || true; fi",
        remote::session::shell_quote(pid_file)
    );
    Ok(format!(
        "command -v setsid >/dev/null 2>&1 || exit 72; trap {} TERM INT HUP; setsid --wait /bin/sh -c {}; rc=$?; trap - TERM INT HUP; exit $rc",
        remote::session::shell_quote(&trap),
        remote::session::shell_quote(&wrapper),
    ))
}

fn remote_path_within(path: &str, root: &str) -> bool {
    root == "/"
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn normalize_remote_root(root: &str) -> Result<String, String> {
    let root = if root == "/" {
        root.to_string()
    } else {
        root.trim_end_matches('/').to_string()
    };
    remote::session::validate_remote_path(&root)?;
    if !root.starts_with('/') {
        return Err("SSH Workspace root must be absolute".into());
    }
    Ok(root)
}

fn posix_group_wrapper(payload: &str, pid_file: &str, shell: &str, login: bool) -> String {
    let login_flag = if login { " -l" } else { "" };
    let pid_file = remote::session::shell_quote(pid_file);
    format!(
        "printf '%s\\n' \"$$\" > {pid_file}; trap 'trap - TERM INT HUP; kill -TERM -- -$$ 2>/dev/null || true' TERM INT HUP; {shell}{login_flag} -c {}; exit $?",
        remote::session::shell_quote(payload)
    )
}

fn posix_payload(command: &str, marker: &str) -> String {
    format!(
        "{command}\n\n__terax_rc=$?\nprintf '\\n%s%s\\n' '{}' \"$(pwd)\"\nexit $__terax_rc",
        marker
    )
}

fn posix_shell(shell: ShellKind) -> Result<&'static str, String> {
    match shell {
        ShellKind::Default | ShellKind::Bash => Ok("/bin/bash"),
        ShellKind::Sh => Ok("/bin/sh"),
        ShellKind::Zsh => Ok("/bin/zsh"),
        ShellKind::Powershell | ShellKind::Cmd => {
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
            "/srv",
            ShellKind::Bash,
            false,
            "marker",
            "/tmp/pid",
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
            "/",
            ShellKind::Powershell,
            false,
            "marker",
            "/tmp/pid",
        );
        assert!(result.is_err());
    }

    #[test]
    fn remote_workspace_boundary_requires_a_path_segment() {
        assert!(remote_path_within("/srv/project", "/srv/project"));
        assert!(remote_path_within("/srv/project/src", "/srv/project"));
        assert!(!remote_path_within("/srv/project-copy", "/srv/project"));
        assert!(remote_path_within("/anywhere", "/"));
        assert_eq!(
            normalize_remote_root("/srv/project/").unwrap(),
            "/srv/project"
        );
        assert!(normalize_remote_root("").is_err());
        assert!(normalize_remote_root("relative").is_err());
    }

    #[test]
    fn posix_default_shell_is_bash() {
        assert_eq!(posix_shell(ShellKind::Default).unwrap(), "/bin/bash");
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
    fn wsl_command_uses_sets_id_and_a_private_pid_file() {
        let id = uuid::Uuid::new_v4().to_string();
        let (command, termination) = build_local_command(
            &id,
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
            "echo ok",
            "/work",
            ShellKind::Bash,
            false,
            "marker",
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
        )
        .unwrap();

        process
            .terminate_as(ProcessStatus::Terminated)
            .await
            .unwrap();
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
                remote::session::shell_quote(&marker.to_string_lossy())
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
    async fn normal_root_exit_also_reaps_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("normal-exit-descendant.txt");
        #[cfg(windows)]
        let (command, shell) = {
            let script = directory.path().join("descendant.cmd");
            std::fs::write(
                &script,
                format!(
                    "@ping -n 4 127.0.0.1 > nul\r\n@echo survived > \"{}\"\r\n",
                    marker.display()
                ),
            )
            .unwrap();
            (
                format!(
                    "Start-Process -FilePath $env:COMSPEC -ArgumentList '/D','/C','\"{}\"' -WindowStyle Hidden; exit 0",
                    script.display()
                ),
                ShellKind::Powershell,
            )
        };
        #[cfg(unix)]
        let (command, shell) = (
            format!(
                "(sleep 2; touch -- {}) & exit 0",
                remote::session::shell_quote(&marker.to_string_lossy())
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
        )
        .unwrap();

        let response = process.wait_snapshot(0, Duration::from_secs(5), None, 8192);
        assert_eq!(response.status, ProcessStatus::Exited);
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(
            !marker.exists(),
            "descendant survived after the root shell exited"
        );
    }
}
