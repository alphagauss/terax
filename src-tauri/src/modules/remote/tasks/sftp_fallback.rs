//! SFTP 写入回退所需的固定远端提交任务。
//!
//! SFTP v3 负责临时文件传输，本模块集中执行摘要、原子发布和提交状态协议，避免
//! `sftp.rs` 继续维护 Bash 命令与依赖分支。

use std::sync::Arc;
use std::time::Duration;

use crate::modules::remote::file_service::RemoteObservedVersion;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

use super::TaskKind;

/// SFTP 条件提交的归一化结果。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RemoteCommit {
    Complete(Option<RemoteObservedVersion>),
    Missing,
    Conflict(Option<RemoteObservedVersion>),
}

/// 在预开 channel 上替换目标，并返回同一进程观察到的最终元数据。
pub(crate) async fn replace(
    workspace: &Arc<RemoteWorkspace>,
    channel: russh::Channel<russh::client::Msg>,
    temporary: &str,
    target: &str,
) -> Result<Option<RemoteObservedVersion>, String> {
    ensure_available(workspace)?;
    let command = format!(
        "command -v mv >/dev/null 2>&1 && command -v stat >/dev/null 2>&1 || exit 72; \
         target={target}; mv -f -- {temporary} \"$target\" || exit 74; \
         metadata=$(stat -c '%s %Y' -- \"$target\" 2>/dev/null) || metadata=; printf '%s' \"$metadata\"",
        temporary = shell_quote(temporary),
        target = shell_quote(target),
    );
    let output = workspace
        .exec_on_channel(channel, &command, None, Duration::from_secs(15))
        .await?;
    if output.exit_code == Some(72) {
        disable(workspace, "missing mv or stat");
        return Err("remote SFTP commit dependencies are unavailable".into());
    }
    if output.timed_out || output.exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if output.timed_out {
            format!("timed out replacing remote file {target}")
        } else if detail.is_empty() {
            format!("replace remote file {target} failed")
        } else {
            format!("replace remote file {target} failed: {detail}")
        });
    }
    workspace.tasks.mark_available(TaskKind::SftpCommit);
    Ok(parse_remote_observed(&output.stdout))
}

/// 使用服务器已有的受支持工具计算 SHA-256。
pub(crate) async fn sha256(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<String, String> {
    ensure_available(workspace)?;
    let path = shell_quote(path);
    let command = format!(
        "if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {path}; \
         elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {path}; \
         elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r {path}; \
         else exit 72; fi"
    );
    let output = workspace
        .exec(&command, None, Duration::from_secs(60))
        .await?;
    if output.exit_code == Some(72) {
        disable(workspace, "missing SHA-256 provider");
        return Err("remote SHA-256 command failed or is unavailable".into());
    }
    if output.timed_out || output.exit_code != Some(0) {
        return Err("remote SHA-256 command failed or is unavailable".into());
    }
    workspace.tasks.mark_available(TaskKind::SftpCommit);
    parse_sha256(&output.stdout)
}

/// 按 expected revision 原子提交 SFTP 临时文件。
pub(crate) async fn commit_checked(
    workspace: &Arc<RemoteWorkspace>,
    channel: russh::Channel<russh::client::Msg>,
    temporary: &str,
    target: &str,
    expected_revision: &str,
    replacement_revision: &str,
) -> Result<RemoteCommit, String> {
    ensure_available(workspace)?;
    let command =
        checked_commit_command(temporary, target, expected_revision, replacement_revision);
    let output = workspace
        .exec_on_channel(channel, &command, None, Duration::from_secs(60))
        .await?;
    if output.exit_code == Some(72) {
        disable(workspace, "missing checked commit dependencies");
        return Err("remote checked replace dependencies are unavailable".into());
    }
    if output.timed_out || output.exit_code != Some(0) {
        return Err("remote checked replace failed".into());
    }
    workspace.tasks.mark_available(TaskKind::SftpCommit);
    parse_remote_commit(&output.stdout)
        .map_err(|_| "remote checked replace returned an invalid status".into())
}

/// 仅在目标仍缺失时原子发布 SFTP 临时文件。
pub(crate) async fn commit_missing(
    workspace: &Arc<RemoteWorkspace>,
    channel: russh::Channel<russh::client::Msg>,
    temporary: &str,
    target: &str,
) -> Result<RemoteCommit, String> {
    ensure_available(workspace)?;
    let output = workspace
        .exec_on_channel(
            channel,
            &missing_commit_command(temporary, target),
            None,
            Duration::from_secs(60),
        )
        .await?;
    if output.exit_code == Some(72) {
        disable(workspace, "missing no-clobber commit dependencies");
        return Err("remote missing-only write dependencies are unavailable".into());
    }
    if output.timed_out || output.exit_code != Some(0) {
        return Err("remote missing-only write failed".into());
    }
    workspace.tasks.mark_available(TaskKind::SftpCommit);
    match parse_remote_commit(&output.stdout) {
        Ok(RemoteCommit::Complete(observed)) => Ok(RemoteCommit::Complete(observed)),
        Ok(RemoteCommit::Conflict(observed)) => Ok(RemoteCommit::Conflict(observed)),
        _ => Err("remote missing-only write returned an invalid status".into()),
    }
}

fn parse_sha256(output: &[u8]) -> Result<String, String> {
    let output = String::from_utf8_lossy(output);
    let revision = output
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "remote SHA-256 output is invalid".to_string())?;
    Ok(revision.to_ascii_lowercase())
}

