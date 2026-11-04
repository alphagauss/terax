//! SSH 只负责采集批次，状态、引用摘要和 numstat 继续使用公共解析器。

use std::collections::HashMap;

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
use terax_core::modules::remote::git_service::{self, GitReadKind};
use terax_core::modules::workspace::WorkspaceEnv;

fn collect(
    path: &str,
    workspace: &WorkspaceEnv,
    kind: GitReadKind,
) -> Result<HashMap<String, GitOutput>> {
    let WorkspaceEnv::Ssh { profile_id } = workspace else {
        unreachable!()
    };
    let values = terax_core::runtime::block_on(git_service::read(profile_id, path, kind))
        .map_err(GitError::Spawn)?;
    Ok(values
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
        .collect())
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
    let values = collect(path, workspace, GitReadKind::Snapshot { include_graph })?;
    let root = output(&values, "root")?;
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
    let raw_status = output(&values, "status")?;
    ensure_success(raw_status, "git status failed")?;
    let status = status_from_output(&root, raw_status);
    let graph_revision = include_graph.then(|| {
        output(&values, "refs")
            .and_then(|refs| {
                output(&values, "symbolic")
                    .and_then(|symbolic| graph_revision_from_outputs(refs, symbolic))
            })
            .unwrap_or_else(|_| "unavailable".into())
    });
    Ok(GitPanelSnapshot {
        repo: Some(GitRepoInfo {
            repo_root: root,
            branch: status.branch.clone(),
            upstream: status.upstream.clone(),
            is_detached: status.is_detached,
        }),
        status: Some(status),
        graph_revision,
    })
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
    let values = collect(path, workspace, GitReadKind::Statistics { untracked })?;
    let side = |name, staged| -> Result<GitLineStats> {
        let raw = output(&values, name)?;
        ensure_success(raw, "git diff statistics failed")?;
        if raw.truncated {
            return Err(GitError::command("git diff statistics", "output truncated"));
        }
        let mut stats = sum_numstat(&raw.stdout)?;
        mark_incomplete_stats(&mut stats, status, staged);
        if !staged {
            for file in status.changed_files.iter().filter(|file| file.untracked) {
                let value = output(&values, &format!("untracked:{}", file.path))
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
