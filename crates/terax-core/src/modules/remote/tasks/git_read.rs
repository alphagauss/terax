//! 在一个 SSH channel 中采集固定 Git 输出，以长度帧保留 NUL 路径和独立退出状态。

use std::sync::Arc;
use std::time::Duration;

use super::TaskKind;
use crate::modules::remote::git_service::{GitReadKind, GitReadOutput};
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/git_read.sh");
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub(crate) async fn read(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    kind: GitReadKind,
) -> Result<Vec<GitReadOutput>, String> {
    let script = script(path, kind)?;
    let command = format!("exec bash -c {}", shell_quote(&script));
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::GitRead,
            &command,
            None,
            Duration::from_secs(30),
            OUTPUT_LIMIT,
        )
        .await?;
    if output.timed_out {
        return Err("remote Git read timed out".into());
    }
    if output.truncated {
        return Err("remote Git read output truncated".into());
    }
    if output.exit_code != Some(0) {
        return Err(format!(
            "remote Git read failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse(&output.stdout)
}

fn script(path: &str, kind: GitReadKind) -> Result<String, String> {
    let (mode, graph, paths) = match kind {
        GitReadKind::Snapshot { include_graph } => ("snapshot", include_graph, Vec::new()),
        GitReadKind::Statistics { untracked } => ("statistics", false, untracked),
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
        "target={}; mode={mode}; graph={}; paths=({paths}); {SOURCE}",
        shell_quote(path),
        usize::from(graph)
    ))
}

fn parse(mut bytes: &[u8]) -> Result<Vec<GitReadOutput>, String> {
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
        result.push(GitReadOutput {
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
            GitReadKind::Statistics {
                untracked: vec!["../outside".into()]
            }
        )
        .is_err());
    }

    #[test]
    fn batch_reads_real_git_outputs_and_counts_untracked_files_without_contents() {
        use std::process::Command;
        let Ok(git) = which::which("git") else {
            eprintln!("skipping SSH script integration: Git is unavailable");
            return;
        };
        #[cfg(windows)]
        let bash = git
            .parent()
            .and_then(|path| path.parent())
            .map(|path| path.join("bin/bash.exe"));
        #[cfg(not(windows))]
        let bash = which::which("bash").ok();
        let Some(bash) = bash.filter(|path| path.is_file()) else {
            eprintln!("skipping SSH script integration: Bash is unavailable");
            return;
        };
        // 脚本面向 Linux SSH，macOS 宿主未必安装 GNU stat。
        if !Command::new(&bash)
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
        let name = "new ' $ file.txt";
        std::fs::write(temp.path().join(name), "one\ntwo").unwrap();
        std::fs::write(temp.path().join("empty.txt"), "").unwrap();
        std::fs::write(temp.path().join("binary.bin"), [0, 1, 2]).unwrap();
        std::fs::write(
            temp.path().join("large.txt"),
            vec![b'x'; 2 * 1024 * 1024 + 1],
        )
        .unwrap();
        let run = |kind| {
            let output = Command::new(&bash)
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
        let values = run(GitReadKind::Snapshot {
            include_graph: true,
        });
        assert_eq!(
            values
                .iter()
                .map(|value| value.name.as_str())
                .collect::<Vec<_>>(),
            ["root", "status", "refs", "symbolic"]
        );
        assert!(values
            .iter()
            .find(|value| value.name == "status")
            .unwrap()
            .stdout
            .windows(name.len())
            .any(|window| window == name.as_bytes()));
        let values = run(GitReadKind::Statistics {
            untracked: vec![
                name.into(),
                "empty.txt".into(),
                "binary.bin".into(),
                "large.txt".into(),
            ],
        });
        let text = values
            .iter()
            .find(|value| value.name == format!("untracked:{name}"))
            .unwrap();
        assert_eq!(text.exit_code, 1);
        assert!(text.stdout.starts_with(b"2\t0\t"));
        assert!(!text.stdout.windows(7).any(|window| window == b"one\ntwo"));
        let empty = values
            .iter()
            .find(|value| value.name == "untracked:empty.txt")
            .unwrap();
        assert!(matches!(empty.exit_code, 0 | 1));
        assert!(empty.stdout.is_empty() || empty.stdout.starts_with(b"0\t0\t"));
        assert!(values
            .iter()
            .find(|value| value.name == "untracked:binary.bin")
            .unwrap()
            .stdout
            .starts_with(b"-\t-\t"));
        assert_ne!(
            values
                .iter()
                .find(|value| value.name == "untracked:large.txt")
                .unwrap()
                .exit_code,
            0
        );
        std::fs::remove_dir_all(temp.path().join(".git")).unwrap();
        let values = run(GitReadKind::Snapshot {
            include_graph: false,
        });
        assert_eq!(values.len(), 1);
        assert_ne!(values[0].exit_code, 0);
    }
}
