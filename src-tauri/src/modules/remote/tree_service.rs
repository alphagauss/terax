//! SSH 远端树枚举服务。
//!
//! 递归文件列表、路径搜索和搜索回退共享同一 Bash 优先实现。服务器缺少所需 GNU
//! 能力或协议失配时，服务回退现有 raw SFTP walker，调用方不接触后端选择。

use globset::{Glob, GlobSet, GlobSetBuilder};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use super::session::{join_remote, RemoteWorkspace};
use super::sftp::{self, RemoteEntryKind, RemoteWalkEntry};
use super::tasks::{self, TaskKind};

const TREE_LIST_MARKER: &[u8] = b"TERAX_TREE_LIST_V1";

/// 使用 ripgrep 首选路径或共享树回退枚举文件。
pub(crate) async fn list_files(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    pattern: Option<&str>,
    show_hidden: bool,
    max_depth: usize,
    max_results: usize,
) -> Result<(Vec<RemoteWalkEntry>, bool), String> {
    let matcher = pattern.map(build_globset).transpose()?;
    let task = TaskKind::RipgrepFiles;
    if workspace.tasks.should_attempt(task) {
        match list_files_rg(
            workspace,
            root,
            pattern,
            show_hidden,
            max_depth,
            max_results,
        )
        .await
        {
            Ok(result) => {
                workspace.tasks.mark_available(task);
                return Ok(result);
            }
            Err(TreeTaskError::Unavailable(reason)) => {
                workspace.mark_task_unavailable(task, reason);
            }
            Err(TreeTaskError::Business(error)) => return Err(error),
            Err(TreeTaskError::Protocol(error)) => {
                workspace.mark_task_unavailable(task, error);
            }
            Err(TreeTaskError::Transport(error)) => return Err(error),
        }
    }

    let (entries, mut truncated) = walk(workspace, root, show_hidden, max_depth, 50_000).await?;
    let mut files = Vec::new();
    for entry in entries {
        if entry.kind != RemoteEntryKind::File
            || matcher
                .as_ref()
                .is_some_and(|matcher| !matcher.is_match(&entry.rel))
        {
            continue;
        }
        if files.len() >= max_results {
            truncated = true;
            break;
        }
        files.push(entry);
    }
    Ok((files, truncated))
}

/// 使用 Bash 首选路径或 SFTP 回退递归枚举远端树。
pub(crate) async fn walk(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    show_hidden: bool,
    max_depth: usize,
    max_entries: usize,
) -> Result<(Vec<RemoteWalkEntry>, bool), String> {
    walk_cancellable(workspace, root, show_hidden, max_depth, max_entries, None).await
}

/// 使用 Bash 首选路径或 SFTP 回退枚举远端树，并传播交互式取消。
pub(crate) async fn walk_cancellable(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    show_hidden: bool,
    max_depth: usize,
    max_entries: usize,
    cancellation: Option<&CancellationToken>,
) -> Result<(Vec<RemoteWalkEntry>, bool), String> {
    let task = TaskKind::TreeList;
    if workspace.tasks.should_attempt(task) {
        match walk_bash(
            workspace,
            root,
            show_hidden,
            max_depth,
            max_entries,
            cancellation,
        )
        .await
        {
            Ok(result) => {
                workspace.tasks.mark_available(task);
                return Ok(result);
            }
            Err(TreeTaskError::Unavailable(reason)) => {
                workspace.mark_task_unavailable(task, reason);
            }
            Err(TreeTaskError::Business(error)) => return Err(error),
            Err(TreeTaskError::Protocol(error)) => {
                workspace.mark_task_unavailable(task, error);
            }
            Err(TreeTaskError::Transport(error)) => return Err(error),
        }
    }
    sftp::walk_cancellable(
        workspace,
        root,
        show_hidden,
        max_depth,
        max_entries,
        cancellation,
    )
    .await
}

#[derive(Debug)]
enum TreeTaskError {
    Unavailable(String),
    Business(String),
    Protocol(String),
    Transport(String),
}

