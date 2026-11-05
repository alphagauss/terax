//! Git 仓库操作与安全边界实现。
//!
//! 所有路径先经过工作区授权和仓库内校验，再交给本地、WSL 或 SSH Git 进程。

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::errors::{GitError, Result};
use crate::parser::parse_porcelain_v2;
use crate::process::{
    ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt, git_stdout_lines,
    read_text_file, run_git, run_git_index_mutation,
};
use crate::types::{
    DiscardEntry, GitBranchEntry, GitBranchListResult, GitCommitFileChange, GitCommitResult,
    GitDiffContentResult, GitDiffResult, GitDiffSide, GitFileHistoryEntry, GitFileLineStats,
    GitLineStats, GitLogEntry, GitLogRef, GitLogRefKind, GitOutput, GitPanelDiffStats,
    GitPanelSnapshot, GitPushResult, GitQuickDiffBaseline, GitRepoInfo, GitStatusSnapshot,
    TextSource, DEFAULT_TIMEOUT_SECS, MAX_FILE_BYTES,
};
use crate::utils::{
    authorized_repo_root, batch_repo_root, canonical_dir, is_safe_pathspec, resolve_within_repo,
    split_upstream, ResolvedGitDirectory,
};
use terax_core::modules::remote::git_service::{GitRemoteAction, HISTORY_FORMAT as LOG_FORMAT};
use terax_core::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

const DIFF_VIEW_TEXT_LIMIT: usize = 256 * 1024;

