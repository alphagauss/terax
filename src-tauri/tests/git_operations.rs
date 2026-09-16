//! Git 操作集成测试。
//!
//! 使用真实临时仓库锁定工作区授权、状态解析和 HEAD Quick Diff 基线不变量。

mod common;

use common::{GitRepoFixture, git_available};
use std::process::Command;
use tempfile::TempDir;
use terax_lib::modules::fs::to_canon;
use terax_lib::modules::git::errors::GitError;
use terax_lib::modules::git::operations;
use terax_lib::modules::git::types::{DiscardEntry, GitDiffSide, GitQuickDiffBaseline};
use terax_lib::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

fn skip_if_no_git() -> bool {
    if !git_available() {
        eprintln!("skipping: git not on PATH");
        return true;
    }
    false
}

fn git_stdout(fx: &GitRepoFixture, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(&fx.repo_path)
        .output()
        .expect("git on PATH");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn resolve_repo_returns_none_outside_repo() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let registry = WorkspaceRegistry::default();
    registry.authorize(&canonical).unwrap();

    let info = operations::resolve_repo(&registry, &to_canon(&canonical), &WorkspaceEnv::Local)
        .expect("resolve_repo");
    assert!(info.is_none());
}

#[test]
fn resolve_repo_returns_branch_for_real_repo() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("seed.txt", "seed\n");
    fx.run_git(&["add", "seed.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);

    let info = operations::resolve_repo(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("resolve_repo")
        .expect("repo present");
    assert_eq!(info.branch, "main");
    assert!(info.upstream.is_none());
    assert!(!info.is_detached);
}

#[test]
fn resolve_repo_returns_branch_for_unborn_head() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let info = operations::resolve_repo(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("resolve_repo")
        .expect("repo present even without commits");
    assert_eq!(info.branch, "main");
    assert!(info.upstream.is_none());
    assert!(!info.is_detached);
}

#[test]
fn quick_diff_baseline_reads_head_instead_of_worktree() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("src/main.ts", "const value = 1;\n");
    fx.run_git(&["add", "src/main.ts"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("src/main.ts", "const value = 2;\n");

    let path = to_canon(fx.repo_path.join("src/main.ts"));
    let baseline = operations::quick_diff_baseline(&fx.registry, &path, &fx.workspace)
        .expect("quick diff baseline");
    let GitQuickDiffBaseline::Text {
        repo_root,
        relative_path,
        head_sha,
        content,
    } = baseline
    else {
        panic!("tracked text file should have a baseline");
    };

    assert_eq!(content, "const value = 1;\n");
    assert_eq!(relative_path, "src/main.ts");
    assert_eq!(repo_root, fx.repo_str());
    assert!(head_sha.is_some());
}

#[test]
fn quick_diff_baseline_uses_empty_content_for_unborn_files() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("new.txt", "new\n");
    let path = to_canon(fx.repo_path.join("new.txt"));

    let baseline = operations::quick_diff_baseline(&fx.registry, &path, &fx.workspace)
        .expect("quick diff baseline");

    let GitQuickDiffBaseline::Text {
        head_sha, content, ..
    } = baseline
    else {
        panic!("new text file should have an empty HEAD baseline");
    };
    assert_eq!(content, "");
    assert!(head_sha.is_none());
}

#[test]
fn quick_diff_baseline_uses_empty_content_for_files_added_after_head() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("seed.txt", "seed\n");
    fx.run_git(&["add", "seed.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("new.txt", "new\n");
    fx.run_git(&["add", "new.txt"]);
    let path = to_canon(fx.repo_path.join("new.txt"));

    let baseline = operations::quick_diff_baseline(&fx.registry, &path, &fx.workspace)
        .expect("quick diff baseline");
    let GitQuickDiffBaseline::Text {
        head_sha, content, ..
    } = baseline
    else {
        panic!("added text file should have an empty HEAD baseline");
    };

    assert_eq!(content, "");
    assert!(head_sha.is_some());
}

#[test]
fn quick_diff_baseline_rejects_untracked_binary_and_oversized_files() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    std::fs::write(fx.repo_path.join("binary.bin"), [0, 1, 2]).expect("write binary");
    fx.write_file("large.txt", &"x".repeat(2 * 1024 * 1024 + 1));

    for path in ["binary.bin", "large.txt"] {
        let path = to_canon(fx.repo_path.join(path));
        let baseline = operations::quick_diff_baseline(&fx.registry, &path, &fx.workspace)
            .expect("quick diff baseline");
        assert!(matches!(baseline, GitQuickDiffBaseline::Unsupported));
    }
}

#[cfg(unix)]
#[test]
fn quick_diff_baseline_does_not_follow_untracked_symlinks() {
    use std::os::unix::fs::symlink;

    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let outside = TempDir::new().expect("outside tempdir");
    let target = outside.path().join("secret.txt");
    std::fs::write(&target, "secret\n").expect("write outside target");
    symlink(target, fx.repo_path.join("link.txt")).expect("create symlink");
    let path = to_canon(fx.repo_path.join("link.txt"));

    let baseline = operations::quick_diff_baseline(&fx.registry, &path, &fx.workspace)
        .expect("quick diff baseline");

    assert!(matches!(baseline, GitQuickDiffBaseline::Unsupported));
}

#[test]
fn quick_diff_baseline_ignores_oversized_head_content() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("large.txt", &"x".repeat(2 * 1024 * 1024 + 1));
    fx.run_git(&["add", "large.txt"]);
    fx.run_git(&["commit", "-q", "-m", "large"]);
    let path = to_canon(fx.repo_path.join("large.txt"));

    let baseline = operations::quick_diff_baseline(&fx.registry, &path, &fx.workspace)
        .expect("quick diff baseline");

    assert!(matches!(baseline, GitQuickDiffBaseline::Unsupported));
}

#[test]
fn status_on_empty_repo_has_no_files() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    assert_eq!(snap.branch, "main");
    assert!(snap.head_sha.is_none());
    assert!(snap.changed_files.is_empty());
    assert_eq!(snap.ahead, 0);
    assert_eq!(snap.behind, 0);
}

