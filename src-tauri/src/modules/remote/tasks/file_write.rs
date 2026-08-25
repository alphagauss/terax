//! 不落盘 Bash 文件写入任务的 SSH 协议适配。
//!
//! 每次调用在独立 session channel 中执行仓库内嵌脚本，参数经过 shell 转义，正文
//! 通过 stdin 原样传输。模块不决定 SFTP 回退，只报告目标是否可能已经提交。

use std::sync::Arc;
use std::time::Duration;

use super::{TaskKind, TaskRunError};
use crate::modules::remote::file_service::{
    RemoteCheckedWrite, RemoteObservedVersion, RemoteVersion,
};
use crate::modules::remote::session::{
    shell_quote, validate_remote_path, ExecOutput, RemoteWorkspace,
};

const HELPER_SOURCE: &str = include_str!("scripts/file_write.sh");
const PROTOCOL_MARKER: &[u8] = b"TERAX_SHELL_FILE_V1";
const MAX_BODY_BYTES: usize = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024;
const HELPER_TIMEOUT: Duration = Duration::from_secs(60);

/// Bash 文件写入任务失败及失败时目标是否可能已经提交。
#[derive(Debug)]
pub(crate) struct FileWriteTaskError {
    pub(crate) may_have_committed: bool,
    pub(crate) disable_backend: bool,
}

#[derive(Debug)]
struct HelperResponse {
    status: String,
    size: u64,
    mtime: u64,
}