/// 返回所有可见引用、当前分支及 upstream 的轻量摘要，不扫描工作树或提交历史。
pub fn graph_revision(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<String> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["show-ref", "--head", "--dereference"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    // show-ref 不区分指向同一提交的当前分支，也不记录当前选择的 upstream。
    // rev-parse 在没有 upstream 时会非零退出，但仍先输出 HEAD，因此这里只取 stdout。
    let symbolic = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["rev-parse", "--symbolic-full-name", "HEAD", "@{upstream}"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    graph_revision_from_outputs(&output, &symbolic)
}

pub(super) fn graph_revision_from_outputs(
    output: &GitOutput,
    symbolic: &GitOutput,
) -> Result<String> {
    if output.timed_out || symbolic.timed_out {
        return Err(GitError::TimedOut("Git references"));
    }
    if output.truncated || symbolic.truncated {
        return Err(GitError::command("Git references", "output truncated"));
    }
    // 空仓库没有引用，show-ref 以 1 退出；空摘要仍是有效 revision。
    if output.exit_code != Some(0) && !(output.exit_code == Some(1) && output.stdout.is_empty()) {
        ensure_success(output, "git show-ref failed")?;
    }
    let mut hasher = Sha256::new();
    hasher.update(&output.stdout);
    hasher.update([0]);
    hasher.update(&symbolic.stdout);
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn resolve_repo(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<GitRepoInfo>> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !cwd.remote && !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    resolve_repo_in_authorized(registry, &cwd)
}

fn resolve_repo_in_authorized(
    registry: &WorkspaceRegistry,
    cwd: &ResolvedGitDirectory,
) -> Result<Option<GitRepoInfo>> {
    let Some(canonical_root) = resolve_repo_root_in_authorized(registry, cwd)? else {
        return Ok(None);
    };

    let head = match git_stdout_lines(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .into_iter()
    .next()
    {
        Some(h) => h,
        None => git_stdout_line_opt(
            &canonical_root.workspace,
            &canonical_root.git_path,
            ["symbolic-ref", "--short", "HEAD"],
        )?
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve HEAD",
            detail: String::new(),
        })?,
    };

    let upstream = git_stdout_line_opt(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;

    Ok(Some(GitRepoInfo {
        repo_root: canonical_root.git_path,
        branch: head.clone(),
        upstream,
        is_detached: head == "HEAD",
    }))
}

/// 解析并授权仓库根目录，不读取分支或 upstream。
fn resolve_repo_root_in_authorized(
    registry: &WorkspaceRegistry,
    cwd: &ResolvedGitDirectory,
) -> Result<Option<ResolvedGitDirectory>> {
    let Some(root_line) = git_stdout_line_opt(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--show-toplevel"],
    )?
    else {
        return Ok(None);
    };
    let canonical_root = canonical_dir(registry, &root_line, &cwd.workspace)?;
    if !canonical_root.remote {
        let _ = registry.authorize(&canonical_root.local_path);
    }
    Ok(Some(canonical_root))
}

pub fn panel_snapshot(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
    include_graph: bool,
) -> Result<GitPanelSnapshot> {
    if workspace.is_ssh() {
        ensure_git_available(workspace)?;
        return crate::batch::snapshot(cwd, workspace, include_graph);
    }
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !cwd.remote && !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    if workspace.is_wsl() {
        let snapshot = crate::batch::snapshot(&cwd.git_path, workspace, include_graph)?;
        if let Some(repo) = &snapshot.repo {
            let root = canonical_dir(registry, &repo.repo_root, workspace)?;
            let _ = registry.authorize(&root.local_path);
        }
        return Ok(snapshot);
    }
    let Some(canonical_root) = resolve_repo_root_in_authorized(registry, &cwd)? else {
        return Ok(GitPanelSnapshot {
            graph_revision: None,
            repo: None,
            status: None,
        });
    };
    let status = status_inner(&canonical_root)?;
    let graph_revision = include_graph.then(|| {
        graph_revision(registry, &canonical_root.git_path, workspace)
            .unwrap_or_else(|_| "unavailable".into())
    });
    Ok(crate::batch::snapshot_from_status(status, graph_revision))
}

/// 按需读取整批行数统计，与轻量状态快照分离，避免列表等待全文比较。
pub fn panel_diff_stats(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    status: &GitStatusSnapshot,
) -> Result<GitPanelDiffStats> {
    if status.repo_root != repo_root {
        return Err(GitError::InvalidPath(repo_root.into()));
    }
    if workspace.is_ssh() {
        return crate::batch::statistics(repo_root, status, workspace);
    }
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if workspace.is_wsl() {
        return crate::batch::statistics(&repo_root.git_path, status, workspace);
    }
    Ok(GitPanelDiffStats {
        worktree: panel_line_stats(&repo_root, status, false).ok(),
        index: panel_line_stats(&repo_root, status, true).ok(),
    })
}

/// 每侧只读取紧凑统计；未跟踪文本按新增计入，不改动真实索引。
fn panel_line_stats(
    repo_root: &ResolvedGitDirectory,
    status: &GitStatusSnapshot,
    staged: bool,
) -> Result<GitLineStats> {
    let mut args = vec![
        "diff",
        "--numstat",
        "-z",
        "--find-renames=50%",
        "--no-ext-diff",
        "--no-textconv",
    ];
    if staged {
        args.push("--cached");
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff statistics failed")?;
    // 截断输出不能当作完整统计，避免展示误导性的精确数字。
    if output.truncated {
        return Err(GitError::command("git diff statistics", "output truncated"));
    }
    let mut stats = sum_numstat(&output.stdout)?;
    mark_incomplete_stats(&mut stats, status, staged);
    if !staged {
        for file in status.changed_files.iter().filter(|file| file.untracked) {
            let value = stats.files.entry(file.path.clone()).or_default();
            if !is_safe_pathspec(&file.path) {
                stats.incomplete = true;
                value.incomplete = true;
                continue;
            }
            // 校验路径不越界，同时保留末级符号链接供读取器拒绝跟随。
            let local_path = repo_root.local_path.join(&file.path);
            if !repo_root.remote && resolve_within_repo(&repo_root.local_path, &file.path).is_err()
            {
                stats.incomplete = true;
                value.incomplete = true;
                continue;
            }
            match read_worktree_text(repo_root, &file.path, &local_path) {
                Ok(TextSource::Text(text)) => {
                    value.added = text.bytes().filter(|byte| *byte == b'\n').count() as u64
                        + u64::from(!text.is_empty() && !text.ends_with('\n'));
                    stats.added += value.added;
                }
                Ok(TextSource::Binary) => value.is_binary = true,
                Ok(TextSource::Missing) | Err(_) => {
                    value.incomplete = true;
                    stats.incomplete = true;
                }
            }
        }
    }
    Ok(stats)
}

pub(super) fn mark_incomplete_stats(
    stats: &mut GitLineStats,
    status: &GitStatusSnapshot,
    staged: bool,
) {
    stats.incomplete = status.truncated;
    for file in &status.changed_files {
        if !(if staged { file.staged } else { file.unstaged }) {
            continue;
        }
        // 未合并索引没有可靠的普通比较基线，不展示看似精确的单文件数字。
        if matches!(
            (file.index_status.as_str(), file.worktree_status.as_str()),
            ("U", _) | (_, "U") | ("A", "A") | ("D", "D")
        ) {
            stats.files.entry(file.path.clone()).or_default().incomplete = true;
            stats.incomplete = true;
        }
    }
}

/// 按 NUL 边界读取文件路径，重命名使用目标路径，制表符和换行不参与统计解析。
pub(super) fn sum_numstat(bytes: &[u8]) -> Result<GitLineStats> {
    let invalid = || GitError::command("git diff statistics", "invalid numstat output");
    let mut stats = GitLineStats::default();
    let mut records = bytes.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let added = columns.next().ok_or_else(invalid)?;
        let removed = columns.next().ok_or_else(invalid)?;
        let mut path = columns.next().ok_or_else(invalid)?;
        if path.is_empty() {
            records
                .next()
                .filter(|path| !path.is_empty())
                .ok_or_else(invalid)?;
            path = records
                .next()
                .filter(|path| !path.is_empty())
                .ok_or_else(invalid)?;
        }
        let path = String::from_utf8_lossy(path).into_owned();
        if added == b"-" && removed == b"-" {
            stats.files.insert(
                path,
                GitFileLineStats {
                    is_binary: true,
                    ..Default::default()
                },
            );
            continue;
        }
        let number = |raw| {
            std::str::from_utf8(raw)
                .ok()
                .and_then(|text| text.parse::<u64>().ok())
                .ok_or_else(invalid)
        };
        let added = number(added)?;
        let removed = number(removed)?;
        stats.added = stats.added.checked_add(added).ok_or_else(invalid)?;
        stats.removed = stats.removed.checked_add(removed).ok_or_else(invalid)?;
        let value = stats.files.entry(path).or_default();
        value.added = value.added.checked_add(added).ok_or_else(invalid)?;
        value.removed = value.removed.checked_add(removed).ok_or_else(invalid)?;
    }
    Ok(stats)
}

pub fn status(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitStatusSnapshot> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    status_inner(&repo_root)
}

fn status_inner(repo_root: &ResolvedGitDirectory) -> Result<GitStatusSnapshot> {
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "status",
            "--porcelain=v2",
            // 与面板 numstat 保持相同的重命名身份，避免仓库配置导致文件统计错配。
            "--find-renames=50%",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;

    Ok(status_from_output(&repo_root.git_path, &output))
}

pub(super) fn status_from_output(repo_root: &str, output: &GitOutput) -> GitStatusSnapshot {
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let parsed = parse_porcelain_v2(stdout);

    GitStatusSnapshot {
        repo_root: repo_root.to_string(),
        branch: parsed.branch,
        head_sha: parsed.head_sha,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        is_detached: parsed.is_detached,
        truncated: output.truncated,
        changed_files: parsed.files,
    }
}

/// 读取工作区或暂存区的 unified diff。
pub fn diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: Option<&str>,
    side: GitDiffSide,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    diff_inner(
        &repo_root,
        path,
        match side {
            GitDiffSide::Worktree => DiffMode::Worktree,
            GitDiffSide::Index => DiffMode::Index,
        },
    )
}

/// 读取文件在当前 HEAD 中的文本基线。
///
/// 被 Git 忽略的文件不提供基线；HEAD 中尚不存在的其他文本文件返回空基线。
pub fn quick_diff_baseline(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitQuickDiffBaseline> {
    let (parent, file_name) = split_file_path(path)?;
    let cwd = canonical_dir(registry, parent, workspace)?;
    if !cwd.remote && !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    let Some(repo_root) = resolve_repo_root_in_authorized(registry, &cwd)? else {
        return Ok(GitQuickDiffBaseline::Unsupported);
    };
    let revision = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--verify", "HEAD"],
    )?;
    let file_path = format!(
        "{}/{}",
        cwd.git_path.trim_end_matches(['/', '\\']),
        file_name
    );
    let relative_path = relative_git_path(&repo_root.git_path, &file_path, repo_root.remote)?;
    let relative_path =
        pathspec_from_input(&repo_root.local_path, &relative_path, repo_root.remote)?;
    // 保留 Git 默认的索引检查，匹配忽略规则但已跟踪的文件仍需显示变更。
    let ignored = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["check-ignore", "-q", "--", &relative_path],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if ignored.timed_out || ignored.exit_code != Some(1) {
        ensure_success(&ignored, "git check-ignore failed")?;
        return Ok(GitQuickDiffBaseline::Ignored);
    }
    // 后续始终读取已解析出的 SHA，避免 HEAD 在多条 Git 命令之间移动后返回错配内容。
    let content = if let Some(head_sha) = revision.as_deref() {
        let object = format!("{head_sha}:{relative_path}");
        let size = git_stdout_line_opt(
            &repo_root.workspace,
            &repo_root.git_path,
            ["cat-file", "-s", &object],
        )?
        .and_then(|value| value.parse::<u64>().ok());
        match size {
            Some(size) if size > MAX_FILE_BYTES => {
                return Ok(GitQuickDiffBaseline::Unsupported);
            }
            Some(_) => match git_show_text(&repo_root.workspace, &repo_root.git_path, &object)? {
                TextSource::Text(content) => Some(content),
                TextSource::Missing => new_file_baseline(&repo_root, &relative_path)?,
                TextSource::Binary => None,
            },
            None => new_file_baseline(&repo_root, &relative_path)?,
        }
    } else {
        new_file_baseline(&repo_root, &relative_path)?
    };
    let Some(content) = content else {
        return Ok(GitQuickDiffBaseline::Unsupported);
    };
    Ok(GitQuickDiffBaseline::Text {
        repo_root: repo_root.git_path,
        relative_path,
        head_sha: revision,
        content,
    })
}

/// 验证 HEAD 中不存在的工作区文件仍是有界文本，再为其提供空基线。
fn new_file_baseline(
    repo_root: &ResolvedGitDirectory,
    relative_path: &str,
) -> Result<Option<String>> {
    let worktree_path = repo_root.local_path.join(relative_path);
    match read_worktree_text(repo_root, relative_path, &worktree_path) {
        Ok(TextSource::Text(_)) => Ok(Some(String::new())),
        Ok(TextSource::Missing | TextSource::Binary)
        | Err(GitError::FileTooLarge { .. } | GitError::SymlinkRejected(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Clone, Copy)]
enum DiffMode {
    Worktree,
    Index,
}

fn diff_inner(
    repo_root: &ResolvedGitDirectory,
    path: Option<&str>,
    mode: DiffMode,
) -> Result<GitDiffResult> {
    let mut args: Vec<OsString> = vec!["diff".into(), "--no-ext-diff".into()];
    match mode {
        DiffMode::Worktree => {}
        DiffMode::Index => args.push("--cached".into()),
    }
    let pathspec = match path.filter(|p| !p.is_empty()) {
        Some(p) => Some(pathspec_from_input(
            &repo_root.local_path,
            p,
            repo_root.remote,
        )?),
        None => None,
    };
    if let Some(spec) = pathspec.as_ref() {
        args.push("--".into());
        args.push(spec.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff failed")?;

    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

/// 读取工作区或暂存区的两侧文件内容，供只读差异页面渲染。
pub fn diff_content(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    side: GitDiffSide,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let rel_path = pathspec_from_input(&repo_root.local_path, path, repo_root.remote)?;
    let worktree_path = repo_root.local_path.join(&rel_path);

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => Some(pathspec_from_input(
            &repo_root.local_path,
            orig,
            repo_root.remote,
        )?),
        _ => None,
    };

    let original = if matches!(side, GitDiffSide::Index) {
        let spec = original_rel.as_deref().unwrap_or(&rel_path);
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("HEAD:{spec}"),
        )?
    } else {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    };
    let modified = if matches!(side, GitDiffSide::Index) {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    } else {
        read_worktree_text(&repo_root, &rel_path, &worktree_path)?
    };
    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);
    let needs_patch = is_binary
        || text_source_len(&original) > DIFF_VIEW_TEXT_LIMIT
        || text_source_len(&modified) > DIFF_VIEW_TEXT_LIMIT;
    let patch = if needs_patch {
        Some(diff_inner(
            &repo_root,
            Some(&rel_path),
            match side {
                GitDiffSide::Worktree => DiffMode::Worktree,
                GitDiffSide::Index => DiffMode::Index,
            },
        )?)
    } else {
        None
    };

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch
            .as_ref()
            .map(|result| result.diff_text.clone())
            .unwrap_or_default(),
        truncated: patch.is_some_and(|result| result.truncated),
    })
}

pub fn stage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths, repo_root.remote)?;
    for batch in path_batches(&resolved) {
        let output = run_git_index_mutation(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["add", "--"]
                .into_iter()
                .chain(batch.iter().map(String::as_str)),
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git add failed")?;
    }
    Ok(())
}

pub fn unstage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths, repo_root.remote)?;
    for batch in path_batches(&resolved) {
        let output = run_git_index_mutation(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["reset", "HEAD", "--"]
                .into_iter()
                .chain(batch.iter().map(String::as_str)),
            DEFAULT_TIMEOUT_SECS,
        )?;
        if output.exit_code == Some(0) {
            continue;
        }
        if output.timed_out || !looks_like_no_head(&output) {
            return ensure_success(&output, "git reset failed");
        }
        let output = run_git_index_mutation(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["rm", "--cached", "-r", "--"]
                .into_iter()
                .chain(batch.iter().map(String::as_str)),
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git rm --cached failed")?;
    }
    Ok(())
}

