//! Git 进程启动、输出收集和超时管理，统一覆盖本地、WSL 与 SSH。
//! 索引写操作仅在明确的锁占用错误上退避重试，不移除其他进程的锁。

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use terax_core::modules::proc::cancellation::{ProcessCancellation, PROCESS_READY};
use terax_core::modules::proc::group;

use shared_child::SharedChild;

use terax_core::events::OutputSink;

use crate::errors::{GitError, Result};
use crate::types::{
    GitOutput, GitProgress, TextSource, DEFAULT_TIMEOUT_SECS, MAX_FILE_BYTES, MAX_OUTPUT_BYTES,
    MAX_TIMEOUT_SECS, MIN_GIT_VERSION,
};
#[cfg(windows)]
use terax_core::modules::workspace::validate_wsl_distro_name;
use terax_core::modules::workspace::WorkspaceEnv;

#[derive(Clone)]
enum Availability {
    Ok,
    NotInstalled,
    TooOld(String),
}

const AVAILABILITY_TTL: Duration = Duration::from_secs(60);

struct AvailabilityCache {
    value: Availability,
    checked_at: Instant,
}

static GIT_AVAILABILITY: OnceLock<Mutex<HashMap<String, AvailabilityCache>>> = OnceLock::new();

fn availability_cell() -> &'static Mutex<HashMap<String, AvailabilityCache>> {
    GIT_AVAILABILITY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_expired_availability_entries(cache: &mut HashMap<String, AvailabilityCache>) {
    cache.retain(|_, entry| entry.checked_at.elapsed() < AVAILABILITY_TTL);
}

fn workspace_cache_key(workspace: &WorkspaceEnv) -> String {
    match workspace {
        WorkspaceEnv::Local => "local".into(),
        WorkspaceEnv::Wsl { distro } => format!("wsl:{distro}"),
        WorkspaceEnv::Ssh { profile_id } => format!("ssh:{profile_id}"),
    }
}

pub fn ensure_git_available(workspace: &WorkspaceEnv) -> Result<()> {
    let cache_key = workspace_cache_key(workspace);
    let cached = {
        let mut guard = availability_cell()
            .lock()
            .expect("git availability poisoned");
        prune_expired_availability_entries(&mut guard);
        guard
            .get(&cache_key)
            .filter(|entry| entry.checked_at.elapsed() < AVAILABILITY_TTL)
            .map(|entry| entry.value.clone())
    };
    let value = match cached {
        Some(v) => v,
        None => {
            let fresh = check_git_availability(workspace);
            let mut guard = availability_cell()
                .lock()
                .expect("git availability poisoned");
            prune_expired_availability_entries(&mut guard);
            guard.insert(
                cache_key,
                AvailabilityCache {
                    value: fresh.clone(),
                    checked_at: Instant::now(),
                },
            );
            fresh
        }
    };
    match value {
        Availability::Ok => Ok(()),
        Availability::NotInstalled => Err(GitError::NotInstalled),
        Availability::TooOld(v) => Err(GitError::TooOld {
            found: v,
            required: MIN_GIT_VERSION,
        }),
    }
}

fn check_git_availability(workspace: &WorkspaceEnv) -> Availability {
    let output = match run_git_uncached(workspace, None, ["--version"], Duration::from_secs(10)) {
        Ok(o) => o,
        Err(_) => return Availability::NotInstalled,
    };
    if output.timed_out || output.exit_code != Some(0) {
        return Availability::NotInstalled;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_git_version(stdout.trim()).unwrap_or_else(|| "unknown".into());
    if !version_meets_minimum(&version, MIN_GIT_VERSION) {
        return Availability::TooOld(version);
    }
    Availability::Ok
}

fn parse_git_version(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|tok| tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.split('.').take(3).collect::<Vec<_>>().join("."))
}

fn version_meets_minimum(found: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let f = parse(found);
    let r = parse(required);
    for (i, &b) in r.iter().enumerate() {
        let a = f.get(i).copied().unwrap_or(0);
        if a > b {
            return true;
        }
        if a < b {
            return false;
        }
    }
    true
}

