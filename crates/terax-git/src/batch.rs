//! WSL 与 SSH 通过固定批次采集原始字节，与本地共用 Git 结果解析和组装。

use std::collections::HashMap;
use std::sync::Arc;
use terax_core::modules::proc::cancellation::ProcessCancellation;

use crate::errors::{GitError, Result};
use crate::operations::{
    graph_revision_from_outputs, mark_incomplete_stats, status_from_output, sum_numstat,
};
use crate::process::ensure_success;
use crate::types::{
    GitLineStats, GitOutput, GitPanelDiffStats, GitPanelSnapshot, GitRepoInfo, GitStatusSnapshot,
    MAX_OUTPUT_BYTES,
};
use crate::utils::is_safe_pathspec;
use terax_core::modules::remote::git_service::{self, GitBatchKind};
use terax_core::modules::workspace::WorkspaceEnv;

fn collect(
    path: &str,
    workspace: &WorkspaceEnv,
    kind: GitBatchKind,
) -> Result<HashMap<String, GitOutput>> {
    collect_controlled(path, workspace, kind, None)
}

fn collect_controlled(
    path: &str,
    workspace: &WorkspaceEnv,
    kind: GitBatchKind,
    control: Option<&Arc<ProcessCancellation>>,
) -> Result<HashMap<String, GitOutput>> {
    let values = match workspace {
        WorkspaceEnv::Ssh { profile_id } => {
            terax_core::runtime::block_on(git_service::execute(profile_id, path, kind, control))
                .map_err(|error| {
                    if error == terax_core::modules::proc::cancellation::PROCESS_CANCELLED {
                        GitError::Cancelled
                    } else {
                        GitError::Spawn(error)
                    }
                })?
        }
        #[cfg(windows)]
        WorkspaceEnv::Wsl { distro } => {
            crate::process::execute_wsl_batch(distro, path, kind, control)?
        }
        _ => return Err(GitError::command("Git batch", "unsupported workspace")),
    };
    Ok(decode(values))
}

fn decode(values: Vec<git_service::GitBatchOutput>) -> HashMap<String, GitOutput> {
    values
        .into_iter()
        .map(|mut value| {
            let truncated = value.stdout.len() > MAX_OUTPUT_BYTES;
            value.stdout.truncate(MAX_OUTPUT_BYTES);
            value.stderr.truncate(4096);
            (
                value.name,
                GitOutput {
                    stdout: value.stdout,
                    stderr: value.stderr,
                    exit_code: Some(value.exit_code),
                    timed_out: false,
                    truncated,
                },
            )
        })
        .collect()
}

fn output<'a>(values: &'a HashMap<String, GitOutput>, name: &str) -> Result<&'a GitOutput> {
    values
        .get(name)
        .ok_or_else(|| GitError::command("Git read", format!("missing {name}")))
}

pub(super) fn snapshot(
    path: &str,
    workspace: &WorkspaceEnv,
    include_graph: bool,
) -> Result<GitPanelSnapshot> {
    let values = collect(path, workspace, GitBatchKind::Snapshot { include_graph })?;
    snapshot_from_outputs(&values, include_graph)
}

fn snapshot_from_outputs(
    values: &HashMap<String, GitOutput>,
    include_graph: bool,
) -> Result<GitPanelSnapshot> {
    let root = output(values, "root")?;
    if root.exit_code != Some(0) {
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
            graph_revision: None,
        });
    }
    let root_text = String::from_utf8_lossy(&root.stdout);
    let root = root_text
        .strip_suffix('\n')
        .unwrap_or(&root_text)
        .to_string();
    let raw_status = output(values, "status")?;
    ensure_success(raw_status, "git status failed")?;
    let status = status_from_output(&root, raw_status);
    let graph_revision = include_graph.then(|| {
        output(values, "refs")
            .and_then(|refs| {
                output(values, "symbolic")
                    .and_then(|symbolic| graph_revision_from_outputs(refs, symbolic))
            })
            .unwrap_or_else(|_| "unavailable".into())
    });
    Ok(snapshot_from_status(status, graph_revision))
}

pub(super) fn snapshot_from_status(
    status: GitStatusSnapshot,
    graph_revision: Option<String>,
) -> GitPanelSnapshot {
    GitPanelSnapshot {
        repo: Some(GitRepoInfo {
            repo_root: status.repo_root.clone(),
            branch: status.branch.clone(),
            upstream: status.upstream.clone(),
            is_detached: status.is_detached,
        }),
        status: Some(status),
        graph_revision,
    }
}

/// 历史分页的原始输出在传输之后统一解析，后端不维护自己的引用过滤规则。
pub(super) struct HistoryRead {
    pub remote_names: std::collections::HashSet<String>,
    pub current_branch: Option<String>,
    pub upstream_label: Option<String>,
    pub output: GitOutput,
}