fn looks_like_no_head(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("ambiguous argument 'head'")
        || stderr.contains("unknown revision")
        || stderr.contains("does not have any commits yet")
        || stderr.contains("bad revision 'head'")
}

pub fn discard(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    entries: &[DiscardEntry],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if entries.is_empty() {
        return Ok(());
    }

    let mut tracked: Vec<String> = Vec::with_capacity(entries.len());
    let mut untracked: Vec<String> = Vec::new();
    for entry in entries {
        let resolved = pathspec_from_input(&repo_root.local_path, &entry.path, repo_root.remote)?;
        if entry.untracked {
            untracked.push(resolved);
        } else {
            tracked.push(resolved);
        }
    }

    for batch in path_batches(&tracked) {
        let output = run_git_index_mutation(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["restore", "--worktree", "--"]
                .into_iter()
                .chain(batch.iter().map(String::as_str)),
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git restore failed")?;
    }

    for batch in path_batches(&untracked) {
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["clean", "-f", "-d", "--"]
                .into_iter()
                .chain(batch.iter().map(String::as_str)),
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git clean failed")?;
    }

    Ok(())
}

pub fn commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    message: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitCommitResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyCommitMessage);
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [OsStr::new("commit"), OsStr::new("-m"), OsStr::new(trimmed)],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code != Some(0) && nothing_to_commit(&output) {
        return Err(GitError::command("git commit", "nothing staged"));
    }
    ensure_success(&output, "git commit failed")?;

    let combined = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["show", "-s", "--format=%H%n%s", "HEAD"],
    )?;
    let sha = combined.first().cloned().ok_or(GitError::CommandFailed {
        context: "failed to resolve commit sha",
        detail: String::new(),
    })?;
    let summary = combined.get(1).cloned().unwrap_or_default();

    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

