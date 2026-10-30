//! 远端 ripgrep 封闭任务的命令构造与执行。
//!
//! 内容搜索与文件枚举使用独立 capability，并在实际请求前同批探测所需参数能力。
//! 动态参数只作为经过 shell 转义的数组元素进入固定命令。

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::TaskKind;
use crate::modules::remote::session::{shell_quote, ExecOutput, RemoteWorkspace};

const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const CONTENT_PROBE: &str = "rg --json --no-messages --max-filesize 1 --fixed-strings --word-regexp --ignore-case -- 'TERAX_REMOTE_TASK_OPTION_PROBE' /dev/null >/dev/null 2>&1";
const FILES_PROBE: &str = "rg --files --null --no-messages --max-depth 1 --glob '!TERAX_REMOTE_TASK_OPTION_PROBE' -- /dev/null >/dev/null 2>&1";

/// 执行一次内容搜索，交互式调用可通过 token 关闭当前 SSH channel。
pub(crate) async fn content(
    workspace: &Arc<RemoteWorkspace>,
    args: &[String],
    cancellation: Option<&CancellationToken>,
) -> Result<ExecOutput, String> {
    run(
        workspace,
        TaskKind::RipgrepContent,
        args,
        CONTENT_PROBE,
        cancellation,
    )
    .await
}

/// 执行一次文件枚举，并验证 `--files`、NUL 输出和深度参数能力。
pub(crate) async fn files(
    workspace: &Arc<RemoteWorkspace>,
    args: &[String],
) -> Result<ExecOutput, String> {
    run(workspace, TaskKind::RipgrepFiles, args, FILES_PROBE, None).await
}

async fn run(
    workspace: &Arc<RemoteWorkspace>,
    task: TaskKind,
    args: &[String],
    probe: &str,
    cancellation: Option<&CancellationToken>,
) -> Result<ExecOutput, String> {
    let command = command(args, workspace.tasks.should_probe(task).then_some(probe));
    match cancellation {
        Some(cancellation) => {
            workspace
                .tasks
                .run_cancellable(
                    workspace,
                    task,
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
                .run(workspace, task, &command, None, TIMEOUT, OUTPUT_LIMIT)
                .await
        }
    }
}

fn command(args: &[String], probe: Option<&str>) -> String {
    let command = args
        .iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    match probe {
        Some(probe) => format!(
            "command -v rg >/dev/null 2>&1 || exit 127; {probe}; probe_status=$?; [ \"$probe_status\" -le 1 ] || exit 126; exec {command}"
        ),
        None => format!("exec {command}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{command, CONTENT_PROBE, FILES_PROBE};

    #[test]
    fn commands_probe_required_options_and_quote_dynamic_arguments() {
        let args = vec![
            "rg".into(),
            "--json".into(),
            "a'b".into(),
            "/srv/a b".into(),
        ];
        let content = command(&args, Some(CONTENT_PROBE));
        assert!(content.contains("--max-filesize"));
        assert!(content.contains("'a'\\''b'"));
        assert!(content.contains("'/srv/a b'"));

        let files = command(&args, Some(FILES_PROBE));
        assert!(files.contains("--files --null"));
        assert!(files.contains("exit 126"));

        let cached = command(&args, None);
        assert!(cached.starts_with("exec 'rg'"));
        assert!(!cached.contains("OPTION_PROBE"));
    }
}