async fn list_files_rg(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    pattern: Option<&str>,
    show_hidden: bool,
    max_depth: usize,
    max_results: usize,
) -> Result<(Vec<RemoteWalkEntry>, bool), TreeTaskError> {
    super::session::validate_remote_path(root).map_err(TreeTaskError::Business)?;
    let mut args = vec![
        "rg".to_string(),
        "--files".to_string(),
        "--null".to_string(),
        "--no-messages".to_string(),
        "--max-depth".to_string(),
        max_depth.to_string(),
    ];
    if show_hidden {
        args.push("--hidden".into());
    }
    for directory in [
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        ".venv",
        "__pycache__",
    ] {
        args.push("--glob".into());
        args.push(format!("!{directory}/**"));
    }
    if let Some(pattern) = pattern {
        args.push("--glob".into());
        args.push(pattern.to_string());
    }
    args.push("--".into());
    args.push(root.to_string());
    let output = tasks::ripgrep::files(workspace, &args)
        .await
        .map_err(TreeTaskError::Transport)?;
    if output.timed_out {
        return Err(TreeTaskError::Transport(
            "remote ripgrep file listing timed out".into(),
        ));
    }
    match output.exit_code {
        Some(126) => Err(TreeTaskError::Unavailable(
            "ripgrep file-list options are unavailable".into(),
        )),
        Some(127) => Err(TreeTaskError::Unavailable("ripgrep unavailable".into())),
        Some(0 | 1) => parse_rg_files(&output.stdout, root, max_results, output.truncated)
            .map_err(TreeTaskError::Protocol),
        Some(code) => Err(TreeTaskError::Business(format!(
            "remote ripgrep file listing failed with exit code {code}"
        ))),
        None => Err(TreeTaskError::Transport(
            "remote ripgrep file listing closed without an exit status".into(),
        )),
    }
}

fn parse_rg_files(
    bytes: &[u8],
    root: &str,
    max_results: usize,
    output_truncated: bool,
) -> Result<(Vec<RemoteWalkEntry>, bool), String> {
    let ended_on_boundary = bytes.ends_with(&[0]);
    let chunks: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut entries = Vec::new();
    let mut truncated = output_truncated;
    for (index, bytes) in chunks.iter().enumerate() {
        if bytes.is_empty() {
            continue;
        }
        if output_truncated && index + 1 == chunks.len() && !ended_on_boundary {
            truncated = true;
            break;
        }
        if entries.len() >= max_results {
            truncated = true;
            break;
        }
        let path = std::str::from_utf8(bytes)
            .map_err(|_| "remote ripgrep path is not UTF-8".to_string())?;
        let absolute = remote_absolute(root, path);
        let rel = remote_relative(root, &absolute);
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        entries.push(RemoteWalkEntry {
            path: absolute,
            rel,
            name,
            kind: RemoteEntryKind::File,
            size: 0,
        });
    }
    Ok((entries, truncated))
}

fn build_globset(pattern: &str) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    builder.add(Glob::new(pattern).map_err(|error| format!("bad glob: {error}"))?);
    builder
        .build()
        .map_err(|error| format!("globset build: {error}"))
}

fn remote_absolute(root: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        join_remote(root, path)
    }
}

fn remote_relative(root: &str, path: &str) -> String {
    let root = root.trim_end_matches('/');
    if path == root {
        return String::new();
    }
    path.strip_prefix(root)
        .and_then(|relative| relative.strip_prefix('/'))
        .unwrap_or(path)
        .to_string()
}