pub fn undo_commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    expected_head: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !full_sha_is_safe(expected_head) {
        return Err(GitError::command(
            "git update-ref",
            "invalid expected HEAD sha",
        ));
    }

    let parent_spec = format!("{expected_head}^");
    let parent = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--verify", parent_spec.as_str()],
    )?
    .ok_or_else(|| GitError::command("git update-ref", "the root commit cannot be undone"))?;

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            OsStr::new("update-ref"),
            OsStr::new("HEAD"),
            OsStr::new(&parent),
            OsStr::new(expected_head),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code != Some(0) {
        if let Ok(Some(current_head)) = git_stdout_line_opt(
            &repo_root.workspace,
            &repo_root.git_path,
            ["rev-parse", "--verify", "HEAD"],
        ) {
            if current_head != expected_head {
                return Err(GitError::command(
                    "git update-ref",
                    "HEAD changed; refresh the graph and try again",
                ));
            }
        }
    }
    ensure_success(&output, "git update-ref failed")
}

pub fn push(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    operation_id: Option<&str>,
) -> Result<GitPushResult> {
    let upstream = crate::network::execute(
        registry,
        repo_root,
        workspace,
        GitRemoteAction::Push,
        operation_id,
    )?
    .ok_or(GitError::NoUpstream)?;
    let (remote, branch) = split_upstream(&upstream);
    Ok(GitPushResult {
        remote,
        branch,
        pushed: true,
    })
}

const MAX_LOG_LIMIT: u32 = 200;

pub fn log(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    limit: u32,
    skip: u32,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = batch_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let bounded = limit.clamp(1, MAX_LOG_LIMIT);
    let crate::batch::HistoryRead {
        remote_names,
        current_branch,
        upstream_label,
        output,
    } = crate::batch::history(&repo_root.git_path, workspace, bounded, skip)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git log"));
    }
    if output.exit_code != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("does not have any commits yet")
            || stderr.contains("bad default revision")
            || stderr.contains("unknown revision")
            || stderr.contains("ambiguous argument 'head'")
        {
            return Ok(Vec::new());
        }
        return ensure_success(&output, "git log failed").map(|_| Vec::new());
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let mut entries: Vec<GitLogEntry> = Vec::with_capacity(bounded as usize);
    for line in stdout.lines() {
        if let Some(entry) = parse_log_header(line.trim_end_matches('\r'), |refs| {
            parse_log_refs(
                refs,
                &remote_names,
                current_branch.as_deref(),
                upstream_label.as_deref(),
            )
        }) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// 仓库日志与文件时间线共用提交头解析，文件路径独立使用 NUL 分隔。
fn parse_log_header(line: &str, refs: impl FnOnce(&str) -> Vec<GitLogRef>) -> Option<GitLogEntry> {
    let mut fields = line.splitn(7, '\x1f');
    let sha = fields.next()?;
    if !sha_is_safe(sha) {
        return None;
    }
    Some(GitLogEntry {
        sha: sha.to_string(),
        short_sha: sha.chars().take(7).collect(),
        author: fields.next()?.to_string(),
        author_email: fields.next()?.to_string(),
        timestamp_secs: fields.next()?.parse().unwrap_or(0),
        parents: fields
            .next()?
            .split_ascii_whitespace()
            .map(str::to_string)
            .collect(),
        refs: refs(fields.next()?),
        subject: fields.next()?.to_string(),
    })
}

/// 从固定提交分页追溯单文件历史，并返回重命名前后真实路径。
pub fn file_history(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    head_sha: &str,
    limit: u32,
    skip: u32,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitFileHistoryEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !full_sha_is_safe(head_sha) {
        return Err(GitError::command("git log", "invalid commit sha"));
    }
    // 与 Quick Diff 一样先规范父目录，兼容工作根通过符号链接进入仓库的情况。
    let (parent, name) = split_file_path(path)?;
    let directory = canonical_dir(registry, parent, workspace)?;
    let absolute = format!("{}/{}", directory.git_path.trim_end_matches('/'), name);
    let relative = relative_git_path(&repo_root.git_path, &absolute, repo_root.remote)?;
    let relative = pathspec_from_input(&repo_root.local_path, &relative, repo_root.remote)?;
    // --follow 与 --skip 混用会跳过重命名追踪；从固定起点读取有限前缀后截取本页。
    let limit = limit.clamp(1, MAX_LOG_LIMIT);
    let count = format!("--max-count={}", skip.saturating_add(limit));
    let format = format!("--format=%x1e{LOG_FORMAT}");
    let literal_path = format!(":(literal){relative}");
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "log",
            "--no-color",
            "--no-ext-diff",
            "--follow",
            "--find-renames=50%",
            "--diff-merges=first-parent",
            "--name-status",
            "-z",
            &count,
            &format,
            head_sha,
            "--",
            &literal_path,
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git log failed")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut tokens = stdout.split('\0').filter(|token| !token.is_empty());
    let mut commit = None;
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        if let Some(header) = token.strip_prefix('\x1e') {
            commit = parse_log_header(header, |_| Vec::new());
            continue;
        }
        let status = token.trim_start_matches('\n');
        let Some(path) = tokens.next() else {
            break;
        };
        let (path, original_path) = if status.starts_with(['R', 'C']) {
            let Some(next) = tokens.next() else {
                break;
            };
            (next, Some(path.to_string()))
        } else {
            (path, None)
        };
        if let Some(commit) = commit.take() {
            entries.push(GitFileHistoryEntry {
                commit,
                path: path.to_string(),
                original_path,
            });
        }
    }
    Ok(entries
        .into_iter()
        .skip(skip as usize)
        .take(limit as usize)
        .collect())
}

/// 将提交装饰转换为稳定类别；已检出分支只保留当前分支、upstream 与标签。
fn parse_log_refs(
    decorations: &str,
    remote_names: &HashSet<String>,
    current_branch: Option<&str>,
    upstream: Option<&str>,
) -> Vec<GitLogRef> {
    decorations
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter_map(|value| {
            if let Some(label) = value.strip_prefix("HEAD -> ") {
                return Some(GitLogRef {
                    label: label.to_string(),
                    kind: GitLogRefKind::Local,
                });
            }
            if let Some(label) = value.strip_prefix("tag: ") {
                return Some(GitLogRef {
                    label: label.to_string(),
                    kind: GitLogRefKind::Tag,
                });
            }

            let source = value.split_once(" -> ").map_or(value, |(source, _)| source);
            let remote_name = source.split_once('/').map(|(name, _)| name);
            if remote_name.is_some_and(|name| remote_names.contains(name))
                && source.ends_with("/HEAD")
            {
                return None;
            }
            let kind = if remote_name.is_some_and(|name| remote_names.contains(name)) {
                GitLogRefKind::Remote
            } else {
                GitLogRefKind::Local
            };
            if current_branch.is_some()
                && match &kind {
                    GitLogRefKind::Remote => Some(source) != upstream,
                    GitLogRefKind::Local => {
                        Some(source) != current_branch && Some(source) != upstream
                    }
                    GitLogRefKind::Tag => false,
                }
            {
                return None;
            }
            Some(GitLogRef {
                label: source.to_string(),
                kind,
            })
        })
        .collect()
}

