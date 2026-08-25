//! SSH 递归目录删除的封闭任务。
//!
//! 调用方先验证路径并区分文件与目录，本模块只执行一个经过转义的 `rm -rf` 目录任务。

use std::sync::Arc;
use std::time::Duration;

use super::{TaskKind, TASK_OUTPUT_LIMIT};
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 在服务器本地递归删除已验证的目录。
pub(crate) async fn recursive(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    let command = format!(
        "command -v rm >/dev/null 2>&1 || exit 72; exec rm -rf -- {}",
        shell_quote(path.trim_end_matches('/'))
    );
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::RecursiveDelete,
            &command,
            None,
            TIMEOUT,
            TASK_OUTPUT_LIMIT,
        )
        .await?;
    if output.timed_out {
        return Err(format!("remote recursive delete timed out: {path}"));
    }
    if output.exit_code == Some(0) {
        workspace.tasks.mark_available(TaskKind::RecursiveDelete);
        return Ok(());
    }
    if output.exit_code == Some(72) {
        workspace
            .tasks
            .mark_unavailable(TaskKind::RecursiveDelete, "missing rm");
        return Err("remote recursive delete requires rm".into());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!(
            "remote recursive delete failed with exit {:?}: {path}",
            output.exit_code
        )
    } else {
        format!("remote recursive delete failed: {detail}")
    })
}

#[cfg(test)]
mod tests {
    use crate::modules::remote::session::shell_quote;

    #[test]
    fn recursive_delete_quotes_one_exact_path() {
        let path = "/tmp/a'; touch /tmp/pwned; '";
        let command = format!(
            "command -v rm >/dev/null 2>&1 || exit 72; exec rm -rf -- {}",
            shell_quote(path)
        );
        assert_eq!(
            command,
            "command -v rm >/dev/null 2>&1 || exit 72; exec rm -rf -- '/tmp/a'\\''; touch /tmp/pwned; '\\'''"
        );
    }
}