pub fn git_show_text(workspace: &WorkspaceEnv, repo_root: &str, spec: &str) -> Result<TextSource> {
    let output = run_git(
        workspace,
        Some(repo_root),
        [
            OsStr::new("show"),
            OsStr::new("--no-textconv"),
            OsStr::new(spec),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git show"));
    }
    if output.exit_code != Some(0) {
        return Ok(TextSource::Missing);
    }
    Ok(decode_text(output.stdout))
}

pub fn git_stdout_line_opt<I, S>(
    workspace: &WorkspaceEnv,
    cwd: &str,
    args: I,
) -> Result<Option<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git(workspace, Some(cwd), args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git command"));
    }
    if output.exit_code != Some(0) {
        return Ok(None);
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        Ok(None)
    } else {
        Ok(Some(line.to_string()))
    }
}

/// Run git, returning multiple stdout lines (UTF-8). Empty trailing lines stripped.
pub fn git_stdout_lines<I, S>(workspace: &WorkspaceEnv, cwd: &str, args: I) -> Result<Vec<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git(workspace, Some(cwd), args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git command"));
    }
    if output.exit_code != Some(0) {
        return Ok(Vec::new());
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    Ok(stdout
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect())
}

pub fn read_text_file(path: &Path) -> Result<TextSource> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TextSource::Missing),
        Err(e) => return Err(GitError::Io(e)),
    };
    if meta.file_type().is_symlink() {
        return Err(GitError::SymlinkRejected(path.to_path_buf()));
    }
    if !meta.is_file() {
        return Ok(TextSource::Missing);
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Err(GitError::FileTooLarge {
            path: path.to_path_buf(),
            size,
            max: MAX_FILE_BYTES,
        });
    }
    let bytes = std::fs::read(path)?;
    Ok(decode_text(bytes))
}

pub fn run_git<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_uncached(
        workspace,
        cwd,
        args,
        Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS)),
    )
}

/// 仅供暂存、取消暂存和恢复等索引操作使用；重试当前命令，不重放已完成批次。
/// 锁等待与各次进程执行共享原有超时预算，其他错误直接返回。
pub(super) fn run_git_index_mutation<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let timeout = Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
    let started = Instant::now();
    let mut remaining = timeout;
    let mut attempt = 0;
    loop {
        let output = run_git_uncached(workspace, cwd, &args, remaining)?;
        if !index_is_locked(&output) || attempt >= 10 {
            return Ok(output);
        }
        attempt += 1;
        let delay = Duration::from_millis(attempt * attempt * 50);
        if timeout.saturating_sub(started.elapsed()) <= delay {
            return Ok(output);
        }
        thread::sleep(delay);
        remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Ok(output);
        }
    }
}

fn index_is_locked(output: &GitOutput) -> bool {
    if output.timed_out || output.exit_code == Some(0) {
        return false;
    }
    String::from_utf8_lossy(&output.stderr).lines().any(|line| {
        line.strip_prefix("fatal: Unable to create '")
            .and_then(|path| path.strip_suffix("': File exists."))
            .is_some_and(|path| path.rsplit(['/', '\\']).next() == Some("index.lock"))
    })
}

fn run_git_uncached<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    dur: Duration,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    if let WorkspaceEnv::Ssh { profile_id } = workspace {
        let mut command = String::from(
            "env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= GIT_OPTIONAL_LOCKS=0 GCM_INTERACTIVE=Never LC_ALL=C git",
        );
        for arg in &args {
            let arg = arg
                .to_str()
                .ok_or_else(|| GitError::command("git command", "non-UTF-8 argument"))?;
            command.push(' ');
            command.push_str(&terax_core::modules::remote::session::shell_quote(arg));
        }
        let output =
            terax_core::modules::remote::manager::exec_blocking(profile_id, &command, cwd, dur)
                .map_err(GitError::Spawn)?;
        return Ok(GitOutput {
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code: output.exit_code,
            timed_out: output.timed_out,
            truncated: output.truncated,
        });
    }
    let mut cmd = build_git_command(workspace, cwd, &args)?;
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_PROVIDER", "")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    terax_core::modules::proc::hide_console(&mut cmd);

    run_child(cmd, dur, MAX_OUTPUT_BYTES, None)
}