/// 通过 Bash 任务按已确认版本提交远端文件。
pub(crate) async fn write_checked(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    expected: &RemoteVersion,
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, FileWriteTaskError> {
    write(
        workspace,
        TaskKind::FileWriteChecked,
        "write_checked",
        path,
        content,
        Some(expected),
        replacement_revision,
    )
    .await
}

/// 通过 Bash 任务仅在目标缺失时创建远端文件。
pub(crate) async fn write_missing(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, FileWriteTaskError> {
    write(
        workspace,
        TaskKind::FileWriteMissing,
        "write_missing",
        path,
        content,
        None,
        replacement_revision,
    )
    .await
}

/// 通过 Bash 任务无条件覆盖远端文件。
pub(crate) async fn write_overwrite(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, FileWriteTaskError> {
    write(
        workspace,
        TaskKind::FileWriteOverwrite,
        "write_overwrite",
        path,
        content,
        None,
        replacement_revision,
    )
    .await
}

async fn write(
    workspace: &Arc<RemoteWorkspace>,
    task: TaskKind,
    operation: &str,
    path: &str,
    content: &[u8],
    expected: Option<&RemoteVersion>,
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, FileWriteTaskError> {
    validate_request(path, content, expected, replacement_revision)?;
    let response = execute(
        workspace,
        helper_command(
            operation,
            path,
            expected,
            replacement_revision,
            content.len(),
            workspace.tasks.should_probe(task),
        ),
        content.to_vec(),
        task,
    )
    .await?;
    match response.status.as_str() {
        "written" => {
            if response.size != content.len() as u64 {
                return Err(protocol_error());
            }
            Ok(RemoteCheckedWrite::Written {
                mtime: response.mtime,
            })
        }
        "conflict" if operation != "write_overwrite" => Ok(RemoteCheckedWrite::Conflict {
            current: Some(RemoteObservedVersion {
                size: response.size,
                mtime: response.mtime,
            }),
        }),
        _ => Err(protocol_error()),
    }
}

/// 在一个 SSH channel 上执行一次 Bash 文件写入请求。
async fn execute(
    workspace: &Arc<RemoteWorkspace>,
    command: String,
    input: Vec<u8>,
    task: TaskKind,
) -> Result<HelperResponse, FileWriteTaskError> {
    let output = workspace
        .tasks
        .run_classified(
            workspace,
            task,
            &command,
            Some(input),
            HELPER_TIMEOUT,
            MAX_RESPONSE_BYTES,
        )
        .await
        .map_err(|error| FileWriteTaskError {
            may_have_committed: matches!(error, TaskRunError::AfterDispatch(_)),
            disable_backend: false,
        })?;
    let response = decode_output(output)?;
    workspace.tasks.mark_available(task);
    Ok(response)
}

fn decode_output(output: ExecOutput) -> Result<HelperResponse, FileWriteTaskError> {
    if output.timed_out || output.truncated || output.exit_code != Some(0) {
        let rejected_before_commit = matches!(output.exit_code, Some(64 | 72 | 73 | 76));
        let disable_backend = matches!(output.exit_code, Some(64 | 72 | 73));
        return Err(FileWriteTaskError {
            may_have_committed: !rejected_before_commit,
            disable_backend,
        });
    }
    decode_response(&output.stdout).map_err(|_| protocol_error())
}

/// 构造只包含固定操作和已转义参数的远端命令。
fn helper_command(
    operation: &str,
    path: &str,
    expected: Option<&RemoteVersion>,
    replacement_revision: &str,
    replacement_size: usize,
    probe_features: bool,
) -> String {
    let expected_revision = expected
        .map(|value| value.revision.to_ascii_lowercase())
        .unwrap_or_default();
    let replacement_revision = replacement_revision.to_ascii_lowercase();
    format!(
        "operation={operation}; target_path={path}; expected_revision={expected_revision}; expected_size={expected_size}; replacement_revision={replacement_revision}; replacement_size={replacement_size}; probe_features={probe_features}; {HELPER_SOURCE}",
        operation = shell_quote(operation),
        path = shell_quote(path),
        expected_revision = shell_quote(&expected_revision),
        expected_size = expected.map(|value| value.size).unwrap_or(0),
        replacement_revision = shell_quote(&replacement_revision),
        probe_features = usize::from(probe_features),
    )
}

fn validate_request(
    path: &str,
    content: &[u8],
    expected: Option<&RemoteVersion>,
    replacement_revision: &str,
) -> Result<(), FileWriteTaskError> {
    validate_remote_path(path).map_err(|_| request_error())?;
    if !path.starts_with('/')
        || path.chars().any(char::is_control)
        || content.len() > MAX_BODY_BYTES
        || !is_sha256(replacement_revision)
        || expected
            .is_some_and(|value| value.size > MAX_BODY_BYTES as u64 || !is_sha256(&value.revision))
    {
        return Err(request_error());
    }
    Ok(())
}

fn decode_response(bytes: &[u8]) -> Result<HelperResponse, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(PROTOCOL_MARKER) {
        return Err("helper response marker is invalid".into());
    }
    let status = std::str::from_utf8(fields.next().unwrap_or_default())
        .map_err(|_| "helper response status is not UTF-8")?
        .to_string();
    let size = parse_u64(fields.next(), "size")?;
    let mtime = parse_u64(fields.next(), "mtime")?.saturating_mul(1000);
    if fields.next().is_some() {
        return Err("helper response has trailing fields".into());
    }
    Ok(HelperResponse {
        status,
        size,
        mtime,
    })
}

fn parse_u64(field: Option<&[u8]>, name: &str) -> Result<u64, String> {
    std::str::from_utf8(field.unwrap_or_default())
        .map_err(|_| format!("helper response {name} is not UTF-8"))?
        .parse()
        .map_err(|_| format!("helper response {name} is invalid"))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn protocol_error() -> FileWriteTaskError {
    FileWriteTaskError {
        may_have_committed: true,
        disable_backend: true,
    }
}

fn request_error() -> FileWriteTaskError {
    FileWriteTaskError {
        may_have_committed: false,
        disable_backend: false,
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_output, decode_response, helper_command, validate_request, HELPER_SOURCE};
    use crate::modules::remote::file_service::RemoteVersion;
    use crate::modules::remote::session::ExecOutput;

    #[test]
    fn command_quotes_path_and_keeps_body_out_of_the_command() {
        let expected = RemoteVersion {
            revision: "A".repeat(64),
            size: 4,
            mtime: 0,
        };
        let command = helper_command(
            "write_checked",
            "/tmp/it's here",
            Some(&expected),
            &"B".repeat(64),
            4,
            true,
        );

        assert!(command.contains("target_path='/tmp/it'\\''s here'"));
        assert!(command.contains(&format!("expected_revision='{}'", "a".repeat(64))));
        assert!(command.contains(&format!("replacement_revision='{}'", "b".repeat(64))));
        assert!(command.contains("expected_size=4"));
        assert!(command.contains("probe_features=1"));
        assert!(!command.contains("body"));
    }

    #[test]
    fn response_parser_accepts_only_the_fixed_frame() {
        let response = decode_response(b"TERAX_SHELL_FILE_V1\0written\x004\x00123").unwrap();
        assert_eq!(response.status, "written");
        assert_eq!(response.size, 4);
        assert_eq!(response.mtime, 123_000);

        assert!(decode_response(b"wrong\0written\x004\x00123").is_err());
        assert!(decode_response(b"TERAX_SHELL_FILE_V1\0written\x004\x00123\0extra").is_err());
    }

    #[test]
    fn request_validation_rejects_relative_paths_and_invalid_revisions() {
        assert!(validate_request("tmp/a", b"data", None, &"a".repeat(64)).is_err());
        assert!(validate_request("/tmp/a", b"data", None, "invalid").is_err());
    }

    #[test]
    fn explicit_capability_rejection_is_safe_to_fall_back() {
        let unsupported = decode_output(ExecOutput {
            exit_code: Some(72),
            ..ExecOutput::default()
        })
        .unwrap_err();
        assert!(!unsupported.may_have_committed);
        assert!(unsupported.disable_backend);

        let path_conflict = decode_output(ExecOutput {
            exit_code: Some(76),
            ..ExecOutput::default()
        })
        .unwrap_err();
        assert!(!path_conflict.may_have_committed);
        assert!(!path_conflict.disable_backend);

        let ambiguous = decode_output(ExecOutput {
            exit_code: Some(74),
            ..ExecOutput::default()
        })
        .unwrap_err();
        assert!(ambiguous.may_have_committed);
        assert!(!ambiguous.disable_backend);
    }

    #[test]
    fn script_probes_nonportable_commit_features_before_writing() {
        assert!(HELPER_SOURCE.contains("conv=fsync"));
        assert!(HELPER_SOURCE.contains("mv -T"));
        assert!(HELPER_SOURCE.contains("ln -T"));
        assert!(HELPER_SOURCE.contains("shasum -a 256"));
        assert!(HELPER_SOURCE.contains("openssl dgst -sha256 -r"));
        assert!(HELPER_SOURCE.contains("probe_features"));
    }
}