pub(super) fn history(
    path: &str,
    workspace: &WorkspaceEnv,
    limit: u32,
    skip: u32,
) -> Result<HistoryRead> {
    use crate::process::run_git;
    use crate::types::DEFAULT_TIMEOUT_SECS;
    let mut values = if matches!(workspace, WorkspaceEnv::Local) {
        let mut values = HashMap::new();
        for (name, args) in [
            ("remote", vec!["remote"]),
            ("branch", vec!["symbolic-ref", "--quiet", "--short", "HEAD"]),
            (
                "upstream",
                vec!["rev-parse", "--symbolic-full-name", "@{upstream}"],
            ),
        ] {
            values.insert(
                name.into(),
                run_git(workspace, Some(path), args, DEFAULT_TIMEOUT_SECS)?,
            );
        }
        let upstream = first_line(output(&values, "upstream")?)?;
        let mut args = vec![
            "log".to_string(),
            "--no-color".into(),
            "--topo-order".into(),
            "--ignore-missing".into(),
            format!("--max-count={limit}"),
            format!("--skip={skip}"),
            format!("--format={}", git_service::HISTORY_FORMAT),
            "HEAD".into(),
        ];
        if let Some(upstream) = upstream {
            args.push(upstream);
        }
        args.push("--".into());
        values.insert(
            "log".into(),
            run_git(workspace, Some(path), args, DEFAULT_TIMEOUT_SECS)?,
        );
        values
    } else {
        collect(path, workspace, GitBatchKind::History { limit, skip })?
    };
    history_from_outputs(&mut values)
}

fn history_from_outputs(values: &mut HashMap<String, GitOutput>) -> Result<HistoryRead> {
    let remote = output(values, "remote")?;
    if remote.timed_out {
        return Err(GitError::TimedOut("git remote"));
    }
    let remote_names = String::from_utf8_lossy(&remote.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    let current_branch = first_line(output(values, "branch")?)?;
    let upstream_label = first_line(output(values, "upstream")?)?.map(|reference| {
        reference
            .strip_prefix("refs/remotes/")
            .or_else(|| reference.strip_prefix("refs/heads/"))
            .unwrap_or(&reference)
            .to_string()
    });
    let output = values
        .remove("log")
        .ok_or_else(|| GitError::command("Git read", "missing log"))?;
    Ok(HistoryRead {
        remote_names,
        current_branch,
        upstream_label,
        output,
    })
}

fn first_line(output: &GitOutput) -> Result<Option<String>> {
    if output.timed_out {
        return Err(GitError::TimedOut("Git read"));
    }
    if output.exit_code != Some(0) {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string))
}

pub(super) fn remote_action(
    path: &str,
    workspace: &WorkspaceEnv,
    action: git_service::GitRemoteAction,
    control: &Arc<ProcessCancellation>,
) -> Result<Option<String>> {
    let values = collect_controlled(
        path,
        workspace,
        GitBatchKind::RemoteAction { action },
        Some(control),
    )?;
    let upstream = if matches!(action, git_service::GitRemoteAction::Push) {
        Some(first_line(output(&values, "upstream")?)?.ok_or(GitError::NoUpstream)?)
    } else {
        None
    };
    let context = match action {
        git_service::GitRemoteAction::Fetch => "git fetch failed",
        git_service::GitRemoteAction::Pull => "git pull --ff-only failed",
        git_service::GitRemoteAction::Push => "git push failed",
    };
    ensure_success(output(&values, "action")?, context)?;
    Ok(upstream)
}

pub(super) fn statistics(
    path: &str,
    status: &GitStatusSnapshot,
    workspace: &WorkspaceEnv,
) -> Result<GitPanelDiffStats> {
    let untracked = status
        .changed_files
        .iter()
        .filter(|file| file.untracked && is_safe_pathspec(&file.path))
        .map(|file| file.path.clone())
        .collect();
    let values = collect(path, workspace, GitBatchKind::Statistics { untracked })?;
    statistics_from_outputs(&values, status)
}