#[test]
fn status_lists_untracked_file() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("hello.txt", "hi\n");
    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).expect("status");
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "hello.txt")
        .expect("hello.txt in changed_files");
    assert!(entry.untracked);
    assert!(!entry.staged);
}

#[test]
fn stage_then_commit_produces_log_entry() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    operations::stage(
        &fx.registry,
        &fx.repo_str(),
        &["a.txt".into()],
        &fx.workspace,
    )
    .expect("stage");

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "a.txt")
        .expect("a.txt staged");
    assert!(entry.staged);
    assert!(!entry.untracked);

    let commit =
        operations::commit(&fx.registry, &fx.repo_str(), "add a", &fx.workspace).expect("commit");
    assert_eq!(commit.summary, "add a");
    assert_eq!(commit.commit_sha.len(), 40);

    let entries = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).expect("log");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].sha, commit.commit_sha);
    assert_eq!(entries[0].subject, "add a");
    assert!(
        entries[0]
            .refs
            .iter()
            .any(|reference| reference.label.contains("main"))
    );

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    assert_eq!(snap.head_sha.as_deref(), Some(commit.commit_sha.as_str()));
}

#[test]
fn undo_commit_moves_head_and_keeps_changes_staged() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "v1\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "v1"]);
    let first = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();

    fx.write_file("a.txt", "v2\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "v2"]);
    let second = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();

    operations::undo_commit(&fx.registry, &fx.repo_str(), &second, &fx.workspace)
        .expect("undo_commit");

    let status = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    assert_eq!(status.head_sha.as_deref(), Some(first.as_str()));
    let changed = status
        .changed_files
        .iter()
        .find(|file| file.path == "a.txt")
        .expect("undone commit remains staged");
    assert!(changed.staged);
    assert!(!changed.unstaged);
}

#[test]
fn undo_commit_rejects_a_stale_expected_head() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    for version in 1..=3 {
        fx.write_file("a.txt", &format!("v{version}\n"));
        fx.run_git(&["add", "a.txt"]);
        fx.run_git(&["commit", "-q", "-m", &format!("v{version}")]);
    }
    let entries = operations::log(&fx.registry, &fx.repo_str(), 3, 0, &fx.workspace).unwrap();
    let current = entries[0].sha.clone();
    let stale = entries[1].sha.clone();

    let error = operations::undo_commit(&fx.registry, &fx.repo_str(), &stale, &fx.workspace)
        .expect_err("stale HEAD must fail");
    assert!(error.to_string().contains("HEAD changed"));
    let status = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    assert_eq!(status.head_sha.as_deref(), Some(current.as_str()));
}

