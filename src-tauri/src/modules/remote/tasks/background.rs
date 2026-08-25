//! SSH 后台进程批量状态查询任务。
//!
//! 日志正文固定使用 raw SFTP offset 读取；本任务只接受 Rust 验证后的数字 PID，避免
//! 多个后台进程将高延迟 exec 往返线性放大。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use super::TaskKind;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/background.sh");
const LIST_MARKER: &[u8] = b"TERAX_BG_LIST_V1";
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_OUTPUT_LIMIT: usize = 256 * 1024;

/// 后台任务失败的稳定分类。
#[derive(Debug)]
pub(crate) enum BackgroundTaskError {
    Unsupported(String),
    Business(String),
    Protocol(String),
    Transport(String),
}

/// 一次检查同一 SSH profile 下的全部后台 PID。
pub(crate) async fn list_running(
    workspace: &Arc<RemoteWorkspace>,
    pids: &[u32],
) -> Result<HashMap<u32, bool>, BackgroundTaskError> {
    if pids.is_empty() {
        return Ok(HashMap::new());
    }
    let values = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "operation=list; process_ids={}; {SOURCE}",
        shell_quote(&values)
    );
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script)
    );
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::BackgroundList,
            &command,
            None,
            LIST_TIMEOUT,
            LIST_OUTPUT_LIMIT,
        )
        .await
        .map_err(BackgroundTaskError::Transport)?;
    if output.timed_out {
        return Err(BackgroundTaskError::Transport(
            "remote background list task timed out".into(),
        ));
    }
    match output.exit_code {
        Some(0) => parse_list(&output.stdout).map_err(BackgroundTaskError::Protocol),
        Some(72) => Err(BackgroundTaskError::Unsupported(
            "remote Bash is unavailable".into(),
        )),
        Some(code) => Err(BackgroundTaskError::Business(format!(
            "remote background list task failed with exit code {code}"
        ))),
        None => parse_list(&output.stdout).map_err(|_| {
            BackgroundTaskError::Transport(
                "remote background list task closed without an exit status".into(),
            )
        }),
    }
}

fn parse_list(bytes: &[u8]) -> Result<HashMap<u32, bool>, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(LIST_MARKER) {
        return Err("background list marker is invalid".into());
    }
    let mut statuses = HashMap::new();
    loop {
        let pid = fields.next().unwrap_or_default();
        if pid == b"END" {
            return Ok(statuses);
        }
        let pid = std::str::from_utf8(pid)
            .map_err(|_| "background list PID is not UTF-8".to_string())?
            .parse::<u32>()
            .map_err(|_| "background list PID is invalid".to_string())?;
        let running = match fields.next().unwrap_or_default() {
            b"running" => true,
            b"exited" => false,
            _ => return Err("background list state is invalid".into()),
        };
        statuses.insert(pid, running);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_list, SOURCE};

    #[test]
    fn parses_batched_pid_statuses() {
        let statuses = parse_list(b"TERAX_BG_LIST_V1\x0010\0running\x0020\0exited\0END\0").unwrap();
        assert_eq!(statuses.get(&10), Some(&true));
        assert_eq!(statuses.get(&20), Some(&false));
    }

    #[test]
    fn script_only_emits_the_batched_status_protocol() {
        assert!(SOURCE.contains("TERAX_BG_LIST_V1"));
        assert!(!SOURCE.contains("TERAX_BG_LOGS_V1"));
    }
}