fn statistics_from_outputs(
    values: &HashMap<String, GitOutput>,
    status: &GitStatusSnapshot,
) -> Result<GitPanelDiffStats> {
    let side = |name, staged| -> Result<GitLineStats> {
        let raw = output(values, name)?;
        ensure_success(raw, "git diff statistics failed")?;
        if raw.truncated {
            return Err(GitError::command("git diff statistics", "output truncated"));
        }
        let mut stats = sum_numstat(&raw.stdout)?;
        mark_incomplete_stats(&mut stats, status, staged);
        if !staged {
            for file in status.changed_files.iter().filter(|file| file.untracked) {
                let value = output(values, &format!("untracked:{}", file.path))
                    .ok()
                    .filter(|raw| matches!(raw.exit_code, Some(0 | 1)))
                    .and_then(|raw| {
                        if raw.stdout.is_empty() && raw.exit_code == Some(0) {
                            return Some(Default::default());
                        }
                        sum_numstat(&raw.stdout)
                            .ok()
                            .and_then(|mut stats| stats.files.remove(&file.path))
                    });
                let value = value.unwrap_or_else(|| crate::types::GitFileLineStats {
                    incomplete: true,
                    ..Default::default()
                });
                stats.added += value.added;
                stats.removed += value.removed;
                stats.incomplete |= value.incomplete;
                stats.files.insert(file.path.clone(), value);
            }
        }
        Ok(stats)
    };
    Ok(GitPanelDiffStats {
        worktree: side("worktree", false).ok(),
        index: side("index", true).ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use terax_core::modules::workspace::WorkspaceRegistry;

    #[test]
    fn linux_batches_and_native_reads_share_snapshot_statistics_and_history_semantics() {
        #[cfg(windows)]
        let shell = {
            let Some(path) = std::env::var_os("PATH") else {
                return;
            };
            let git = std::env::split_paths(&path)
                .map(|path| path.join("git.exe"))
                .find(|path| path.is_file());
            let Some(shell) = git
                .and_then(|git| git.parent()?.parent().map(|path| path.join("bin/sh.exe")))
                .filter(|path| path.is_file())
            else {
                eprintln!("skipping batch parity: Git sh is unavailable");
                return;
            };
            shell
        };
        #[cfg(not(windows))]
        let shell = std::path::PathBuf::from("sh");
        if !Command::new(&shell)
            .args(["-c", "stat -c %s -- /dev/null >/dev/null 2>&1"])
            .status()
            .is_ok_and(|status| status.success())
        {
            eprintln!("skipping batch parity: GNU stat is unavailable");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(temp.path()).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&path).unwrap();
        let root = crate::utils::display_path(&path);
        let env = WorkspaceEnv::Local;
        let git = |args: &[&str]| {
            ensure_success(
                &crate::process::run_git(&env, Some(&root), args, 30).unwrap(),
                "fixture Git",
            )
            .unwrap();
        };
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "false"]);
        std::fs::write(path.join("file.txt"), "old\n").unwrap();
        git(&["add", "."]);
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
        std::fs::write(path.join("file.txt"), "staged\n").unwrap();
        git(&["add", "."]);
        std::fs::write(path.join("file.txt"), "unstaged\nextra\n").unwrap();
        std::fs::write(path.join("new ' $ file.txt"), "one\ntwo").unwrap();
        std::fs::write(path.join("empty.txt"), "").unwrap();
        std::fs::write(path.join("binary.bin"), [0, 1, 2]).unwrap();
        let run = |kind| {
            let script = git_service::batch_script(".", kind).unwrap();
            let mut command = Command::new(&shell);
            command
                .arg("-s")
                .current_dir(&path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let output = crate::process::run_child(
                command,
                Duration::from_secs(30),
                8 * 1024 * 1024,
                Some(script.into_bytes()),
            )
            .unwrap();
            ensure_success(&output, "batch fixture").unwrap();
            decode(git_service::parse_batch(&output.stdout).unwrap())
        };
        let native = crate::operations::panel_snapshot(&registry, &root, &env, true).unwrap();
        let batch = snapshot_from_outputs(
            &run(GitBatchKind::Snapshot {
                include_graph: true,
            }),
            true,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&native).unwrap(),
            serde_json::to_value(batch).unwrap()
        );
        let status = native.status.unwrap();
        let paths = status
            .changed_files
            .iter()
            .filter(|file| file.untracked)
            .map(|file| file.path.clone())
            .collect();
        let batch =
            statistics_from_outputs(&run(GitBatchKind::Statistics { untracked: paths }), &status)
                .unwrap();
        let native = crate::operations::panel_diff_stats(&registry, &root, &env, &status).unwrap();
        assert_eq!(
            serde_json::to_value(native).unwrap(),
            serde_json::to_value(batch).unwrap()
        );
        let native = history(&root, &env, 40, 0).unwrap();
        let batch =
            history_from_outputs(&mut run(GitBatchKind::History { limit: 40, skip: 0 })).unwrap();
        assert_eq!(native.remote_names, batch.remote_names);
        assert_eq!(native.current_branch, batch.current_branch);
        assert_eq!(native.upstream_label, batch.upstream_label);
        assert_eq!(native.output.stdout, batch.output.stdout);
        let page =
            history_from_outputs(&mut run(GitBatchKind::History { limit: 1, skip: 1 })).unwrap();
        assert_eq!(page.output.exit_code, Some(0));
        assert!(page.output.stdout.is_empty());

        // 超过 Windows 命令行上限的路径清单仍经同一个输入管道传输。
        let paths: Vec<_> = (0..12)
            .map(|index| format!("{}missing-{index}", "deep/".repeat(600)))
            .collect();
        assert!(paths.iter().map(String::len).sum::<usize>() > 32_768);
        let values = run(GitBatchKind::Statistics { untracked: paths });
        assert_eq!(values.len(), 14);
        assert!(values
            .iter()
            .filter(|(name, _)| name.starts_with("untracked:"))
            .all(|(_, output)| output.exit_code == Some(1)));
    }
}