#[test]
fn undo_commit_requires_a_full_sha() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let error = operations::undo_commit(&fx.registry, &fx.repo_str(), "abc123", &fx.workspace)
        .expect_err("abbreviated SHA must fail");
    assert!(error.to_string().contains("invalid expected HEAD sha"));
}

#[test]
fn undo_commit_rejects_the_root_commit() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "root\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "root"]);
    let root = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();

    let error = operations::undo_commit(&fx.registry, &fx.repo_str(), &root, &fx.workspace)
        .expect_err("root commit must fail");
    assert!(error.to_string().contains("root commit cannot be undone"));
}

#[test]
fn unstage_clears_index_entry() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "beta\n");
    operations::stage(
        &fx.registry,
        &fx.repo_str(),
        &["a.txt".into()],
        &fx.workspace,
    )
    .unwrap();

    operations::unstage(
        &fx.registry,
        &fx.repo_str(),
        &["a.txt".into()],
        &fx.workspace,
    )
    .expect("unstage");

    let snap = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    let entry = snap
        .changed_files
        .iter()
        .find(|f| f.path == "a.txt")
        .expect("a.txt present");
    assert!(!entry.staged);
    assert!(entry.unstaged);
}

#[test]
fn commit_with_empty_message_is_rejected() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);

    match operations::commit(&fx.registry, &fx.repo_str(), "   ", &fx.workspace) {
        Err(GitError::EmptyCommitMessage) => {}
        Err(other) => panic!("expected EmptyCommitMessage, got {other}"),
        Ok(_) => panic!("expected error for empty message"),
    }
}

#[test]
fn log_on_empty_repo_returns_empty_list() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let entries = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).expect("log");
    assert!(entries.is_empty());
}

#[test]
fn diff_shows_worktree_change() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "alpha\nbeta\n");

    let diff = operations::diff(
        &fx.registry,
        &fx.repo_str(),
        None,
        GitDiffSide::Worktree,
        &fx.workspace,
    )
    .expect("diff");
    assert!(diff.diff_text.contains("+beta"));
}

#[test]
fn diff_staged_only_shows_index_change() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "alpha\nbeta\n");
    fx.run_git(&["add", "a.txt"]);
    fx.write_file("a.txt", "alpha\nbeta\ngamma\n");

    let staged = operations::diff(
        &fx.registry,
        &fx.repo_str(),
        None,
        GitDiffSide::Index,
        &fx.workspace,
    )
    .expect("staged diff");
    assert!(staged.diff_text.contains("+beta"));
    assert!(!staged.diff_text.contains("+gamma"));
}

#[test]
fn discard_tracked_restores_worktree() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.write_file("a.txt", "tampered\n");

    operations::discard(
        &fx.registry,
        &fx.repo_str(),
        &[DiscardEntry {
            path: "a.txt".into(),
            untracked: false,
        }],
        &fx.workspace,
    )
    .expect("discard");

    let content = std::fs::read_to_string(fx.repo_path.join("a.txt")).unwrap();
    assert_eq!(content, "alpha\n");
}

#[test]
fn discard_untracked_removes_file() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("garbage.txt", "junk\n");

    operations::discard(
        &fx.registry,
        &fx.repo_str(),
        &[DiscardEntry {
            path: "garbage.txt".into(),
            untracked: true,
        }],
        &fx.workspace,
    )
    .expect("discard");

    assert!(!fx.repo_path.join("garbage.txt").exists());
}

#[test]
fn panel_snapshot_returns_repo_and_status_after_commit() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("b.txt", "beta\n");

    let snap = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("panel_snapshot");
    let repo = snap.repo.expect("repo present");
    assert_eq!(repo.branch, "main");
    let status = snap.status.expect("status present");
    assert!(status.changed_files.iter().any(|f| f.path == "b.txt"));
}