/// 联网操作由 Git 退出或显式取消结束，不使用总执行时长限制。
pub(super) fn run_git_network(
    workspace: &WorkspaceEnv,
    path: &str,
    args: &[&str],
    control: &Arc<ProcessCancellation>,
    progress: Option<OutputSink<Option<GitProgress>>>,
) -> Result<GitOutput> {
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let mut cmd = build_git_command(workspace, Some(path), &args)?;
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_PROVIDER", "")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    terax_core::modules::proc::hide_console(&mut cmd);
    run_child_inner(
        cmd,
        None,
        MAX_OUTPUT_BYTES,
        None,
        Some(control),
        None,
        progress,
    )
}

/// WSL 每个固定批次只启动一次入口，批次内各 Git 命令沿用 SSH 的字节协议。
#[cfg(windows)]
pub(super) fn execute_wsl_batch(
    distro: &str,
    path: &str,
    kind: terax_core::modules::remote::git_service::GitBatchKind,
    control: Option<&Arc<ProcessCancellation>>,
) -> Result<Vec<terax_core::modules::remote::git_service::GitBatchOutput>> {
    use terax_core::modules::remote::git_service;
    validate_wsl_distro_name(distro).map_err(GitError::Spawn)?;
    let timeout = kind.timeout_secs().map(Duration::from_secs);
    let script = git_service::batch_script(path, kind).map_err(GitError::Spawn)?;
    let mut cmd = Command::new("wsl.exe");
    // 脚本包含未跟踪文件路径，不能放进有长度上限的 Windows 命令行。
    let pid_file = format!("/tmp/terax-git-{}.pid", uuid::Uuid::new_v4());
    if control.is_some() {
        cmd.args([
            "-d",
            distro,
            "--exec",
            "/bin/sh",
            "-c",
            &git_service::network_command(&pid_file),
        ]);
    } else {
        cmd.args(["-d", distro, "--exec", "sh", "-s"]);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    terax_core::modules::proc::hide_console(&mut cmd);
    let wsl = control.map(|_| (distro.to_owned(), pid_file.clone()));
    let output = run_child_inner(
        cmd,
        timeout,
        8 * 1024 * 1024,
        Some(script.into_bytes()),
        control,
        wsl,
        None,
    )?;
    ensure_success(&output, "WSL Git batch failed")?;
    if output.truncated {
        return Err(GitError::command("WSL Git batch", "output truncated"));
    }
    git_service::parse_batch(&output.stdout).map_err(GitError::Spawn)
}

pub(super) fn run_child(
    cmd: Command,
    dur: Duration,
    max_output: usize,
    input: Option<Vec<u8>>,
) -> Result<GitOutput> {
    run_child_inner(cmd, Some(dur), max_output, input, None, None, None)
}

fn run_child_inner(
    mut cmd: Command,
    timeout: Option<Duration>,
    max_output: usize,
    input: Option<Vec<u8>>,
    control: Option<&Arc<ProcessCancellation>>,
    wsl: Option<(String, String)>,
    progress: Option<OutputSink<Option<GitProgress>>>,
) -> Result<GitOutput> {
    #[cfg(unix)]
    if control.is_some() {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    let (child, job) = if control.is_some() {
        let (child, job) =
            terax_core::modules::proc::job::ProcessJob::spawn(&mut cmd).map_err(GitError::Io)?;
        (child, Some(job))
    } else {
        (SharedChild::spawn(&mut cmd).map_err(GitError::Io)?, None)
    };
    #[cfg(not(windows))]
    let child = SharedChild::spawn(&mut cmd).map_err(GitError::Io)?;
    let child = Arc::new(child);
    #[cfg(windows)]
    let job = Arc::new(Mutex::new(job));
    let mut stdout_pipe = child
        .take_stdout()
        .ok_or_else(|| GitError::Spawn("no stdout pipe".into()))?;
    let mut stderr_pipe = child
        .take_stderr()
        .ok_or_else(|| GitError::Spawn("no stderr pipe".into()))?;

    let (ready_tx, ready_rx) = mpsc::channel();
    let needs_ready = wsl.is_some();
    let stdout_handle = thread::spawn(move || {
        if needs_ready {
            let mut reader = BufReader::new(stdout_pipe);
            let mut ready = Vec::new();
            let _ = reader.by_ref().take(64).read_until(b'\n', &mut ready);
            if ready == PROCESS_READY {
                let _ = ready_tx.send(());
            } else {
                return (ready, false);
            }
            drain(&mut reader, 64 * 1024, max_output, None)
        } else {
            drain(&mut stdout_pipe, 64 * 1024, max_output, None)
        }
    });
    let stderr_handle =
        thread::spawn(move || drain(&mut stderr_pipe, 4 * 1024, max_output, progress));

    // 输入和输出并行传输，避免批次超过管道容量时互相等待；超时仍由统一等待器控制。
    let input_handle = input.map(|input| {
        let mut stdin = child.take_stdin().expect("piped Git batch input");
        thread::spawn(move || stdin.write_all(&input))
    });

    if let Some(control) = control {
        // WSL 的进程组登记先于握手输出；未收到握手时取消入口不会误报成功。
        if !needs_ready || ready_rx.recv().is_ok() {
            let stopped_child = child.clone();
            #[cfg(windows)]
            let stopped_job = job.clone();
            control.register(move || {
                if let Some((distro, pid_file)) = &wsl {
                    group::terminate_wsl_group(distro, pid_file, false)?;
                }
                #[cfg(unix)]
                group::terminate_local_group(stopped_child.id())?;
                #[cfg(windows)]
                stopped_job.lock().expect("Git job poisoned").take();
                stopped_child.wait().map_err(|error| error.to_string())?;
                Ok(())
            });
        }
    }
    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let waited = match timeout {
        Some(timeout) => rx.recv_timeout(timeout),
        None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
    };
    let (exit_code, timed_out) = match waited {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(GitError::Io(e)),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(GitError::Spawn("git wait thread disconnected".into()));
        }
    };

    let (stdout, stdout_truncated) = stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr, _stderr_truncated) = stderr_handle.join().unwrap_or((Vec::new(), false));
    if let Some(input_handle) = input_handle {
        let written = input_handle.join().expect("Git batch input thread");
        // 提前失败时保留进程的实际错误，避免 BrokenPipe 掩盖目录或 Shell 错误。
        if !timed_out && exit_code == Some(0) {
            written?;
        }
    }

    // Windows Job 终止成员时也可能返回 0，已确认的取消必须独立于退出码。
    if control.is_some_and(|control| control.finish()) {
        return Err(GitError::Cancelled);
    }
    Ok(GitOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
        truncated: stdout_truncated,
    })
}

