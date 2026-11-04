//! 显式 Git 联网操作的原生入口，在进程内防止同一仓库重复执行并禁止自动重放。
//! 只读刷新不经过此入口；SSH 和 WSL 将必要检查与一次操作放在同一批次。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use crate::errors::{GitError, Result};
use crate::process::{ensure_git_available, ensure_success, git_stdout_line_opt, run_git};
use crate::types::NETWORK_TIMEOUT_SECS;
use crate::utils::batch_repo_root;
use terax_core::modules::remote::git_service::GitRemoteAction;
use terax_core::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct OperationGuard(String);

impl OperationGuard {
    fn acquire(workspace: &WorkspaceEnv, path: &str) -> Result<Self> {
        // 仓库根来自 Git；Linux 文件名中的反斜杠不是分隔符，不能与其他仓库混淆。
        let mut parts = Vec::new();
        let path = if cfg!(windows) && matches!(workspace, WorkspaceEnv::Local) {
            path.replace('\\', "/")
        } else {
            path.to_owned()
        };
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part),
            }
        }
        let environment = match workspace {
            WorkspaceEnv::Local => "local".into(),
            WorkspaceEnv::Wsl { distro } => format!("wsl:{distro}"),
            WorkspaceEnv::Ssh { profile_id } => format!("ssh:{profile_id}"),
        };
        let key = format!("{environment}\0{}", parts.join("/"));
        let mut active = ACTIVE
            .get_or_init(Default::default)
            .lock()
            .expect("Git operations poisoned");
        if !active.insert(key.clone()) {
            return Err(GitError::RemoteOperationBusy);
        }
        Ok(Self(key))
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        ACTIVE
            .get()
            .expect("Git operation registry")
            .lock()
            .expect("Git operations poisoned")
            .remove(&self.0);
    }
}

/// 一次调用最多执行一个 fetch、pull 或 push；失败直接返回，由调用方读取本地状态。
pub(super) fn execute(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
    action: GitRemoteAction,
) -> Result<Option<String>> {
    let root = batch_repo_root(registry, path, workspace)?;
    let _guard = OperationGuard::acquire(workspace, &root.git_path)?;
    ensure_git_available(workspace)?;
    if !matches!(workspace, WorkspaceEnv::Local) {
        return crate::batch::remote_action(&root.git_path, workspace, action);
    }
    let upstream = if matches!(action, GitRemoteAction::Push) {
        Some(
            git_stdout_line_opt(
                workspace,
                &root.git_path,
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            )?
            .ok_or(GitError::NoUpstream)?,
        )
    } else {
        None
    };
    let (args, context): (&[&str], _) = match action {
        GitRemoteAction::Fetch => (&["fetch", "--prune"], "git fetch failed"),
        GitRemoteAction::Pull => (
            &["pull", "--ff-only", "--prune"],
            "git pull --ff-only failed",
        ),
        GitRemoteAction::Push => (&["push"], "git push failed"),
    };
    let output = run_git(workspace, Some(&root.git_path), args, NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, context)?;
    Ok(upstream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_identity_normalizes_paths_and_isolates_repositories_and_environments() {
        let env = WorkspaceEnv::Ssh {
            profile_id: "guard-test".into(),
        };
        let first = OperationGuard::acquire(&env, "/repo").unwrap();
        assert!(OperationGuard::acquire(&env, "/repo/./sub/..").is_err());
        let other = OperationGuard::acquire(&env, "/other").unwrap();
        let backslash = OperationGuard::acquire(&env, "/repo\\child").unwrap();
        let subdirectory = OperationGuard::acquire(&env, "/repo/child").unwrap();
        let independent = OperationGuard::acquire(&WorkspaceEnv::Local, "/repo").unwrap();
        drop(first);
        drop(other);
        drop(independent);
        drop(backslash);
        drop(subdirectory);
    }
}