#[test]
fn panel_snapshot_outside_repo_is_empty() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let registry = WorkspaceRegistry::default();
    registry.authorize(&canonical).unwrap();

    let snap = operations::panel_snapshot(&registry, &to_canon(&canonical), &WorkspaceEnv::Local)
        .expect("panel_snapshot");
    assert!(snap.repo.is_none());
    assert!(snap.status.is_none());
}

#[test]
fn show_commit_diff_returns_patch_for_known_sha() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);

    let entries = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).unwrap();
    let sha = &entries[0].sha;

    let diff = operations::show_commit_diff(&fx.registry, &fx.repo_str(), sha, &fx.workspace)
        .expect("show_commit_diff");
    assert!(diff.diff_text.contains("a.txt"));
    assert!(diff.diff_text.contains("+alpha"));
}

#[test]
fn show_commit_diff_rejects_invalid_sha() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    match operations::show_commit_diff(&fx.registry, &fx.repo_str(), "not-a-sha", &fx.workspace) {
        Err(GitError::CommandFailed { .. }) => {}
        Err(other) => panic!("expected CommandFailed, got {other}"),
        Ok(_) => panic!("expected error for invalid sha"),
    }
}

#[test]
fn log_paginates_with_offset() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    for i in 0..3 {
        fx.write_file(&format!("f{i}.txt"), &format!("v{i}\n"));
        fx.run_git(&["add", &format!("f{i}.txt")]);
        fx.run_git(&["commit", "-q", "-m", &format!("c{i}")]);
    }

    let first_page = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap();
    assert_eq!(first_page.len(), 1);
    let cursor = first_page[0].sha.clone();

    let second_page = operations::log(&fx.registry, &fx.repo_str(), 10, 1, &fx.workspace).unwrap();
    assert!(second_page.iter().all(|e| e.sha != cursor));
    assert_eq!(second_page.len(), 2);
}

#[test]
fn log_offset_pages_cover_diverged_head_and_upstream_once() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("base.txt", "base\n");
    fx.run_git(&["add", "base.txt"]);
    fx.run_git(&["commit", "-q", "-m", "base"]);
    fx.run_git(&["remote", "add", "origin", "https://example.com/repo.git"]);
    fx.run_git(&["config", "branch.main.remote", "origin"]);
    fx.run_git(&["config", "branch.main.merge", "refs/heads/main"]);
    let base = git_stdout(&fx, &["rev-parse", "HEAD"]);
    fx.run_git(&["checkout", "-q", "--detach", &base]);
    fx.write_file("remote.txt", "remote\n");
    fx.run_git(&["add", "remote.txt"]);
    fx.run_git(&["commit", "-q", "-m", "remote"]);
    let remote_head = git_stdout(&fx, &["rev-parse", "HEAD"]);
    fx.run_git(&["update-ref", "refs/remotes/origin/main", &remote_head]);
    fx.run_git(&["checkout", "-q", "main"]);
    fx.write_file("main.txt", "main\n");
    fx.run_git(&["add", "main.txt"]);
    fx.run_git(&["commit", "-q", "-m", "main"]);

    let all = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).unwrap();
    assert_eq!(all.len(), 3);
    let paged: Vec<_> = (0..all.len())
        .map(|skip| {
            operations::log(&fx.registry, &fx.repo_str(), 1, skip as u32, &fx.workspace).unwrap()[0]
                .sha
                .clone()
        })
        .collect();

    assert_eq!(
        paged,
        all.iter()
            .map(|entry| entry.sha.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn log_includes_current_upstream_and_excludes_unrelated_refs() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "base\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "base"]);
    fx.run_git(&["remote", "add", "origin", "https://example.com/repo.git"]);
    fx.run_git(&["config", "branch.main.remote", "origin"]);
    fx.run_git(&["config", "branch.main.merge", "refs/heads/main"]);
    let local_head = git_stdout(&fx, &["rev-parse", "HEAD"]);
    fx.run_git(&["checkout", "-q", "--detach"]);
    fx.write_file("a.txt", "remote\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "remote"]);
    let remote_head = git_stdout(&fx, &["rev-parse", "HEAD"]);
    fx.run_git(&["update-ref", "refs/remotes/origin/main", &remote_head]);
    fx.run_git(&["checkout", "-q", "--detach", &local_head]);
    fx.write_file("other.txt", "other\n");
    fx.run_git(&["add", "other.txt"]);
    fx.run_git(&["commit", "-q", "-m", "other"]);
    let unrelated_head = git_stdout(&fx, &["rev-parse", "HEAD"]);
    fx.run_git(&[
        "update-ref",
        "refs/remotes/origin/other",
        &unrelated_head,
    ]);
    fx.run_git(&["update-ref", "refs/heads/feature", &unrelated_head]);
    fx.run_git(&["update-ref", "refs/heads/nightly", &local_head]);
    fx.run_git(&[
        "update-ref",
        "refs/remotes/origin/nightly",
        &local_head,
    ]);
    fx.run_git(&["checkout", "-q", "main"]);

    let entries = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).unwrap();

    assert_eq!(git_stdout(&fx, &["rev-parse", "HEAD"]), local_head);
    assert_eq!(entries[0].sha, remote_head);
    let remote = entries
        .iter()
        .find(|entry| entry.sha == remote_head)
        .expect("remote-only commit present");
    assert!(remote.refs.iter().any(|reference| {
        reference.label == "origin/main"
            && reference.kind == terax_lib::modules::git::types::GitLogRefKind::Remote
    }));
    let local = entries
        .iter()
        .find(|entry| entry.sha == local_head)
        .expect("local HEAD present");
    assert!(local.refs.iter().any(|reference| reference.label == "main"));
    assert!(local.refs.iter().all(|reference| {
        reference.label != "nightly" && reference.label != "origin/nightly"
    }));
    assert!(entries.iter().all(|entry| entry.sha != unrelated_head));
}

#[test]
fn commit_files_reports_added_and_modified() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "alpha\n");
    fx.write_file("b.txt", "beta\n");
    fx.run_git(&["add", "a.txt", "b.txt"]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);
    fx.write_file("a.txt", "alpha2\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "modify"]);

    let entries = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).unwrap();
    let head = &entries[0].sha;

    let files =
        operations::commit_files(&fx.registry, &fx.repo_str(), head, &fx.workspace).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[0].status, "M");
    assert_eq!(files[0].status_label, "Modified");
    assert_eq!(files[0].added, 1);
    assert_eq!(files[0].removed, 1);
    assert!(!files[0].is_binary);
}

