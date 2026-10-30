//! Bash 目录创建任务的封闭协议适配。
//!
//! 任务只接受绝对路径，保留目标已存在错误，并且不会在结果不明确时自行重试。

use std::sync::Arc;
use std::time::Duration;

use super::{TaskKind, TASK_OUTPUT_LIMIT};
use crate::modules::remote::session::{shell_quote, validate_remote_path, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/create_directory.sh");
const MARKER: &[u8] = b"TERAX_CREATE_DIR_V1";
const TIMEOUT: Duration = Duration::from_secs(30);

/// 目录创建任务成功后的业务状态。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CreateDirectoryOutcome {
    Created,
    Exists,
}

/// 目录创建任务失败的稳定分类。
#[derive(Debug)]
pub(crate) enum CreateDirectoryTaskError {
    Unsupported(String),
    Business(String),
    Protocol(String),
    Transport(String),
}

/// 在一次远端 Bash 调用中创建目录及其缺失父链。
pub(crate) async fn create(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<CreateDirectoryOutcome, CreateDirectoryTaskError> {
    validate_remote_path(path).map_err(CreateDirectoryTaskError::Business)?;
    let target = path.trim_end_matches('/');
    if !target.starts_with('/') || target.is_empty() {
        return Err(CreateDirectoryTaskError::Business(
            "remote directory requires a safe absolute path".into(),
        ));
    }
    let script = format!(
        "target_path={}; probe_features={}; {SOURCE}",
        shell_quote(target),
        usize::from(workspace.tasks.should_probe(TaskKind::CreateDirectory)),
    );
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script)
    );
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::CreateDirectory,
            &command,
            None,
            TIMEOUT,
            TASK_OUTPUT_LIMIT,
        )
        .await
        .map_err(CreateDirectoryTaskError::Transport)?;
    if output.timed_out {
        return Err(CreateDirectoryTaskError::Transport(
            "remote directory creation timed out".into(),
        ));
    }
    match output.exit_code {
        Some(0) => parse(&output.stdout).map_err(CreateDirectoryTaskError::Protocol),
        Some(72) => Err(CreateDirectoryTaskError::Unsupported(
            "missing mkdir or readlink".into(),
        )),
        Some(64) => Err(CreateDirectoryTaskError::Business(
            "invalid remote directory path".into(),
        )),
        Some(code) => Err(CreateDirectoryTaskError::Business(format!(
            "remote directory creation failed with exit code {code}"
        ))),
        None => Err(CreateDirectoryTaskError::Transport(
            "remote directory creation closed without an exit status".into(),
        )),
    }
}

fn parse(bytes: &[u8]) -> Result<CreateDirectoryOutcome, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(MARKER) {
        return Err("create directory task marker is invalid".into());
    }
    match fields.next().unwrap_or_default() {
        b"created" => Ok(CreateDirectoryOutcome::Created),
        b"exists" => Ok(CreateDirectoryOutcome::Exists),
        _ => Err("create directory task status is invalid".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse, CreateDirectoryOutcome};

    #[test]
    fn parses_created_and_existing_results() {
        assert_eq!(
            parse(b"TERAX_CREATE_DIR_V1\0created\0/srv/repo/new\0").unwrap(),
            CreateDirectoryOutcome::Created
        );
        assert_eq!(
            parse(b"TERAX_CREATE_DIR_V1\0exists\0").unwrap(),
            CreateDirectoryOutcome::Exists
        );
    }
}
