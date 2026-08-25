//! 远端树枚举任务的固定脚本执行入口。
//!
//! 本模块封闭脚本来源和动态标量，调用方只接收有界输出并负责业务协议解析。

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::TaskKind;
use crate::modules::remote::session::{shell_quote, ExecOutput, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/tree_list.sh");
const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

/// 执行一次树枚举，交互式搜索可传入取消 token。
pub(crate) async fn run(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    show_hidden: bool,
    max_depth: usize,
    cancellation: Option<&CancellationToken>,
) -> Result<ExecOutput, String> {
    let command = command(
        root,
        show_hidden,
        max_depth,
        workspace.tasks.should_probe(TaskKind::TreeList),
    );
    match cancellation {
        Some(cancellation) => {
            workspace
                .tasks
                .run_cancellable(
                    workspace,
                    TaskKind::TreeList,
                    &command,
                    TIMEOUT,
                    OUTPUT_LIMIT,
                    cancellation,
                )
                .await
        }
        None => {
            workspace
                .tasks
                .run(
                    workspace,
                    TaskKind::TreeList,
                    &command,
                    None,
                    TIMEOUT,
                    OUTPUT_LIMIT,
                )
                .await
        }
    }
}

fn command(root: &str, show_hidden: bool, max_depth: usize, probe_features: bool) -> String {
    let script = format!(
        "target_path={}; show_hidden={}; max_depth={}; probe_features={}; {SOURCE}",
        shell_quote(root),
        usize::from(show_hidden),
        max_depth,
        usize::from(probe_features),
    );
    format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script)
    )
}

#[cfg(test)]
mod tests {
    use super::command;

    #[test]
    fn command_quotes_paths_and_uses_fixed_script() {
        let command = command("/srv/a b'c", false, 8, true);
        assert!(command.starts_with("command -v bash"));
        assert!(command.contains("max_depth=8"));
        assert!(command.contains("probe_features=1"));
        assert!(command.contains("TERAX_TREE_LIST_V1"));
    }
}