#[test]
fn commit_files_reports_files_from_the_root_commit() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("root.txt", "first\nsecond\n");
    fx.run_git(&["add", "root.txt"]);
    fx.run_git(&["commit", "-q", "-m", "root"]);

    let root = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();
    let files = operations::commit_files(&fx.registry, &fx.repo_str(), &root, &fx.workspace)
        .expect("root commit files");

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "root.txt");
    assert_eq!(files[0].status, "A");
    assert_eq!((files[0].added, files[0].removed), (2, 0));
}

#[test]
fn commit_files_reports_a_merge_relative_to_its_first_parent() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("base.txt", "base\n");
    fx.run_git(&["add", "base.txt"]);
    fx.run_git(&["commit", "-q", "-m", "base"]);

    fx.run_git(&["checkout", "-q", "-b", "feature"]);
    fx.write_file("feature.txt", "feature\n");
    fx.run_git(&["add", "feature.txt"]);
    fx.run_git(&["commit", "-q", "-m", "feature"]);

    fx.run_git(&["checkout", "-q", "main"]);
    fx.write_file("main.txt", "main\n");
    fx.run_git(&["add", "main.txt"]);
    fx.run_git(&["commit", "-q", "-m", "main"]);
    fx.run_git(&["merge", "-q", "--no-ff", "feature", "-m", "merge"]);

    let merge = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();
    let files = operations::commit_files(&fx.registry, &fx.repo_str(), &merge, &fx.workspace)
        .expect("merge commit files");

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "feature.txt");
    assert_eq!(files[0].status, "A");
    assert_eq!((files[0].added, files[0].removed), (1, 0));
}

