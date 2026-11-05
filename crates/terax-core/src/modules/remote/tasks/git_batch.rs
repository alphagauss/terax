//! SSH 与 WSL 共用的固定 Git 批次脚本与长度帧编解码。
//! SSH 执行交给连接级任务运行时，联网操作不会因为传输失败而重放。

use std::sync::Arc;
use std::time::Duration;

use super::TaskKind;
use crate::modules::remote::git_service::{
    GitBatchKind, GitBatchOutput, GitRemoteAction, HISTORY_FORMAT,
};
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/git_batch.sh");
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub(crate) async fn execute(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    kind: GitBatchKind,
    control: Option<&Arc<crate::modules::proc::cancellation::ProcessCancellation>>,
) -> Result<Vec<GitBatchOutput>, String> {
    let timeout = kind.timeout_secs().map(Duration::from_secs);
    let script = script(path, kind)?;
    let output = if let Some(timeout) = timeout {
        workspace
            .tasks
            .run(
                workspace,
                TaskKind::GitBatch,
                "exec sh -s",
                Some(script.into_bytes()),
                timeout,
                OUTPUT_LIMIT,
            )
            .await?
    } else {
        let control = control.ok_or("Git network operation requires cancellation control")?;
        let channel = workspace
            .tasks
            .take_channel(workspace, TaskKind::GitBatch)
            .await?;
        workspace
            .exec_git_on_channel(channel, script.into_bytes(), OUTPUT_LIMIT, control)
            .await?
    };
    if output.timed_out {
        return Err("remote Git batch timed out".into());
    }
    if output.truncated {
        return Err("remote Git batch output truncated".into());
    }
    if output.exit_code != Some(0) {
        return Err(format!(
            "remote Git batch failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse(&output.stdout)
}

pub(crate) fn script(path: &str, kind: GitBatchKind) -> Result<String, String> {
    if path.contains('\0') {
        return Err("invalid Git directory".into());
    }
    let (mode, graph, paths, limit, skip, action) = match kind {
        GitBatchKind::Snapshot { include_graph } => {
            ("snapshot", include_graph, Vec::new(), 0, 0, "")
        }
        GitBatchKind::Statistics { untracked } => ("statistics", false, untracked, 0, 0, ""),
        GitBatchKind::History { limit, skip } => {
            ("history", false, Vec::new(), limit.clamp(1, 200), skip, "")
        }
        GitBatchKind::RemoteAction { action } => (
            "action",
            false,
            Vec::new(),
            0,
            0,
            match action {
                GitRemoteAction::Fetch => "fetch",
                GitRemoteAction::Pull => "pull",
                GitRemoteAction::Push => "push",
            },
        ),
    };
    for path in &paths {
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\0')
            || path.split('/').any(|part| part == ".." || part == ".")
        {
            return Err("invalid untracked Git path".into());
        }
    }
    let paths = paths
        .iter()
        .map(|path| shell_quote(path))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "target={}; mode={mode}; graph={}; set -- {paths}; limit={limit}; skip={skip}; action={action}; history_format={}; {SOURCE}",
        shell_quote(path),
        usize::from(graph),
        shell_quote(HISTORY_FORMAT),
    ))
}

pub(crate) fn parse(mut bytes: &[u8]) -> Result<Vec<GitBatchOutput>, String> {
    fn field<'a>(bytes: &mut &'a [u8]) -> Result<&'a str, String> {
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("incomplete Git frame")?;
        let value = std::str::from_utf8(&bytes[..end]).map_err(|_| "invalid Git frame")?;
        *bytes = &bytes[end + 1..];
        Ok(value)
    }
    let mut result = Vec::new();
    while !bytes.is_empty() {
        let name = field(&mut bytes)?.to_string();
        let exit_code = field(&mut bytes)?
            .parse()
            .map_err(|_| "invalid Git exit code")?;
        let stdout_len: usize = field(&mut bytes)?
            .parse()
            .map_err(|_| "invalid Git output size")?;
        let stderr_len: usize = field(&mut bytes)?
            .parse()
            .map_err(|_| "invalid Git error size")?;
        let total = stdout_len
            .checked_add(stderr_len)
            .ok_or("invalid Git frame size")?;
        if total > bytes.len() {
            return Err("incomplete Git output".into());
        }
        result.push(GitBatchOutput {
            name,
            exit_code,
            stdout: bytes[..stdout_len].to_vec(),
            stderr: bytes[stdout_len..total].to_vec(),
        });
        bytes = &bytes[total..];
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_preserve_nul_paths_and_reject_incomplete_payloads() {
        let outputs = parse(b"status\0\x30\0\x34\0\x30\0a\0b\0").unwrap();
        assert_eq!(outputs[0].stdout, b"a\0b\0");
        assert!(parse(b"status\0\x30\0\x35\0\x30\0a\0b\0").is_err());
        assert!(parse(b"status\0\x30\0\x34\0").is_err());
        assert!(script(
            "/repo",
            GitBatchKind::Statistics {
                untracked: vec!["../outside".into()]
            }
        )
        .is_err());
    }

    #[test]
    fn batches_bound_file_reads_and_execute_network_actions_once() {
        use std::process::Command;
        let Ok(git) = which::which("git") else {
            eprintln!("skipping SSH script integration: Git is unavailable");
            return;
        };
        #[cfg(windows)]
        let shell = git
            .parent()
            .and_then(|path| path.parent())
            .map(|path| path.join("bin/sh.exe"));
        #[cfg(not(windows))]
        let shell = which::which("sh").ok();
        let Some(shell) = shell.filter(|path| path.is_file()) else {
            eprintln!("skipping SSH script integration: sh is unavailable");
            return;
        };
        // 脚本面向 Linux SSH，macOS 宿主未必安装 GNU stat。
        if !Command::new(&shell)
            .args(["-c", "stat -c %s -- /dev/null >/dev/null 2>&1"])
            .status()
            .is_ok_and(|status| status.success())
        {
            eprintln!("skipping SSH script integration: GNU stat is unavailable");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new(&git)
                .args(args)
                .current_dir(temp.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&["config", "pull.rebase", "false"]);
        std::fs::write(temp.path().join("tracked.txt"), "old\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&[
            "-c",
            "user.name=Terax",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "seed",
        ]);
        std::fs::write(temp.path().join("tracked.txt"), "new\n").unwrap();
        std::fs::write(
            temp.path().join("large.txt"),
            vec![b'x'; 2 * 1024 * 1024 + 1],
        )
        .unwrap();
        let run = |kind| {
            let output = Command::new(&shell)
                .arg("-c")
                .arg(script(".", kind).unwrap())
                .current_dir(temp.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            parse(&output.stdout).unwrap()
        };
        let values = run(GitBatchKind::Statistics {
            untracked: vec!["large.txt".into()],
        });
        assert_ne!(
            values
                .iter()
                .find(|value| value.name == "untracked:large.txt")
                .unwrap()
                .exit_code,
            0
        );
        // 记录整个批次中的 Git 子命令，确保只读批次不访问 origin，联网失败也不重试。
        let record = |kind| {
            let _ = std::fs::remove_file(temp.path().join("calls"));
            let script = format!(
                "git() {{ printf '%s\\n' \"$1\" >>calls; command git \"$@\"; }}; {}",
                script(".", kind).unwrap()
            );
            let output = Command::new(&shell)
                .args(["-c", &script])
                .current_dir(temp.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (
                parse(&output.stdout).unwrap(),
                std::fs::read_to_string(temp.path().join("calls")).unwrap(),
            )
        };
        let (_, calls) = record(GitBatchKind::Snapshot {
            include_graph: true,
        });
        assert!(!calls
            .lines()
            .any(|verb| matches!(verb, "fetch" | "pull" | "push")));
        let (_, calls) = record(GitBatchKind::History { limit: 40, skip: 0 });
        assert!(!calls
            .lines()
            .any(|verb| matches!(verb, "fetch" | "pull" | "push")));
        let (values, calls) = record(GitBatchKind::RemoteAction {
            action: GitRemoteAction::Push,
        });
        assert_eq!(calls.lines().collect::<Vec<_>>(), ["rev-parse"]);
        assert!(!values.iter().any(|value| value.name == "action"));
        for (action, verb) in [
            (GitRemoteAction::Fetch, "fetch"),
            (GitRemoteAction::Pull, "pull"),
        ] {
            let (values, calls) = record(GitBatchKind::RemoteAction { action });
            assert_eq!(calls.lines().collect::<Vec<_>>(), [verb]);
            // 没有配置 origin，真实失败仍只执行一次，也不回退到其他联网命令。
            if verb == "pull" {
                assert_ne!(
                    values
                        .iter()
                        .find(|value| value.name == "action")
                        .unwrap()
                        .exit_code,
                    0
                );
            }
        }
        let origin = tempfile::tempdir().unwrap();
        let origin_path = origin.path().to_string_lossy().into_owned();
        git(&["init", "--bare", "-q", &origin_path]);
        git(&["remote", "add", "origin", &origin_path]);
        git(&["push", "-qu", "origin", "main"]);
        for (action, expected) in [
            (GitRemoteAction::Fetch, vec!["fetch"]),
            (GitRemoteAction::Pull, vec!["pull"]),
            (GitRemoteAction::Push, vec!["rev-parse", "push"]),
        ] {
            let (values, calls) = record(GitBatchKind::RemoteAction { action });
            assert_eq!(calls.lines().collect::<Vec<_>>(), expected);
            let output = values.iter().find(|value| value.name == "action").unwrap();
            assert_eq!(
                output.exit_code,
                0,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret"), "outside\n").unwrap();
            std::os::unix::fs::symlink(outside.path(), temp.path().join("linked")).unwrap();
            let values = run(GitBatchKind::Statistics {
                untracked: vec!["linked/secret".into()],
            });
            assert_ne!(
                values
                    .iter()
                    .find(|value| value.name == "untracked:linked/secret")
                    .unwrap()
                    .exit_code,
                0
            );
        }
        std::fs::remove_dir_all(temp.path().join(".git")).unwrap();
        let values = run(GitBatchKind::Snapshot {
            include_graph: false,
        });
        assert_eq!(values.len(), 1);
        assert_ne!(values[0].exit_code, 0);
    }
}