fn build_git_command(
    _workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: &[OsString],
) -> Result<Command> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = _workspace {
        validate_wsl_distro_name(distro)
            .map_err(|_| GitError::command("unsafe WSL distro name", distro.clone()))?;
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            cmd.arg("--cd").arg(cwd);
        }
        cmd.arg("--exec").arg("git");
        cmd.args(args);
        return Ok(cmd);
    }

    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.current_dir(Path::new(dir));
    }
    Ok(cmd)
}

pub fn ensure_success(output: &GitOutput, context: &'static str) -> Result<()> {
    if output.timed_out {
        return Err(GitError::TimedOut(context));
    }
    if output.exit_code == Some(0) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(err) = classify_auth_error(&stderr) {
        return Err(err);
    }
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "unknown git error".into()
    };
    Err(GitError::CommandFailed { context, detail })
}

fn classify_auth_error(stderr: &str) -> Option<GitError> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("authentication failed")
        || lower.contains("permission denied (publickey)")
        || lower.contains("invalid credentials")
    {
        return Some(GitError::AuthRequired(
            stderr.lines().next().unwrap_or(stderr).to_string(),
        ));
    }
    if lower.contains("host key verification failed") {
        return Some(GitError::HostKeyUnverified);
    }
    None
}

fn decode_text(bytes: Vec<u8>) -> TextSource {
    let sniff_len = bytes.len().min(8192);
    if bytes[..sniff_len].contains(&0) {
        return TextSource::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(text) => TextSource::Text(text),
        Err(e) => TextSource::Text(String::from_utf8_lossy(&e.into_bytes()).into_owned()),
    }
}