#[test]
fn commit_files_merges_status_and_numstat_for_added_modified_and_deleted() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("modified.txt", "before\n");
    fx.write_file("deleted.txt", "remove me\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "seed"]);

    fx.write_file("modified.txt", "after\n");
    fx.write_file("added.txt", "new\n");
    std::fs::remove_file(fx.repo_path.join("deleted.txt")).unwrap();
    fx.run_git(&["add", "-A"]);
    fx.run_git(&["commit", "-q", "-m", "mixed"]);

    let head = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();
    let files = operations::commit_files(&fx.registry, &fx.repo_str(), &head, &fx.workspace)
        .expect("commit_files");

    let added = files.iter().find(|file| file.path == "added.txt").unwrap();
    assert_eq!(
        (added.status.as_str(), added.added, added.removed),
        ("A", 1, 0)
    );
    let modified = files
        .iter()
        .find(|file| file.path == "modified.txt")
        .unwrap();
    assert_eq!(
        (modified.status.as_str(), modified.added, modified.removed),
        ("M", 1, 1)
    );
    let deleted = files
        .iter()
        .find(|file| file.path == "deleted.txt")
        .unwrap();
    assert_eq!(
        (deleted.status.as_str(), deleted.added, deleted.removed),
        ("D", 0, 1)
    );
}

#[test]
fn commit_message_returns_subject_and_body() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&[
        "commit",
        "-q",
        "-m",
        "subject line",
        "-m",
        "body line one\nbody line two",
    ]);
    let head = operations::log(&fx.registry, &fx.repo_str(), 1, 0, &fx.workspace).unwrap()[0]
        .sha
        .clone();

    let message = operations::commit_message(&fx.registry, &fx.repo_str(), &head, &fx.workspace)
        .expect("commit_message");
    assert_eq!(message, "subject line\n\nbody line one\nbody line two");
}

#[test]
fn commit_file_diff_returns_original_and_modified_text() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "v1\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "v1"]);
    fx.write_file("a.txt", "v2\n");
    fx.run_git(&["add", "a.txt"]);
    fx.run_git(&["commit", "-q", "-m", "v2"]);

    let entries = operations::log(&fx.registry, &fx.repo_str(), 10, 0, &fx.workspace).unwrap();
    let head = &entries[0].sha;

    let diff = operations::commit_file_diff(
        &fx.registry,
        &fx.repo_str(),
        head,
        "a.txt",
        None,
        &fx.workspace,
    )
    .unwrap();
    assert_eq!(diff.original_content, "v1\n");
    assert_eq!(diff.modified_content, "v2\n");
    assert!(!diff.is_binary);
}

#[test]
fn remote_url_returns_none_for_missing_remote() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let url =
        operations::remote_url(&fx.registry, &fx.repo_str(), "origin", &fx.workspace).unwrap();
    assert!(url.is_none());
}

#[test]
fn remote_url_returns_configured_url() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.run_git(&["remote", "add", "origin", "https://example.com/x.git"]);

    let url =
        operations::remote_url(&fx.registry, &fx.repo_str(), "origin", &fx.workspace).unwrap();
    assert_eq!(url.as_deref(), Some("https://example.com/x.git"));
}

#[test]
fn remote_url_rejects_unsafe_remote_name() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let url = operations::remote_url(
        &fx.registry,
        &fx.repo_str(),
        "name with space",
        &fx.workspace,
    )
    .unwrap();
    assert!(url.is_none());
}

#[test]
fn unauthorized_path_is_rejected() {
    if skip_if_no_git() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let registry = WorkspaceRegistry::default();

    match operations::status(&registry, &to_canon(&canonical), &WorkspaceEnv::Local) {
        Err(GitError::PathOutsideWorkspace(_)) => {}
        Err(other) => panic!("expected PathOutsideWorkspace, got {other}"),
        Ok(_) => panic!("expected error for unauthorized dir"),
    }
}

#[test]
fn checkout_branch_rejects_unsafe_names() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();

    let err_empty =
        operations::checkout_branch(&fx.registry, &fx.repo_str(), "", false, &fx.workspace)
            .unwrap_err();
    assert!(matches!(err_empty, GitError::InvalidPath(p) if p.is_empty()));

    let err_dash =
        operations::checkout_branch(&fx.registry, &fx.repo_str(), "-f", false, &fx.workspace)
            .unwrap_err();
    assert!(matches!(err_dash, GitError::InvalidPath(p) if p == "-f"));

    let err_dash_long = operations::checkout_branch(
        &fx.registry,
        &fx.repo_str(),
        "--detach",
        false,
        &fx.workspace,
    )
    .unwrap_err();
    assert!(matches!(err_dash_long, GitError::InvalidPath(p) if p == "--detach"));
}

