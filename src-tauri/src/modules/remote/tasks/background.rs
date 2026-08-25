//! SSH 后台进程批量查询任务。
//!
//! 日志正文与状态协议使用不同输出流，批量列表只接受 Rust 验证后的数字 PID。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use super::TaskKind;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/background.sh");
const LOGS_MARKER: &[u8] = b"TERAX_BG_LOGS_V1";
const LIST_MARKER: &[u8] = b"TERAX_BG_LIST_V1";
const TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

/// 一次远端日志读取及其进程运行状态。
pub(crate) struct BackgroundLogs {
    pub(crate) bytes: Vec<u8>,
    pub(crate) running: bool,
}

/// 后台任务失败的稳定分类。
#[derive(Debug)]
pub(crate) enum BackgroundTaskError {
    Unsupported(String),
    Business(String),
    Protocol(String),
    Transport(String),
}

/// 一次返回增量日志与运行状态。
pub(crate) async fn read_logs(
    workspace: &Arc<RemoteWorkspace>,
    pid: u32,
    log_path: &str,
    since: u64,
) -> Result<BackgroundLogs, BackgroundTaskError> {
    crate::modules::remote::session::validate_remote_path(log_path)
        .map_err(BackgroundTaskError::Business)?;
    let script = format!(
        "operation=logs; process_id={pid}; log_path={}; start_offset={}; {SOURCE}",
        shell_quote(log_path),
        since.saturating_add(1),
    );
    let output = run(workspace, TaskKind::BackgroundLogs, script).await?;
    match output.exit_code {
        Some(0) => {
            let running =
                parse_logs_status(&output.stderr).map_err(BackgroundTaskError::Protocol)?;
            Ok(BackgroundLogs {
                bytes: output.stdout,
                running,
            })
        }
        Some(72) => Err(BackgroundTaskError::Unsupported("missing tail".into())),
        Some(code) => Err(BackgroundTaskError::Business(format!(
            "remote background log task failed with exit code {code}"
        ))),
        None => Err(BackgroundTaskError::Transport(
            "remote background log task closed without an exit status".into(),
        )),
    }
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
    let output = run(workspace, TaskKind::BackgroundList, script).await?;
    match output.exit_code {
        Some(0) => parse_list(&output.stdout).map_err(BackgroundTaskError::Protocol),
        Some(72) => Err(BackgroundTaskError::Unsupported(
            "remote Bash is unavailable".into(),
        )),
        Some(code) => Err(BackgroundTaskError::Business(format!(
            "remote background list task failed with exit code {code}"
        ))),
        None => Err(BackgroundTaskError::Transport(
            "remote background list task closed without an exit status".into(),
        )),
    }
}

async fn run(
    workspace: &Arc<RemoteWorkspace>,
    task: TaskKind,
    script: String,
) -> Result<crate::modules::remote::session::ExecOutput, BackgroundTaskError> {
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script)
    );
    let output = workspace
        .tasks
        .run(workspace, task, &command, None, TIMEOUT, OUTPUT_LIMIT)
        .await
        .map_err(BackgroundTaskError::Transport)?;
    if output.timed_out {
        Err(BackgroundTaskError::Transport(
            "remote background task timed out".into(),
        ))
    } else {
        Ok(output)
    }
}

fn parse_logs_status(bytes: &[u8]) -> Result<bool, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(LOGS_MARKER) {
        return Err("background logs marker is invalid".into());
    }
    match fields.next().unwrap_or_default() {
        b"running" => Ok(true),
        b"exited" => Ok(false),
        _ => Err("background logs state is invalid".into()),
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
    use super::{parse_list, parse_logs_status};

    #[test]
    fn parses_separate_log_status() {
        assert!(parse_logs_status(b"TERAX_BG_LOGS_V1\0running\0").unwrap());
        assert!(!parse_logs_status(b"TERAX_BG_LOGS_V1\0exited\0").unwrap());
    }

    #[test]
    fn parses_batched_pid_statuses() {
        let statuses = parse_list(b"TERAX_BG_LIST_V1\x0010\0running\x0020\0exited\0END\0").unwrap();
        assert_eq!(statuses.get(&10), Some(&true));
        assert_eq!(statuses.get(&20), Some(&false));
    }
}