pub fn show_commit_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit identifier"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            OsStr::new("show"),
            OsStr::new("--no-color"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--patch-with-stat"),
            OsStr::new(sha),
            OsStr::new("--"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git show failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn commit_message(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<String> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit sha"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            OsStr::new("show"),
            OsStr::new("-s"),
            OsStr::new("--format=%B"),
            OsStr::new(sha),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git show failed")?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn sha_is_safe(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

fn full_sha_is_safe(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn commit_files(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitCommitFileChange>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git diff-tree", "invalid commit sha"));
    }

    let parent_spec = format!("{sha}^");
    let first_parent = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--verify", parent_spec.as_str()],
    )?;
    let name_status_output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        commit_diff_tree_args("--name-status", sha, first_parent.as_deref()),
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&name_status_output, "git diff-tree failed")?;
    let numstat_output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        commit_diff_tree_args("--numstat", sha, first_parent.as_deref()),
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&numstat_output, "git diff-tree failed")?;

    let mut files = parse_diff_tree_name_status(&name_status_output.stdout);
    apply_numstat(&mut files, &numstat_output.stdout);
    Ok(files)
}

/// 构造提交文件列表与统计共用的 diff-tree 参数，保证二者以相同规则识别重命名。
fn commit_diff_tree_args(format: &str, sha: &str, parent: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "diff-tree".into(),
        "--no-commit-id".into(),
        "-r".into(),
        "-z".into(),
        "--find-renames=50%".into(),
        format.into(),
    ];
    if let Some(parent) = parent {
        args.push(parent.into());
    } else {
        args.push("--root".into());
    }
    args.push(sha.into());
    args
}

pub fn commit_file_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    path: &str,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit sha"));
    }
    let rel = pathspec_from_input(&repo_root.local_path, path, repo_root.remote)?;

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => {
            pathspec_from_input(&repo_root.local_path, orig, repo_root.remote)?
        }
        _ => rel.clone(),
    };

    let parent = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", &format!("{sha}^")],
    )?;
    let original = match parent.as_deref() {
        Some(p) => git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("{p}:{original_rel}"),
        )?,
        None => TextSource::Missing,
    };
    let modified = git_show_text(
        &repo_root.workspace,
        &repo_root.git_path,
        &format!("{sha}:{rel}"),
    )?;

    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);
    let needs_patch = is_binary
        || text_source_len(&original) > DIFF_VIEW_TEXT_LIMIT
        || text_source_len(&modified) > DIFF_VIEW_TEXT_LIMIT;
    let mut patch_text = String::new();
    let mut truncated = false;
    if needs_patch {
        let mut diff_args: Vec<OsString> = vec![
            "show".into(),
            "--no-color".into(),
            "--no-ext-diff".into(),
            "--format=".into(),
            "-m".into(),
            "--first-parent".into(),
            sha.into(),
            "--".into(),
        ];
        diff_args.push(rel.clone().into());
        if original_rel != rel {
            diff_args.push(original_rel.clone().into());
        }
        let patch_output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            diff_args,
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&patch_output, "git show <commit> -- <path> failed")?;
        truncated = patch_output.truncated;
        patch_text = match String::from_utf8(patch_output.stdout) {
            Ok(text) => text,
            Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
        };
    }

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch_text,
        truncated,
    })
}

pub fn remote_url(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<String>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if name.is_empty() || name.len() > 64 || !name.chars().all(is_remote_name_char) {
        return Ok(None);
    }
    git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "--get", &format!("remote.{name}.url")],
    )
}

fn is_remote_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

fn parse_diff_tree_name_status(bytes: &[u8]) -> Vec<GitCommitFileChange> {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let mut tokens = s.split('\0').filter(|t| !t.is_empty());
    let mut files: Vec<GitCommitFileChange> = Vec::new();
    while let Some(status_tok) = tokens.next() {
        let status_char = status_tok.chars().next().unwrap_or(' ');
        if status_char == 'R' || status_char == 'C' {
            let original = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            let new_path = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            files.push(GitCommitFileChange {
                path: new_path,
                original_path: Some(original),
                status: status_char.to_string(),
                status_label: status_label_for(status_char),
                added: 0,
                removed: 0,
                is_binary: false,
            });
        } else {
            let path = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            files.push(GitCommitFileChange {
                path,
                original_path: None,
                status: status_char.to_string(),
                status_label: status_label_for(status_char),
                added: 0,
                removed: 0,
                is_binary: false,
            });
        }
    }
    files
}

fn apply_numstat(files: &mut [GitCommitFileChange], bytes: &[u8]) {
    let file_indexes: HashMap<String, usize> = files
        .iter()
        .enumerate()
        .map(|(index, file)| (file.path.clone(), index))
        .collect();
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let tokens: Vec<&str> = s.split('\0').filter(|t| !t.is_empty()).collect();
    let mut idx = 0;
    while idx < tokens.len() {
        let header = tokens[idx];
        idx += 1;
        let mut cols = header.splitn(3, '\t');
        let added_raw = cols.next().unwrap_or("0");
        let removed_raw = cols.next().unwrap_or("0");
        let inline_path = cols.next().unwrap_or("");
        let is_binary = added_raw == "-" && removed_raw == "-";
        let added: u32 = if is_binary {
            0
        } else {
            added_raw.parse().unwrap_or(0)
        };
        let removed: u32 = if is_binary {
            0
        } else {
            removed_raw.parse().unwrap_or(0)
        };

        let (path, original) = if inline_path.is_empty() {
            let original = tokens.get(idx).map(|s| s.to_string()).unwrap_or_default();
            idx += 1;
            let new_path = tokens.get(idx).map(|s| s.to_string()).unwrap_or_default();
            idx += 1;
            (new_path, Some(original))
        } else {
            (inline_path.to_string(), None)
        };

        if path.is_empty() {
            continue;
        }
        if let Some(&file_index) = file_indexes.get(&path) {
            let file = &mut files[file_index];
            file.added = added;
            file.removed = removed;
            file.is_binary = is_binary;
            if file.original_path.is_none() {
                if let Some(orig) = original {
                    if !orig.is_empty() && orig != file.path {
                        file.original_path = Some(orig);
                    }
                }
            }
        }
    }
}