#[test]
fn list_branches_keeps_current_branch_local_and_surfaces_worktrees() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.run_git(&["branch", "feature"]);

    let wt = TempDir::new().unwrap();
    let wt_path = wt.path().join("linked");
    fx.run_git(&[
        "worktree",
        "add",
        "-q",
        wt_path.to_str().unwrap(),
        "feature",
    ]);

    let result = operations::list_branches(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("list_branches");

    // current branch stays local+head despite the main worktree being listed
    let main = result
        .branches
        .iter()
        .find(|b| b.name == "main")
        .expect("main branch present");
    assert_eq!(main.kind, "local");
    assert!(main.is_head);
    assert!(main.worktree_path.is_none());

    let feature: Vec<_> = result
        .branches
        .iter()
        .filter(|b| b.name == "feature")
        .collect();
    assert_eq!(feature.len(), 1);
    assert_eq!(feature[0].kind, "worktree");
    assert!(!feature[0].is_head);
    assert!(feature[0].worktree_path.is_some());
}

#[test]
fn list_branches_includes_remote_refs_and_commit_times() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.run_git(&[
        "remote",
        "add",
        "origin",
        "https://example.invalid/repo.git",
    ]);
    fx.run_git(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    fx.run_git(&["update-ref", "refs/remotes/upstream/feature", "HEAD"]);
    fx.run_git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);

    let result = operations::list_branches(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("list_branches");

    let main = result
        .branches
        .iter()
        .find(|branch| branch.name == "main")
        .expect("main branch present");
    assert_eq!(main.kind, "local");
    assert!(main.timestamp_secs.is_some());

    let remote = result
        .branches
        .iter()
        .find(|branch| branch.name == "origin/feature")
        .expect("remote branch present");
    assert_eq!(remote.kind, "remote");
    assert!(remote.timestamp_secs.is_some());
    assert!(!result
        .branches
        .iter()
        .any(|branch| branch.name == "origin"));
    assert!(!result
        .branches
        .iter()
        .any(|branch| branch.name.starts_with("upstream/")));
}

#[test]
fn list_branches_sorts_local_and_remote_by_commit_time() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "newer"]);

    let tree = Command::new("git")
        .args(["rev-parse", "HEAD^{tree}"])
        .current_dir(&fx.repo_path)
        .output()
        .expect("resolve tree");
    assert!(tree.status.success());
    let tree = String::from_utf8(tree.stdout).expect("tree output");
    let older = Command::new("git")
        .args(["commit-tree", tree.trim(), "-m", "older"])
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z")
        .current_dir(&fx.repo_path)
        .output()
        .expect("create older commit");
    assert!(older.status.success());
    let older = String::from_utf8(older.stdout).expect("older commit output");
    let older = older.trim();
    fx.run_git(&["branch", "older", older]);
    fx.run_git(&["update-ref", "refs/remotes/origin/older", older]);
    fx.run_git(&["update-ref", "refs/remotes/origin/newer", "HEAD"]);

    let result = operations::list_branches(&fx.registry, &fx.repo_str(), &fx.workspace)
        .expect("list_branches");
    let local: Vec<_> = result
        .branches
        .iter()
        .filter(|branch| branch.kind == "local")
        .map(|branch| branch.name.as_str())
        .collect();
    let remote: Vec<_> = result
        .branches
        .iter()
        .filter(|branch| branch.kind == "remote")
        .map(|branch| branch.name.as_str())
        .collect();

    assert_eq!(local, ["main", "older"]);
    assert_eq!(remote, ["origin/newer", "origin/older"]);
}

#[test]
fn checkout_remote_branch_creates_a_tracking_branch() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("a.txt", "a\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-q", "-m", "init"]);
    fx.run_git(&[
        "remote",
        "add",
        "origin",
        "https://example.invalid/repo.git",
    ]);
    fx.run_git(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    operations::checkout_branch(
        &fx.registry,
        &fx.repo_str(),
        "origin/feature",
        true,
        &fx.workspace,
    )
    .expect("checkout remote branch");

    let current = fx.repo_path.join(".git").join("HEAD");
    let head = std::fs::read_to_string(current).expect("read HEAD");
    assert_eq!(head.trim(), "ref: refs/heads/feature");
}

