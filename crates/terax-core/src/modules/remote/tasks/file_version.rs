//! Bash 文件版本任务的协议适配。
//!
//! 本模块只负责构造封闭命令和解析固定响应；Bash/SFTP 选择及业务日志由文件服务决定。

use std::sync::Arc;
use std::time::Duration;

use super::{TaskKind, TASK_OUTPUT_LIMIT};
use crate::modules::remote::file_service::RemoteVersion;
use crate::modules::remote::session::{shell_quote, validate_remote_path, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/file_version.sh");
const MARKER: &[u8] = b"TERAX_FILE_VERSION_V1";
const TIMEOUT: Duration = Duration::from_secs(60);

/// 文件版本任务无法完成的稳定分类。
#[derive(Debug)]
pub(crate) enum FileVersionTaskError {
    Unsupported(String),
    Business(String),
    Protocol(String),
    Transport(String),
}

/// 在一次远端 Bash 调用中读取稳定文件版本。
pub(crate) async fn read(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    max_size: u64,
) -> Result<Option<RemoteVersion>, FileVersionTaskError> {
    validate_remote_path(path).map_err(FileVersionTaskError::Business)?;
    if !path.starts_with('/') {
        return Err(FileVersionTaskError::Business(
            "remote file version requires an absolute path".into(),
        ));
    }
    let script = format!(
        "target_path={}; max_size={max_size}; probe_features={}; {SOURCE}",
        shell_quote(path),
        usize::from(workspace.tasks.should_probe(TaskKind::FileVersion)),
    );
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script)
    );
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::FileVersion,
            &command,
            None,
            TIMEOUT,
            TASK_OUTPUT_LIMIT,
        )
        .await
        .map_err(FileVersionTaskError::Transport)?;
    if output.timed_out {
        return Err(FileVersionTaskError::Transport(
            "remote file version task timed out".into(),
        ));
    }
    match output.exit_code {
        Some(0) => parse(&output.stdout, max_size).map_err(|error| {
            if error.starts_with("remote file exceeds version limit") {
                FileVersionTaskError::Business(error)
            } else {
                FileVersionTaskError::Protocol(error)
            }
        }),
        Some(72) => Err(FileVersionTaskError::Unsupported(
            "missing required stat, readlink, or SHA-256 capability".into(),
        )),
        Some(75) => Err(FileVersionTaskError::Business(
            "remote file changed while computing its revision".into(),
        )),
        Some(code) => Err(FileVersionTaskError::Business(format!(
            "remote file version task failed with exit code {code}"
        ))),
        None => Err(FileVersionTaskError::Transport(
            "remote file version task closed without an exit status".into(),
        )),
    }
}

fn parse(bytes: &[u8], max_size: u64) -> Result<Option<RemoteVersion>, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(MARKER) {
        return Err("file version task marker is invalid".into());
    }
    match fields.next().unwrap_or_default() {
        b"missing" => Ok(None),
        b"toolarge" => {
            let size = parse_u64(fields.next(), "size")?;
            Err(format!(
                "remote file exceeds version limit: {max_size} (size {size})"
            ))
        }
        b"version" => {
            let revision = std::str::from_utf8(fields.next().unwrap_or_default())
                .map_err(|_| "file version revision is not UTF-8".to_string())?
                .to_ascii_lowercase();
            if revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("file version revision is invalid".into());
            }
            let size = parse_u64(fields.next(), "size")?;
            let mtime = parse_u64(fields.next(), "mtime")?.saturating_mul(1000);
            if fields.next().is_some_and(|field| !field.is_empty()) {
                return Err("file version response has trailing fields".into());
            }
            Ok(Some(RemoteVersion {
                revision,
                size,
                mtime,
            }))
        }
        _ => Err("file version task status is invalid".into()),
    }
}

fn parse_u64(field: Option<&[u8]>, name: &str) -> Result<u64, String> {
    std::str::from_utf8(field.unwrap_or_default())
        .map_err(|_| format!("file version {name} is not UTF-8"))?
        .parse()
        .map_err(|_| format!("file version {name} is invalid"))
}

#[cfg(test)]
mod tests {
    use super::{parse, SOURCE};

    #[test]
    fn parses_missing_and_stable_versions() {
        assert!(parse(b"TERAX_FILE_VERSION_V1\0missing\0", 1024)
            .unwrap()
            .is_none());
        let response = format!(
            "TERAX_FILE_VERSION_V1\0version\0{}\x0012\x0017\x00",
            "a".repeat(64)
        );
        let version = parse(response.as_bytes(), 1024).unwrap().unwrap();
        assert_eq!(version.size, 12);
        assert_eq!(version.mtime, 17_000);
    }

    #[test]
    fn reports_too_large_files() {
        let error = parse(b"TERAX_FILE_VERSION_V1\0toolarge\x002048\0", 1024).unwrap_err();
        assert!(error.contains("1024"));
        assert!(error.contains("2048"));
    }

    #[test]
    fn script_checks_path_identity_and_alternate_hash_providers() {
        assert!(SOURCE.contains("%d:%i:%s:%y:%z"));
        assert!(SOURCE.contains("shasum -a 256"));
        assert!(SOURCE.contains("openssl dgst -sha256 -r"));
    }
}
