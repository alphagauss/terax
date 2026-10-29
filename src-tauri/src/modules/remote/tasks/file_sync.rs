//! 一次 SSH 封闭任务完成元数据检查和分块摘要，正文由现有 SFTP 流水线传输。

use std::sync::Arc;
use std::time::Duration;

use super::TaskKind;
use crate::modules::fs::sync::{FileCheckpoint, FileProbe, BLOCK_SIZE};
use crate::modules::remote::session::{shell_quote, validate_remote_path, RemoteWorkspace};

const SOURCE: &str = include_str!("scripts/file_sync.sh");

/// 缺少能力时由调用方继续走已有 SFTP 读取；业务与传输错误不隐藏为能力缺失。
pub(crate) async fn probe(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    previous: Option<&FileCheckpoint>,
    limit: u64,
    verify: bool,
) -> Result<Option<FileProbe>, String> {
    validate_remote_path(path)?;
    if !path.starts_with('/') {
        return Err("file synchronization requires an absolute path".into());
    }
    if !workspace.tasks.should_attempt(TaskKind::FileSync) {
        return Ok(None);
    }
    let script = format!("target_path={}; max_size={limit}; block_size={BLOCK_SIZE}; previous_size={}; previous_mtime={}; verify={}; {SOURCE}",
        shell_quote(path), previous.map_or(u64::MAX, |value| value.size), previous.map_or(u64::MAX, |value| value.mtime / 1000), usize::from(verify));
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(&script)
    );
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::FileSync,
            &command,
            None,
            Duration::from_secs(60),
            32 * 1024,
        )
        .await?;
    if output.exit_code == Some(72) {
        workspace.mark_task_unavailable(
            TaskKind::FileSync,
            "missing file synchronization dependencies",
        );
        return Ok(None);
    }
    if output.timed_out || output.truncated || output.exit_code != Some(0) {
        return Err("remote file synchronization check failed".into());
    }
    let result = parse(&output.stdout, previous, limit)?;
    workspace.tasks.mark_available(TaskKind::FileSync);
    Ok(Some(result))
}

fn parse(bytes: &[u8], previous: Option<&FileCheckpoint>, limit: u64) -> Result<FileProbe, String> {
    let values = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let text = |index: usize| -> Result<&str, String> {
        std::str::from_utf8(values.get(index).copied().unwrap_or_default())
            .map_err(|_| "invalid file sync response".into())
    };
    let number = |index| -> Result<u64, String> {
        text(index)?
            .parse()
            .map_err(|_| "invalid file sync metadata".into())
    };
    if text(0)? != "TERAX_FILE_SYNC_V1" || values.last() != Some(&&b""[..]) {
        return Err("invalid file sync marker".into());
    }
    match text(1)? {
        "missing" if values.len() == 3 => Ok(FileProbe::Missing),
        "toolarge" if values.len() == 5 => Ok(FileProbe::TooLarge {
            size: number(2)?,
            mtime: number(3)?.saturating_mul(1000),
        }),
        "unchanged" if values.len() == 5 => {
            let mut checkpoint = previous
                .ok_or("file sync response has no checkpoint")?
                .clone();
            if checkpoint.size != number(2)? || checkpoint.mtime / 1000 != number(3)? {
                return Err("file sync metadata mismatch".into());
            }
            checkpoint.mtime = number(3)?.saturating_mul(1000);
            Ok(FileProbe::Unchanged(checkpoint))
        }
        "changed" => {
            let size = number(2)?;
            if size > limit || values.len() != 6 + size.div_ceil(BLOCK_SIZE as u64) as usize {
                return Err("invalid file sync block count".into());
            }
            let checkpoint = FileCheckpoint {
                size,
                mtime: number(3)?.saturating_mul(1000),
                revision: text(4)?.to_string(),
                blocks: values[5..values.len() - 1]
                    .iter()
                    .map(|value| String::from_utf8_lossy(value).into_owned())
                    .collect(),
            };
            Ok(FileProbe::Changed(checkpoint))
        }
        _ => Err("invalid file sync status".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_or_unbounded_manifests_and_checks_unchanged_checkpoint() {
        assert!(parse(b"TERAX_FILE_SYNC_V1\0changed\0", None, 1024).is_err());
        assert!(parse(
            b"TERAX_FILE_SYNC_V1\0changed\x002048\x001\0digest\0",
            None,
            1024
        )
        .is_err());
        assert!(parse(b"TERAX_FILE_SYNC_V1\0unchanged\x0012\x001\0", None, 1024).is_err());
        let checkpoint = FileCheckpoint {
            size: 12,
            mtime: 1000,
            revision: "a".repeat(64),
            blocks: vec!["b".repeat(64)],
        };
        assert!(matches!(
            parse(
                b"TERAX_FILE_SYNC_V1\0unchanged\x0012\x001\0",
                Some(&checkpoint),
                1024
            )
            .unwrap(),
            FileProbe::Unchanged(_)
        ));
        assert!(parse(
            b"TERAX_FILE_SYNC_V1\0unchanged\x0013\x001\0",
            Some(&checkpoint),
            1024
        )
        .is_err());
        assert!(parse(b"TERAX_FILE_SYNC_V1\0missing\0extra\0", None, 1024).is_err());
        let response = format!(
            "TERAX_FILE_SYNC_V1\0changed\x0012\x001\0{}\0{}\0",
            "a".repeat(64),
            "b".repeat(64)
        );
        assert!(matches!(
            parse(response.as_bytes(), None, 1024).unwrap(),
            FileProbe::Changed(_)
        ));
    }
}