#[test]
fn panel_line_stats_separates_index_and_worktree_and_counts_untracked() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("tracked.txt", "base\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-qm", "seed"]);
    fx.write_file("tracked.txt", "staged\nsecond\n");
    fx.run_git(&["add", "."]);
    fx.write_file("tracked.txt", "worktree\nsecond\nthird\n");
    fx.write_file("untracked.txt", "one\r\ntwo");
    fx.write_file("empty.txt", "");
    fx.write_file("binary.dat", "\0binary\n");
    let snapshot = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    let stats = snapshot.diff_stats.unwrap();
    let index = stats.index.unwrap();
    let worktree = stats.worktree.unwrap();
    assert_eq!((index.added, index.removed), (2, 1));
    assert_eq!((worktree.added, worktree.removed), (4, 1));
    assert!(!index.incomplete && !worktree.incomplete);
    assert!(snapshot
        .status
        .unwrap()
        .changed_files
        .iter()
        .any(|file| file.path == "untracked.txt" && file.untracked));
}

#[test]
fn panel_line_stats_handles_unborn_head_and_unstaged_then_staged_moves() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    let content = "one\ntwo\nthree\nfour\nfive\n";
    fx.write_file("old.txt", content);
    fx.run_git(&["add", "."]);
    let stats = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .unwrap()
        .diff_stats
        .unwrap();
    assert_eq!(stats.index.unwrap().added, 5);
    assert_eq!(stats.worktree.unwrap().added, 0);
    fx.run_git(&["commit", "-qm", "seed"]);
    std::fs::rename(fx.repo_path.join("old.txt"), fx.repo_path.join("new.txt")).unwrap();
    let stats = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .unwrap()
        .diff_stats
        .unwrap()
        .worktree
        .unwrap();
    assert_eq!((stats.added, stats.removed), (5, 5));
    fx.run_git(&["config", "diff.renames", "false"]);
    fx.run_git(&["add", "-A"]);
    let stats = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .unwrap()
        .diff_stats
        .unwrap()
        .index
        .unwrap();
    assert_eq!((stats.added, stats.removed), (0, 0));
    fx.write_file("new.txt", "one\ntwo\nthree\nfour\nchanged\n");
    fx.run_git(&["add", "-A"]);
    let stats = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
        .unwrap()
        .diff_stats
        .unwrap()
        .index
        .unwrap();
    assert_eq!((stats.added, stats.removed), (1, 1));
}

#[test]
fn panel_line_stats_marks_unreadable_large_files_without_losing_status() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("large.txt", &"x".repeat(2 * 1024 * 1024 + 1));
    let snapshot = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    assert_eq!(snapshot.status.unwrap().changed_files.len(), 1);
    assert!(snapshot.diff_stats.unwrap().worktree.unwrap().incomplete);
}

#[test]
fn panel_line_stats_marks_merge_conflicts_incomplete() {
    if skip_if_no_git() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file("conflict.txt", "base\n");
    fx.run_git(&["add", "."]);
    fx.run_git(&["commit", "-qm", "base"]);
    fx.run_git(&["checkout", "-qb", "other"]);
    fx.write_file("conflict.txt", "other\n");
    fx.run_git(&["commit", "-qam", "other"]);
    fx.run_git(&["checkout", "main"]);
    fx.write_file("conflict.txt", "main\n");
    fx.run_git(&["commit", "-qam", "main"]);
    let merge = Command::new("git")
        .current_dir(&fx.repo_path)
        .args(["merge", "other"])
        .output()
        .unwrap();
    assert!(!merge.status.success());
    let snapshot = operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace).unwrap();
    assert!(snapshot
        .status
        .unwrap()
        .changed_files
        .iter()
        .any(|file| file.index_status == "U"));
    let stats = snapshot.diff_stats.unwrap();
    assert!(stats.index.unwrap().incomplete);
    assert!(stats.worktree.unwrap().incomplete);
}