fn ensure_available(workspace: &RemoteWorkspace) -> Result<(), String> {
    if workspace.tasks.should_attempt(TaskKind::SftpCommit) {
        Ok(())
    } else {
        Err("remote SFTP commit task is unavailable".into())
    }
}

fn disable(workspace: &RemoteWorkspace, reason: &str) {
    workspace
        .tasks
        .mark_unavailable(TaskKind::SftpCommit, reason);
}

fn parse_remote_commit(output: &[u8]) -> Result<RemoteCommit, String> {
    let mut fields = output.splitn(2, |byte| *byte == 0);
    let status = std::str::from_utf8(fields.next().unwrap_or_default())
        .map_err(|_| "remote commit status is not UTF-8")?
        .trim();
    let observed = fields.next().and_then(parse_remote_observed);
    match status {
        "written" | "converged" => Ok(RemoteCommit::Complete(observed)),
        "missing" => Ok(RemoteCommit::Missing),
        "conflict" => Ok(RemoteCommit::Conflict(observed)),
        _ => Err("unknown remote commit status".into()),
    }
}

fn parse_remote_observed(output: &[u8]) -> Option<RemoteObservedVersion> {
    let output = std::str::from_utf8(output).ok()?;
    let mut fields = output.split_whitespace();
    let size = fields.next()?.parse().ok()?;
    let mtime_seconds: u64 = fields.next()?.parse().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some(RemoteObservedVersion {
        size,
        mtime: mtime_seconds.saturating_mul(1000),
    })
}

fn missing_commit_command(temporary: &str, target: &str) -> String {
    format!(
        "for tool in ln stat rm; do command -v \"$tool\" >/dev/null 2>&1 || exit 72; done; \
         target={target}; temporary={temporary}; \
         report() {{ metadata=$(stat -c '%s %Y' -- \"$target\" 2>/dev/null) || metadata=; printf '%s\\000%s' \"$1\" \"$metadata\"; }}; \
         if [ -e \"$target\" ] || [ -L \"$target\" ]; then rm -f -- \"$temporary\"; report conflict; \
         elif ln -- \"$temporary\" \"$target\" 2>/dev/null; then rm -f -- \"$temporary\"; report written; \
         elif [ -e \"$target\" ] || [ -L \"$target\" ]; then rm -f -- \"$temporary\"; report conflict; \
         else rm -f -- \"$temporary\"; exit 74; fi",
        target = shell_quote(target),
        temporary = shell_quote(temporary),
    )
}

fn checked_commit_command(
    temporary: &str,
    target: &str,
    expected_revision: &str,
    replacement_revision: &str,
) -> String {
    format!(
        "for tool in stat rm mv; do command -v \"$tool\" >/dev/null 2>&1 || exit 72; done; \
         target={target}; temporary={temporary}; expected={expected}; replacement={replacement}; \
         report() {{ metadata=$(stat -c '%s %Y' -- \"$target\" 2>/dev/null) || metadata=; printf '%s\\000%s' \"$1\" \"$metadata\"; }}; \
         if [ ! -f \"$target\" ]; then rm -f -- \"$temporary\"; printf 'missing'; exit 0; fi; \
         if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum -- \"$target\") || exit 73; \
         elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 -- \"$target\") || exit 73; \
         elif command -v openssl >/dev/null 2>&1; then actual=$(openssl dgst -sha256 -r \"$target\") || exit 73; \
         else exit 72; fi; actual=${{actual%% *}}; \
         if [ \"$actual\" = \"$replacement\" ]; then rm -f -- \"$temporary\" && report converged; \
         elif [ \"$actual\" != \"$expected\" ]; then rm -f -- \"$temporary\"; report conflict; \
         else mv -f -- \"$temporary\" \"$target\" && report written; fi",
        target = shell_quote(target),
        temporary = shell_quote(temporary),
        expected = shell_quote(expected_revision),
        replacement = shell_quote(replacement_revision),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        checked_commit_command, missing_commit_command, parse_remote_commit, parse_sha256,
        RemoteCommit,
    };

    #[test]
    fn commit_commands_quote_paths_and_revisions() {
        let missing = missing_commit_command("/tmp/a b", "/tmp/c'd");
        assert!(missing.contains("ln --"));
        assert!(missing.contains("report conflict"));

        let checked = checked_commit_command("/tmp/a", "/tmp/b", "expected", "replacement");
        assert!(checked.contains("sha256sum"));
        assert!(checked.contains("report converged"));
    }

    #[test]
    fn parses_hashes_and_commit_statuses() {
        assert_eq!(
            parse_sha256(format!("{}  file\n", "A".repeat(64)).as_bytes()).unwrap(),
            "a".repeat(64)
        );
        assert_eq!(
            parse_remote_commit(b"written\x0012 17").unwrap(),
            RemoteCommit::Complete(Some(
                crate::modules::remote::file_service::RemoteObservedVersion {
                    size: 12,
                    mtime: 17_000,
                }
            ))
        );
    }
}
