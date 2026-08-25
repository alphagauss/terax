//! Bash 目录汇总任务的命令构造与 SSH 执行。
//!
//! 同一内嵌脚本同时供 WSL 本地桥和 SSH 封闭任务使用，避免属性模块维护第二份脚本。

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::{TaskKind, TASK_OUTPUT_LIMIT};
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/tree_summary.sh");
const TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 构造 WSL 与 SSH 共用的固定目录汇总脚本。
pub(crate) fn script(path: &str) -> String {
    format!("target_path={}; {SOURCE}", shell_quote(path))
}

/// 在可取消的内部 task channel 上执行 SSH 目录汇总。
pub(crate) async fn run(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    cancellation: &CancellationToken,
) -> Result<crate::modules::remote::session::ExecOutput, String> {
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script(path))
    );
    workspace
        .tasks
        .run_cancellable(
            workspace,
            TaskKind::TreeSummary,
            &command,
            TIMEOUT,
            TASK_OUTPUT_LIMIT,
            cancellation,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::script;

    #[test]
    fn summary_script_quotes_the_target_path() {
        let script = script("/work/a'b");
        assert!(script.starts_with("target_path='/work/a'\\''b';"));
        assert!(script.contains("TERAX_PROPERTIES_SCAN_V1"));
    }
}
