//! Git 仓库操作与安全边界实现。
//!
//! 所有路径先经过工作区授权和仓库内校验，再交给本地、WSL 或 SSH Git 进程。

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::parser::parse_porcelain_v2;
use crate::modules::git::process::{
    ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt, git_stdout_lines,
    read_text_file, run_git,
};
use crate::modules::git::types::{
    DiscardEntry, GitBranchEntry, GitBranchListResult, GitCommitFileChange, GitCommitResult,
    GitDiffContentResult, GitDiffResult, GitDiffSide, GitLineStats, GitLogEntry, GitLogRef,
    GitLogRefKind, GitOutput, GitPanelDiffStats, GitPanelSnapshot, GitPushResult,
    GitQuickDiffBaseline, GitRepoInfo, GitStatusSnapshot, TextSource, DEFAULT_TIMEOUT_SECS,
    MAX_FILE_BYTES, NETWORK_TIMEOUT_SECS,
};
use crate::modules::git::utils::{
    authorized_repo_root, canonical_dir, is_safe_pathspec, resolve_within_repo, split_upstream,
    ResolvedGitDirectory,
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

const DIFF_VIEW_TEXT_LIMIT: usize = 256 * 1024;

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
) -> Result<GitPanelSnapshot> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !cwd.remote && !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    let Some(canonical_root) = resolve_repo_root_in_authorized(registry, &cwd)? else {
        return Ok(GitPanelSnapshot {
            diff_stats: None,
            repo: None,
            status: None,
        });
    };
    let status = status_inner(&canonical_root)?;
    let repo = GitRepoInfo {
        repo_root: canonical_root.git_path.clone(),
        branch: status.branch.clone(),
        upstream: status.upstream.clone(),
        is_detached: status.is_detached,
    };
    let diff_stats = GitPanelDiffStats {
        worktree: panel_line_stats(&canonical_root, &status, false).ok(),
        index: panel_line_stats(&canonical_root, &status, true).ok(),
    };
    Ok(GitPanelSnapshot {
        diff_stats: Some(diff_stats),
        repo: Some(repo),
        status: Some(status),
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
    // 未合并的索引缺少普通比较基线，不能将 Git 输出当作完整的两侧统计。
    stats.incomplete = status.truncated
        || status.changed_files.iter().any(|file| {
            matches!(
                (file.index_status.as_str(), file.worktree_status.as_str()),
                ("U", _) | (_, "U") | ("A", "A") | ("D", "D")
            )
        });
    if !staged {
        for file in status.changed_files.iter().filter(|file| file.untracked) {
            if !is_safe_pathspec(&file.path) {
                stats.incomplete = true;
                continue;
            }
            // 校验路径不越界，同时保留末级符号链接供读取器拒绝跟随。
            let local_path = repo_root.local_path.join(&file.path);
            if !repo_root.remote && resolve_within_repo(&repo_root.local_path, &file.path).is_err()
            {
                stats.incomplete = true;
                continue;
            }
            match read_worktree_text(repo_root, &file.path, &local_path) {
                Ok(TextSource::Text(text)) => {
                    stats.added += text.bytes().filter(|byte| *byte == b'\n').count() as u64
                        + u64::from(!text.is_empty() && !text.ends_with('\n'));
                }
                Ok(TextSource::Binary) => {}
                Ok(TextSource::Missing) | Err(_) => stats.incomplete = true,
            }
        }
    }
    Ok(stats)
}

/// 按 NUL 边界跳过重命名的双路径，文件名中的制表符和换行不参与统计解析。
fn sum_numstat(bytes: &[u8]) -> Result<GitLineStats> {
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
        let path = columns.next().ok_or_else(invalid)?;
        if path.is_empty() {
            for _ in 0..2 {
                if records.next().filter(|path| !path.is_empty()).is_none() {
                    return Err(invalid());
                }
            }
        }
        if added == b"-" && removed == b"-" {
            continue;
        }
        let number = |raw| {
            std::str::from_utf8(raw)
                .ok()
                .and_then(|text| text.parse::<u64>().ok())
                .ok_or_else(invalid)
        };
        stats.added = stats
            .added
            .checked_add(number(added)?)
            .ok_or_else(invalid)?;
        stats.removed = stats
            .removed
            .checked_add(number(removed)?)
            .ok_or_else(invalid)?;
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
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;

    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let parsed = parse_porcelain_v2(stdout);

    Ok(GitStatusSnapshot {
        repo_root: repo_root.git_path.clone(),
        branch: parsed.branch,
        head_sha: parsed.head_sha,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        is_detached: parsed.is_detached,
        truncated: output.truncated,
        changed_files: parsed.files,
    })
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
/// HEAD 中尚不存在的文本文件返回空基线，使新增文件显示为整文件新增。
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
    let mut args: Vec<OsString> = vec!["add".into(), "--".into()];
    for p in &resolved {
        args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git add failed")
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
    let mut reset_args: Vec<OsString> = vec!["reset".into(), "HEAD".into(), "--".into()];
    for p in &resolved {
        reset_args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        reset_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code == Some(0) {
        return Ok(());
    }
    if !looks_like_no_head(&output) {
        return ensure_success(&output, "git reset failed");
    }
    let mut rm_args: Vec<OsString> = vec!["rm".into(), "--cached".into(), "-r".into(), "--".into()];
    for p in &resolved {
        rm_args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        rm_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git rm --cached failed")
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

    if !tracked.is_empty() {
        let mut args: Vec<OsString> = vec!["restore".into(), "--worktree".into(), "--".into()];
        for p in &tracked {
            args.push(p.clone().into());
        }
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            args,
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git restore failed")?;
    }

    if !untracked.is_empty() {
        let mut args: Vec<OsString> = vec!["clean".into(), "-f".into(), "-d".into(), "--".into()];
        for p in &untracked {
            args.push(p.clone().into());
        }
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            args,
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
) -> Result<GitPushResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let upstream = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    if upstream.is_none() {
        return Err(GitError::NoUpstream);
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["push"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git push failed")?;

    let upstream = upstream.unwrap();
    let (remote, branch) = split_upstream(&upstream);
    Ok(GitPushResult {
        remote,
        branch,
        pushed: true,
    })
}

const LOG_FORMAT: &str = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s";
const MAX_LOG_LIMIT: u32 = 200;

pub fn log(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    limit: u32,
    skip: u32,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let bounded = limit.clamp(1, MAX_LOG_LIMIT);
    let remote_names: HashSet<String> =
        git_stdout_lines(&repo_root.workspace, &repo_root.git_path, ["remote"])?
            .into_iter()
            .filter(|name| !name.is_empty())
            .collect();
    let count_arg = format!("--max-count={bounded}");
    let skip_arg = format!("--skip={skip}");
    let format_arg = format!("--format={LOG_FORMAT}");
    let current_branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
    )?;
    let upstream_ref = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--symbolic-full-name", "@{upstream}"],
    )?;
    let upstream_label = upstream_ref
        .as_deref()
        .map(|refname| {
            refname
                .strip_prefix("refs/remotes/")
                .or_else(|| refname.strip_prefix("refs/heads/"))
                .unwrap_or(refname)
        })
        .map(str::to_string);
    let mut args: Vec<OsString> = vec![
        OsString::from("log"),
        OsString::from("--no-color"),
        OsString::from("--shortstat"),
        OsString::from("--topo-order"),
        OsString::from("--ignore-missing"),
        OsString::from(count_arg),
        OsString::from(skip_arg),
        OsString::from(format_arg),
        OsString::from("HEAD"),
    ];
    if let Some(upstream_ref) = upstream_ref {
        args.push(OsString::from(upstream_ref));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
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
    // Lines we get back interleave:
    //   <sha>\x1f<author>\x1f<email>\x1f<ts>\x1f<parents>\x1f<refs>\x1f<subject>
    //   <blank>
    //    5 files changed, 12 insertions(+), 3 deletions(-)
    // Commits without diffstats (root commits, merges with no changes) just
    // skip the shortstat line. Detect commit headers by the presence of
    // the unit-separator we put in the format.
    for raw_line in stdout.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.contains('\x1f') {
            let mut fields = line.splitn(7, '\x1f');
            let sha = fields.next().unwrap_or("").to_string();
            if !sha_is_safe(&sha) {
                continue;
            }
            let author = fields.next().unwrap_or("").to_string();
            let author_email = fields.next().unwrap_or("").to_string();
            let timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let parents_raw = fields.next().unwrap_or("");
            let parents: Vec<String> = parents_raw
                .split_ascii_whitespace()
                .map(|s| s.to_string())
                .collect();
            let refs = parse_log_refs(
                fields.next().unwrap_or(""),
                &remote_names,
                current_branch.as_deref(),
                upstream_label.as_deref(),
            );
            let subject = fields.next().unwrap_or("").to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            entries.push(GitLogEntry {
                sha,
                short_sha,
                author,
                author_email,
                timestamp_secs: timestamp,
                parents,
                refs,
                subject,
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            });
            continue;
        }
        if let Some(current) = entries.last_mut() {
            if line.contains("file changed") || line.contains("files changed") {
                let (files, ins, del) = parse_shortstat(line);
                current.files_changed = files;
                current.insertions = ins;
                current.deletions = del;
            }
        }
    }
    Ok(entries)
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

fn parse_shortstat(tail: &str) -> (u32, u32, u32) {
    // Looks for a line like " 5 files changed, 12 insertions(+), 3 deletions(-)"
    for line in tail.lines() {
        let trimmed = line.trim();
        if !(trimmed.contains("file changed") || trimmed.contains("files changed")) {
            continue;
        }
        let mut files = 0u32;
        let mut ins = 0u32;
        let mut del = 0u32;
        for part in trimmed.split(',') {
            let part = part.trim();
            let num_str = part.split_ascii_whitespace().next().unwrap_or("0");
            let n: u32 = num_str.parse().unwrap_or(0);
            if part.contains("file") {
                files = n;
            } else if part.contains("insertion") {
                ins = n;
            } else if part.contains("deletion") {
                del = n;
            }
        }
        return (files, ins, del);
    }
    (0, 0, 0)
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
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["fetch", "--prune"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git fetch failed")
}

pub fn pull_ff_only(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["pull", "--ff-only"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git pull --ff-only failed")
}

fn nothing_to_commit(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stderr.contains("nothing to commit") || stdout.contains("nothing to commit")
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
    let manager = crate::modules::remote::manager::global_manager().map_err(GitError::Spawn)?;
    let profile_id = profile_id.clone();
    let path = crate::modules::remote::session::join_remote(&repo_root.git_path, relative);
    let symlink_path = Path::new(&path).to_path_buf();
    let bytes = tauri::async_runtime::block_on(async move {
        let workspace = manager.workspace(&profile_id).await?;
        let stat = crate::modules::remote::sftp::stat(&workspace, &path).await?;
        if stat.kind == crate::modules::remote::sftp::RemoteEntryKind::Symlink {
            return Ok(None);
        }
        if stat.size > MAX_FILE_BYTES {
            return Err(format!("remote file is too large: {} bytes", stat.size));
        }
        crate::modules::remote::sftp::read_file(&workspace, &path, MAX_FILE_BYTES)
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
            let name = parts.next().unwrap_or("").to_string();
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
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut deduped: Vec<GitBranchEntry> = Vec::with_capacity(branches.len());
    for b in branches {
        if let Some(&existing_idx) = seen.get(&b.name) {
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
            seen.insert(b.name.clone(), deduped.len());
            deduped.push(b);
        }
    }

    deduped.sort_by(|a, b| {
        let kind_ord = |k: &str| match k {
            "local" => 0u8,
            "remote" => 1u8,
            _ => 2u8,
        };
        kind_ord(&a.kind)
            .cmp(&kind_ord(&b.kind))
            .then_with(|| {
                if matches!(a.kind.as_str(), "local" | "remote") {
                    b.timestamp_secs.cmp(&a.timestamp_secs)
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(GitBranchListResult { branches: deduped })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_stats_parser_handles_rename_binary_and_unusual_paths() {
        let stats = sum_numstat(b"3\t1\t\0old\tname\0new\nname\0-\t-\tbinary\0").unwrap();
        assert_eq!((stats.added, stats.removed), (3, 1));
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
    fn parse_shortstat_pulls_three_counts() {
        let line = " 5 files changed, 12 insertions(+), 3 deletions(-)";
        assert_eq!(parse_shortstat(line), (5, 12, 3));
    }

    #[test]
    fn parse_shortstat_handles_singular_file() {
        let line = " 1 file changed, 1 insertion(+)";
        assert_eq!(parse_shortstat(line), (1, 1, 0));
    }

    #[test]
    fn parse_shortstat_returns_zeros_when_absent() {
        assert_eq!(parse_shortstat("no stat here"), (0, 0, 0));
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