/// 执行一次封闭树枚举任务，并把固定协议转换为公共 walker 结果。
async fn walk_bash(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    show_hidden: bool,
    max_depth: usize,
    max_entries: usize,
    cancellation: Option<&CancellationToken>,
) -> Result<(Vec<RemoteWalkEntry>, bool), TreeTaskError> {
    super::session::validate_remote_path(root).map_err(TreeTaskError::Business)?;
    let output = tasks::tree_list::run(workspace, root, show_hidden, max_depth, cancellation)
        .await
        .map_err(TreeTaskError::Transport)?;
    if output.timed_out {
        return Err(TreeTaskError::Transport(
            "remote tree listing timed out".into(),
        ));
    }
    match output.exit_code {
        Some(0) => parse_tree_list(&output.stdout, max_entries, output.truncated)
            .map_err(TreeTaskError::Protocol),
        Some(72) => Err(TreeTaskError::Unavailable(
            "missing GNU find or readlink".into(),
        )),
        Some(73) => Err(TreeTaskError::Business(format!(
            "not a remote directory: {root}"
        ))),
        Some(code) => Err(TreeTaskError::Business(format!(
            "remote tree listing failed with exit code {code}"
        ))),
        None => Err(TreeTaskError::Transport(
            "remote tree listing closed without an exit status".into(),
        )),
    }
}

fn parse_tree_list(
    bytes: &[u8],
    max_entries: usize,
    output_truncated: bool,
) -> Result<(Vec<RemoteWalkEntry>, bool), String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(TREE_LIST_MARKER) {
        return Err("remote tree listing marker is invalid".into());
    }
    let root = decode_field(fields.next(), "root")?.trim_end_matches('/');
    let root = if root.is_empty() { "/" } else { root };
    let mut entries = Vec::new();
    let mut truncated = output_truncated;
    loop {
        let Some(kind) = fields.next() else {
            if output_truncated {
                break;
            }
            return Err("remote tree listing is missing its terminator".into());
        };
        if kind == b"END" {
            break;
        }
        let Some(size_field) = fields.next() else {
            if output_truncated {
                break;
            }
            return Err("remote tree listing size is missing".into());
        };
        let size = decode_field(Some(size_field), "size")?
            .parse::<u64>()
            .map_err(|_| "remote tree listing size is invalid".to_string())?;
        let Some(rel_field) = fields.next() else {
            if output_truncated {
                break;
            }
            return Err("remote tree listing relative path is missing".into());
        };
        let rel = decode_field(Some(rel_field), "relative path")?.to_string();
        if rel.is_empty() {
            continue;
        }
        let entry_kind = match kind {
            b"f" => RemoteEntryKind::File,
            b"d" => RemoteEntryKind::Dir,
            b"l" => RemoteEntryKind::Symlink,
            _ => continue,
        };
        if entries.len() >= max_entries {
            truncated = true;
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        entries.push(RemoteWalkEntry {
            path: join_remote(root, &rel),
            rel,
            name,
            kind: entry_kind,
            size,
        });
    }
    Ok((entries, truncated))
}

fn decode_field<'a>(field: Option<&'a [u8]>, name: &str) -> Result<&'a str, String> {
    std::str::from_utf8(field.unwrap_or_default())
        .map_err(|_| format!("remote tree listing {name} is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::{parse_rg_files, parse_tree_list};
    use crate::modules::remote::sftp::RemoteEntryKind;

    #[test]
    fn parses_tree_protocol_and_applies_cap() {
        let bytes = b"TERAX_TREE_LIST_V1\0/srv/repo\0d\x000\0src\0f\x0012\0src/main.rs\0END\0";
        let (entries, truncated) = parse_tree_list(bytes, 1, false).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, RemoteEntryKind::Dir);
        assert_eq!(entries[0].path, "/srv/repo/src");
        assert!(truncated);
    }

    #[test]
    fn truncated_protocol_returns_complete_records() {
        let bytes = b"TERAX_TREE_LIST_V1\0/srv/repo\0f\x001\0a.txt\0f";
        let (entries, truncated) = parse_tree_list(bytes, 10, true).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(truncated);
    }

    #[test]
    fn parses_ripgrep_files_into_shared_entries() {
        let (entries, truncated) = parse_rg_files(
            b"/srv/repo/src/main.rs\0docs/readme.md\0",
            "/srv/repo",
            10,
            false,
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].rel, "src/main.rs");
        assert_eq!(entries[1].path, "/srv/repo/docs/readme.md");
        assert!(!truncated);
    }
}