fn drain<R: Read>(
    reader: &mut R,
    prealloc: usize,
    max_output: usize,
    progress: Option<OutputSink<Option<GitProgress>>>,
) -> (Vec<u8>, bool) {
    let mut progress = progress.map(crate::progress::ProgressReader::new);
    let mut out: Vec<u8> = Vec::with_capacity(prealloc.min(max_output));
    let mut buf = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(progress) = &mut progress {
                    progress.feed(&buf[..n]);
                }
                if out.len() >= max_output {
                    truncated = true;
                    continue;
                }
                let take = (max_output - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    if let Some(progress) = &mut progress {
        progress.finish();
    }
    (out, truncated)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::build_git_command;
    use super::{
        index_is_locked, parse_git_version, prune_expired_availability_entries,
        run_git_index_mutation, version_meets_minimum, Availability, AvailabilityCache,
        AVAILABILITY_TTL,
    };
    use crate::types::GitOutput;
    use std::collections::HashMap;
    #[cfg(windows)]
    use std::ffi::OsString;
    use std::time::{Duration, Instant};
    use terax_core::modules::workspace::WorkspaceEnv;

    #[test]
    fn index_lock_retry_only_matches_file_exists_for_the_index_lock() {
        let mut output = GitOutput {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: Some(128),
            timed_out: false,
            truncated: false,
        };
        for path in [
            "/repo/.git/index.lock",
            "D:/repo/.git/index.lock",
            "D:\\repo\\.git\\worktrees\\branch\\index.lock",
        ] {
            output.stderr =
                format!("fatal: Unable to create '{path}': File exists.\n").into_bytes();
            assert!(index_is_locked(&output));
        }
        for stderr in [
            "fatal: Unable to create '/repo/.git/index.lock': Permission denied.",
            "fatal: Unable to create '/repo/.git/HEAD.lock': File exists.",
            "fatal: Unable to create '/repo/.git/index.lock': No such file or directory.",
            "fatal: pathspec 'index.lock' did not match any files",
        ] {
            output.stderr = stderr.as_bytes().to_vec();
            assert!(!index_is_locked(&output));
        }
        output.stderr = b"fatal: Unable to create 'index.lock': File exists.".to_vec();
        output.timed_out = true;
        assert!(!index_is_locked(&output));
        output.timed_out = false;
        output.exit_code = Some(0);
        assert!(!index_is_locked(&output));
    }

    #[test]
    fn persistent_index_lock_respects_timeout_and_is_never_removed() {
        if !std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return;
        }
        let repo = tempfile::TempDir::new().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        std::fs::write(repo.path().join("a.txt"), "new\n").unwrap();
        let lock_path = repo.path().join(".git/index.lock");
        std::fs::write(&lock_path, "lock owned elsewhere").unwrap();
        let started = Instant::now();
        let output = run_git_index_mutation(
            &WorkspaceEnv::Local,
            Some(repo.path().to_str().unwrap()),
            ["add", "--", "a.txt"],
            1,
        )
        .unwrap();
        // 最后一次重试可能在 Git 返回锁冲突前耗尽剩余预算。
        assert!(
            output.timed_out || index_is_locked(&output),
            "unexpected git exit {:?}: {}",
            output.exit_code,
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            std::fs::read_to_string(lock_path).unwrap(),
            "lock owned elsewhere"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires TERAX_TEST_WSL_DISTRO"]
    fn wsl_network_batch_cancel_kills_descendants_and_preserves_completed_frames() {
        use super::*;
        use terax_core::modules::remote::git_service::{GitBatchKind, GitRemoteAction};
        let distro = std::env::var("TERAX_TEST_WSL_DISTRO").unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = Command::new("wsl.exe")
            .args(["-d", &distro, "--exec", "wslpath", "-u"])
            .arg(temp.path())
            .output()
            .unwrap();
        assert!(path.status.success());
        let path = String::from_utf8(path.stdout).unwrap().trim().to_owned();
        let mut setup = Command::new("wsl.exe");
        setup
            .args(["-d", &distro, "--cd", &path, "--exec", "sh", "-s"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let script = b"set -e\ngit init -q -b main\ngit config user.name Test\ngit config user.email test@example.com\ngit config commit.gpgsign false\necho seed > file\ngit add file\ngit commit -qm seed\ngit init -q --bare origin\ngit remote add origin ./origin\ngit push -qu origin main\n";
        let output = run_child(
            setup,
            Duration::from_secs(30),
            MAX_OUTPUT_BYTES,
            Some(script.to_vec()),
        )
        .unwrap();
        ensure_success(&output, "WSL fixture").unwrap();
        std::fs::write(temp.path().join(".git/hooks/pre-push"), "#!/bin/sh\n(sh -c 'touch child-ready; i=0; while [ ! -f release ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; [ ! -f release ] || echo alive > survived') &\nwait\n").unwrap();
        let mut chmod = Command::new("wsl.exe");
        chmod.args([
            "-d",
            &distro,
            "--cd",
            &path,
            "--exec",
            "chmod",
            "+x",
            ".git/hooks/pre-push",
        ]);
        terax_core::modules::proc::hide_console(&mut chmod);
        assert!(chmod.status().unwrap().success());
        let control = Arc::new(ProcessCancellation::default());
        std::thread::scope(|scope| {
            let running = scope.spawn(|| {
                execute_wsl_batch(
                    &distro,
                    &path,
                    GitBatchKind::RemoteAction {
                        action: GitRemoteAction::Push,
                    },
                    Some(&control),
                )
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while !temp.path().join("child-ready").exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(temp.path().join("child-ready").exists());
            assert!(control.cancel().unwrap());
            assert!(matches!(running.join().unwrap(), Err(GitError::Cancelled)));
        });
        std::fs::write(temp.path().join("release"), "continue").unwrap();
        thread::sleep(Duration::from_millis(500));
        assert!(!temp.path().join("survived").exists());
        std::fs::remove_file(temp.path().join(".git/hooks/pre-push")).unwrap();
        let control = Arc::new(ProcessCancellation::default());
        let output = execute_wsl_batch(
            &distro,
            &path,
            GitBatchKind::RemoteAction {
                action: GitRemoteAction::Fetch,
            },
            Some(&control),
        )
        .unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].name, "action");
        assert_eq!(output[0].exit_code, 0);
        assert!(!control.cancel().unwrap());
    }

    #[test]
    fn extracts_simple_version() {
        assert_eq!(
            parse_git_version("git version 2.42.0"),
            Some("2.42.0".into())
        );
    }

    #[test]
    fn extracts_apple_version() {
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-145)"),
            Some("2.39.3".into())
        );
    }

    #[test]
    fn version_compare() {
        assert!(version_meets_minimum("2.23.0", "2.23"));
        assert!(version_meets_minimum("2.40.1", "2.23"));
        assert!(version_meets_minimum("3.0.0", "2.23"));
        assert!(!version_meets_minimum("2.22.0", "2.23"));
        assert!(!version_meets_minimum("1.9.5", "2.23"));
        // patch component must not regress the comparison
        assert!(version_meets_minimum("2.23.5", "2.23.4"));
        assert!(!version_meets_minimum("2.23.3", "2.23.4"));
    }

    #[test]
    fn prunes_expired_workspace_availability_entries() {
        let mut cache = HashMap::from([
            (
                "local".to_string(),
                AvailabilityCache {
                    value: Availability::Ok,
                    checked_at: Instant::now(),
                },
            ),
            (
                "wsl:Ubuntu".to_string(),
                AvailabilityCache {
                    value: Availability::NotInstalled,
                    checked_at: Instant::now() - AVAILABILITY_TTL - Duration::from_secs(1),
                },
            ),
        ]);

        prune_expired_availability_entries(&mut cache);

        assert!(cache.contains_key("local"));
        assert!(!cache.contains_key("wsl:Ubuntu"));
    }

    #[cfg(windows)]
    #[test]
    fn builds_wsl_git_command_with_cd_and_exec() {
        let cmd = build_git_command(
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
            Some("/home/vinicios/Nova pasta/repo"),
            &[OsString::from("status"), OsString::from("--short")],
        )
        .expect("valid WSL distro");
        let program = cmd.get_program().to_string_lossy().into_owned();
        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/vinicios/Nova pasta/repo",
                "--exec",
                "git",
                "status",
                "--short",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_unsafe_wsl_distro_name_for_git_command() {
        let err = build_git_command(
            &WorkspaceEnv::Wsl {
                distro: "../Ubuntu".into(),
            },
            None,
            &[],
        )
        .unwrap_err();
        assert!(err.to_string().contains("unsafe WSL distro name"));
    }
}