fn status_label_for(c: char) -> String {
    match c {
        'A' => "Added".into(),
        'M' => "Modified".into(),
        'D' => "Deleted".into(),
        'R' => "Renamed".into(),
        'C' => "Copied".into(),
        'T' => "Type changed".into(),
        'U' => "Unmerged".into(),
        _ => format!("Status {c}"),
    }
}

pub fn fetch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    operation_id: Option<&str>,
) -> Result<()> {
    crate::network::execute(
        registry,
        repo_root,
        workspace,
        GitRemoteAction::Fetch,
        operation_id,
    )
    .map(|_| ())
}

pub fn pull_ff_only(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    operation_id: Option<&str>,
) -> Result<()> {
    crate::network::execute(
        registry,
        repo_root,
        workspace,
        GitRemoteAction::Pull,
        operation_id,
    )
    .map(|_| ())
}

fn nothing_to_commit(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stderr.contains("nothing to commit") || stdout.contains("nothing to commit")
}

/// 按转义后的保守长度上界分批，为 Git 参数、本地或 WSL 启动参数预留空间。
/// 全部路径须在首批执行前完成校验，避免后续非法路径导致前半部分已被修改。
fn path_batches(mut paths: &[String]) -> impl Iterator<Item = &[String]> {
    const MAX_PATH_ARGS_LENGTH: usize = 24_000;

    std::iter::from_fn(move || {
        if paths.is_empty() {
            return None;
        }
        let mut length = 0;
        let mut count = 0;
        for path in paths {
            // UTF-8 字节数覆盖 UTF-16 长度，四倍预算同时覆盖 Windows 和 SSH Shell 转义。
            let cost = path.len() * 4 + 3;
            if count > 0 && length + cost > MAX_PATH_ARGS_LENGTH {
                break;
            }
            length += cost;
            count += 1;
        }
        let (batch, remaining) = paths.split_at(count);
        paths = remaining;
        Some(batch)
    })
}

fn resolve_pathspecs(repo_root: &Path, paths: &[String], remote: bool) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(pathspec_from_input(repo_root, p, remote)?);
    }
    Ok(out)
}

fn pathspec_from_input(repo_root: &Path, rel: &str, remote: bool) -> Result<String> {
    if remote {
        if !is_safe_pathspec(rel) || rel.starts_with(['/', '\\']) {
            return Err(GitError::InvalidPath(rel.into()));
        }
        return Ok(rel.replace('\\', "/"));
    }
    let resolved = resolve_within_repo(repo_root, rel)?;
    Ok(pathspec(repo_root, &resolved))
}

fn text_source_len(source: &TextSource) -> usize {
    match source {
        TextSource::Text(text) => text.len(),
        TextSource::Missing | TextSource::Binary => 0,
    }
}

/// 将文件路径拆为父目录与文件名，统一接受两种平台分隔符。
fn split_file_path(path: &str) -> Result<(&str, &str)> {
    let split = path
        .rfind(['/', '\\'])
        .ok_or_else(|| GitError::InvalidPath(path.into()))?;
    let (parent, name) = path.split_at(split);
    let name = &name[1..];
    if parent.is_empty() || name.is_empty() || name == "." || name == ".." {
        return Err(GitError::InvalidPath(path.into()));
    }
    Ok((parent, name))
}

/// 从规范仓库路径中提取安全的仓库相对路径。
fn relative_git_path(repo_root: &str, file_path: &str, remote: bool) -> Result<String> {
    let root = repo_root
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let file = file_path.replace('\\', "/");
    let prefix = format!("{root}/");
    let matches = if remote || !cfg!(windows) {
        file.starts_with(&prefix)
    } else {
        file.to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
    };
    if !matches {
        return Err(GitError::InvalidPath(file_path.into()));
    }
    let relative = &file[prefix.len()..];
    if !is_safe_pathspec(relative) {
        return Err(GitError::InvalidPath(relative.into()));
    }
    Ok(relative.to_string())
}

fn read_worktree_text(
    repo_root: &ResolvedGitDirectory,
    relative: &str,
    local_path: &Path,
) -> Result<TextSource> {
    let WorkspaceEnv::Ssh { profile_id } = &repo_root.workspace else {
        return read_text_file(local_path);
    };
    let manager =
        terax_core::modules::remote::manager::global_manager().map_err(GitError::Spawn)?;
    let profile_id = profile_id.clone();
    let path = terax_core::modules::remote::session::join_remote(&repo_root.git_path, relative);
    let symlink_path = Path::new(&path).to_path_buf();
    let bytes = terax_core::runtime::block_on(async move {
        let workspace = manager.workspace(&profile_id).await?;
        let stat = terax_core::modules::remote::sftp::stat(&workspace, &path).await?;
        if stat.kind == terax_core::modules::remote::sftp::RemoteEntryKind::Symlink {
            return Ok(None);
        }
        if stat.size > MAX_FILE_BYTES {
            return Err(format!("remote file is too large: {} bytes", stat.size));
        }
        terax_core::modules::remote::sftp::read_file(&workspace, &path, MAX_FILE_BYTES)
            .await
            .map(Some)
    })
    .map_err(GitError::Spawn)?;
    let Some(bytes) = bytes else {
        return Err(GitError::SymlinkRejected(symlink_path));
    };
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Ok(TextSource::Binary);
    }
    Ok(match String::from_utf8(bytes) {
        Ok(text) => TextSource::Text(text),
        Err(_) => TextSource::Binary,
    })
}

fn pathspec(repo_root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(repo_root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}

pub fn list_branches(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitBranchListResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let mut branches: Vec<GitBranchEntry> = Vec::new();
    let mut branch_timestamps: HashMap<String, i64> = HashMap::new();

    let current_branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .ok()
    .flatten();
    let is_detached_head = current_branch.as_deref() == Some("HEAD");

    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        [
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(committerdate:unix)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    ) {
        for line in &lines {
            let mut parts = line.split('\0');
            let refname = parts.next().unwrap_or("");
            let name = parts.next().unwrap_or("");
            let name = refname
                .strip_prefix("refs/heads/")
                .or_else(|| refname.strip_prefix("refs/remotes/"))
                .unwrap_or(name)
                .to_string();
            let timestamp_secs = parts.next().and_then(|value| value.parse::<i64>().ok());
            let head_marker = parts.next().unwrap_or("");
            let is_head = head_marker == "*";
            if refname.starts_with("refs/heads/") && !name.is_empty() {
                if let Some(timestamp_secs) = timestamp_secs {
                    branch_timestamps.insert(name.clone(), timestamp_secs);
                }
                branches.push(GitBranchEntry {
                    name,
                    kind: "local".into(),
                    worktree_path: None,
                    is_head,
                    is_detached: is_head && is_detached_head,
                    timestamp_secs,
                    tag_sources: Vec::new(),
                });
            } else if refname.starts_with("refs/remotes/")
                && !name.is_empty()
                && !refname.ends_with("/HEAD")
                && !refname.starts_with("refs/remotes/upstream/")
            {
                branches.push(GitBranchEntry {
                    name,
                    kind: "remote".into(),
                    worktree_path: None,
                    is_head: false,
                    is_detached: false,
                    timestamp_secs,
                    tag_sources: Vec::new(),
                });
            }
        }
    }

    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["worktree", "list", "--porcelain"],
    ) {
        let mut current_worktree: Option<String> = None;
        let mut worktree_branch: Option<String> = None;
        let mut worktree_bare = false;
        let mut head_sha: Option<String> = None;
        for line in &lines {
            if let Some(rest) = line.strip_prefix("worktree ") {
                if let Some(wt_path) = current_worktree.take() {
                    if !worktree_bare {
                        push_worktree(
                            &mut branches,
                            &branch_timestamps,
                            wt_path,
                            worktree_branch.take(),
                            head_sha.take(),
                        );
                    }
                }
                current_worktree = Some(rest.trim().to_string());
                worktree_branch = None;
                worktree_bare = false;
                head_sha = None;
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                head_sha = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let raw = rest.trim();
                worktree_branch = Some(raw.strip_prefix("refs/heads/").unwrap_or(raw).to_string());
            } else if line.starts_with("bare") {
                worktree_bare = true;
            }
        }
        if let Some(wt_path) = current_worktree.take() {
            if !worktree_bare {
                push_worktree(
                    &mut branches,
                    &branch_timestamps,
                    wt_path,
                    worktree_branch.take(),
                    head_sha.take(),
                );
            }
        }
    }

    // Prefer a branch's worktree entry over its local one, except for the current
    // branch: the main worktree is always listed, so !is_head keeps it local.
    let mut seen: HashMap<(bool, String), usize> = HashMap::new();
    let mut deduped: Vec<GitBranchEntry> = Vec::with_capacity(branches.len());
    for b in branches {
        // 本地分支与工作树共享名称，远程分支必须保留自己的命名空间。
        let key = (b.kind == "remote", b.name.clone());
        if let Some(&existing_idx) = seen.get(&key) {
            let existing = &deduped[existing_idx];
            let should_replace = b.kind == "worktree"
                && existing.kind == "local"
                && existing.worktree_path.is_none()
                && !existing.is_head;
            if should_replace {
                let is_head = existing.is_head || b.is_head;
                deduped[existing_idx] = GitBranchEntry { is_head, ..b };
            } else if b.is_head && !existing.is_head {
                let mut updated = deduped[existing_idx].clone();
                updated.is_head = true;
                deduped[existing_idx] = updated;
            }
        } else {
            seen.insert(key, deduped.len());
            deduped.push(b);
        }
    }

    // 标签独立于分支去重，仅保留本地分支和本地 origin 引用历史中可达的标签。
    let tags = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        [
            "for-each-ref",
            "--format=%(refname:strip=2)%00%(creatordate:unix)",
            "refs/tags",
        ],
    )?;
    let has_local_branches = deduped
        .iter()
        .any(|entry| entry.kind == "local" || (entry.kind == "worktree" && !entry.is_detached));
    let has_origin_branches = deduped
        .iter()
        .any(|entry| entry.kind == "remote" && entry.name.starts_with("origin/"));
    let local_tags = if !tags.is_empty() && has_local_branches {
        reachable_tag_names(&repo_root, "--branches")?
    } else {
        HashSet::new()
    };
    let origin_tags = if !tags.is_empty() && has_origin_branches {
        reachable_tag_names(&repo_root, "--remotes=origin")?
    } else {
        HashSet::new()
    };
    for line in tags {
        let mut parts = line.split('\0');
        let name = parts.next().unwrap_or("").to_string();
        let timestamp_secs = parts.next().and_then(|value| value.parse::<i64>().ok());
        let mut tag_sources = Vec::new();
        if local_tags.contains(&name) {
            tag_sources.push("local".into());
        }
        if origin_tags.contains(&name) {
            tag_sources.push("origin".into());
        }
        if tag_sources.is_empty() {
            continue;
        }
        deduped.push(GitBranchEntry {
            name,
            kind: "tag".into(),
            worktree_path: None,
            is_head: false,
            is_detached: false,
            timestamp_secs,
            tag_sources,
        });
    }

    deduped.sort_by(|a, b| {
        let kind_ord = |k: &str| match k {
            "local" => 0u8,
            "remote" => 1u8,
            "tag" => 2u8,
            _ => 3u8,
        };
        kind_ord(&a.kind)
            .cmp(&kind_ord(&b.kind))
            .then_with(|| {
                if matches!(a.kind.as_str(), "local" | "remote" | "tag") {
                    b.timestamp_secs.cmp(&a.timestamp_secs)
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(GitBranchListResult { branches: deduped })
}

/// 只遍历本地引用的完整历史，由 Git 展开附注标签，不受 Graph 分页范围影响。
fn reachable_tag_names(repo_root: &ResolvedGitDirectory, refs: &str) -> Result<HashSet<String>> {
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "log",
            "--no-color",
            "--no-show-signature",
            "--simplify-by-decoration",
            "--decorate=full",
            "--decorate-refs=refs/tags/*",
            "--format=%D",
            refs,
            "--",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git tag reachability failed")?;
    if output.truncated {
        return Err(GitError::command(
            "git tag reachability failed",
            "output truncated",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .flat_map(|line| line.split(", "))
        .filter_map(|reference| reference.strip_prefix("tag: refs/tags/"))
        .map(str::to_string)
        .collect())
}

fn push_worktree(
    branches: &mut Vec<GitBranchEntry>,
    branch_timestamps: &HashMap<String, i64>,
    path: String,
    branch: Option<String>,
    head_sha: Option<String>,
) {
    let name = if let Some(ref b) = branch {
        b.clone()
    } else if let Some(ref sha) = head_sha {
        // if detached HEAD with no branch — show shortened SHA as name
        let short = if sha.len() >= 7 {
            &sha[..7]
        } else {
            sha.as_str()
        };
        format!("(detached @ {})", short)
    } else {
        return;
    };
    branches.push(GitBranchEntry {
        name,
        kind: "worktree".into(),
        worktree_path: Some(path),
        is_head: false,
        is_detached: branch.is_none(),
        timestamp_secs: branch
            .as_ref()
            .and_then(|branch| branch_timestamps.get(branch).copied()),
        tag_sources: Vec::new(),
    });
}

pub fn checkout_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch_name: &str,
    track_remote: bool,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if branch_name.starts_with('-') || branch_name.is_empty() {
        return Err(GitError::InvalidPath(branch_name.into()));
    }
    let output = if track_remote {
        run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["switch", "--track", branch_name],
            DEFAULT_TIMEOUT_SECS,
        )?
    } else {
        run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["switch", branch_name],
            DEFAULT_TIMEOUT_SECS,
        )?
    };
    ensure_success(&output, "git switch failed")
}

/// 检出标签对应的提交，使用完整引用避免同名分支歧义，并保留工作区冲突保护。
pub fn checkout_tag(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    tag_name: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if tag_name.starts_with('-') || tag_name.is_empty() {
        return Err(GitError::InvalidPath(tag_name.into()));
    }
    let tag_ref = format!("refs/tags/{tag_name}");
    let validation = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["check-ref-format", &tag_ref],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&validation, "invalid tag name")?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["switch", "--detach", &tag_ref],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git switch tag failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_stats_parser_handles_rename_binary_and_unusual_paths() {
        let stats = sum_numstat(b"3\t1\t\0old\tname\0new\nname\0-\t-\tbinary\0").unwrap();
        assert_eq!((stats.added, stats.removed), (3, 1));
        assert_eq!(stats.files["new\nname"].added, 3);
        assert!(stats.files["binary"].is_binary);
        assert!(sum_numstat(b"3\t1\t\0old\0").is_err());
        assert!(sum_numstat(b"x\t1\tfile\0").is_err());
    }

    #[test]
    fn quick_diff_path_helpers_accept_both_separators() {
        assert_eq!(
            split_file_path("C:\\repo\\src\\main.ts").unwrap(),
            ("C:\\repo\\src", "main.ts")
        );
        assert_eq!(
            split_file_path("/repo/src/main.ts").unwrap(),
            ("/repo/src", "main.ts")
        );
        assert_eq!(
            relative_git_path("/repo", "/repo/src/main.ts", true).unwrap(),
            "src/main.ts"
        );
    }

    #[test]
    fn quick_diff_path_helpers_reject_outside_paths() {
        assert!(relative_git_path("/repo", "/repository/main.ts", true).is_err());
        assert!(relative_git_path("/repo", "/repo/../secret", true).is_err());
        assert!(split_file_path("main.ts").is_err());
    }

    #[test]
    fn sha_is_safe_accepts_hex() {
        assert!(sha_is_safe("abc123"));
        assert!(sha_is_safe(&"a".repeat(40)));
        assert!(sha_is_safe(&"f".repeat(64)));
    }

    #[test]
    fn sha_is_safe_rejects_non_hex_or_oversize() {
        assert!(!sha_is_safe(""));
        assert!(!sha_is_safe("abcg"));
        assert!(!sha_is_safe("abc 123"));
        assert!(!sha_is_safe(&"a".repeat(65)));
        assert!(!sha_is_safe(";rm -rf /"));
    }

    #[test]
    fn full_sha_is_safe_accepts_sha1_and_sha256() {
        assert!(full_sha_is_safe(&"a".repeat(40)));
        assert!(full_sha_is_safe(&"f".repeat(64)));
        assert!(!full_sha_is_safe("abc123"));
        assert!(!full_sha_is_safe(&"a".repeat(41)));
        assert!(!full_sha_is_safe(&"z".repeat(40)));
    }

    #[test]
    fn is_remote_name_char_allows_word_and_punct() {
        for c in "abcXYZ012-_.".chars() {
            assert!(is_remote_name_char(c));
        }
        for c in " /:\\?\"'".chars() {
            assert!(!is_remote_name_char(c));
        }
    }

    #[test]
    fn parse_log_refs_keeps_branches_and_tags_but_skips_remote_head() {
        let remote_names = HashSet::from(["origin".to_string(), "fork".to_string()]);

        assert_eq!(
            parse_log_refs(
                "HEAD -> main, nightly, origin/main, origin/nightly, fork/HEAD -> fork/main, tag: v1.0.0",
                &remote_names,
                Some("main"),
                Some("origin/main"),
            ),
            vec![
                GitLogRef {
                    label: "main".to_string(),
                    kind: GitLogRefKind::Local,
                },
                GitLogRef {
                    label: "origin/main".to_string(),
                    kind: GitLogRefKind::Remote,
                },
                GitLogRef {
                    label: "v1.0.0".to_string(),
                    kind: GitLogRefKind::Tag,
                },
            ],
        );
    }

    #[test]
    fn status_label_for_known_chars() {
        assert_eq!(status_label_for('A'), "Added");
        assert_eq!(status_label_for('M'), "Modified");
        assert_eq!(status_label_for('D'), "Deleted");
        assert_eq!(status_label_for('R'), "Renamed");
        assert_eq!(status_label_for('C'), "Copied");
    }

    #[test]
    fn status_label_for_unknown_falls_back() {
        assert_eq!(status_label_for('X'), "Status X");
    }

    #[test]
    fn commit_file_diff_args_detect_renames_for_each_output() {
        for format in ["--name-status", "--numstat"] {
            let args = commit_diff_tree_args(format, "abc123", Some("def456"));
            let args: Vec<_> = args.iter().filter_map(|arg| arg.to_str()).collect();
            assert!(args.contains(&"--find-renames=50%"));
            assert!(args.contains(&format));
        }
    }

    #[test]
    fn commit_file_parser_keeps_rename_paths_and_statistics() {
        let mut files = parse_diff_tree_name_status(b"R098\0old/path.rs\0new/path.rs\0");
        apply_numstat(&mut files, b"3\t1\0old/path.rs\0new/path.rs\0");

        assert_eq!(files.len(), 1);
        let file = &files[0];
        assert_eq!(file.status, "R");
        assert_eq!(file.original_path.as_deref(), Some("old/path.rs"));
        assert_eq!(file.path, "new/path.rs");
        assert_eq!((file.added, file.removed), (3, 1));
    }

    #[test]
    fn looks_like_no_head_recognizes_phrases() {
        let mk = |s: &str| GitOutput {
            stdout: Vec::new(),
            stderr: s.as_bytes().to_vec(),
            exit_code: Some(128),
            timed_out: false,
            truncated: false,
        };
        assert!(looks_like_no_head(&mk(
            "fatal: ambiguous argument 'HEAD': unknown revision"
        )));
        assert!(looks_like_no_head(&mk(
            "fatal: your current branch 'main' does not have any commits yet"
        )));
        assert!(!looks_like_no_head(&mk("fatal: pathspec did not match")));
    }
}
