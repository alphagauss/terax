//! SSH Archive 文件传输数据面。
//!
//! 上传在本地生成并校验 tar.gz，下载在远端任务私有目录生成 tar.gz。归档只通过
//! 一个任务独占 SFTP 流传输，解包结果仍进入通用 staging 并使用 no-replace 提交。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use russh::{ChannelMsg, Sig};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::modules::remote::session::{join_remote, shell_quote, ExecOutput, RemoteWorkspace};
use crate::modules::transfers::archive::{
    build_upload_archive, extract_download_archive, ExtractEntry,
};
use crate::modules::transfers::commit::{
    cleanup_local_staging, cleanup_remote_owned_path, cleanup_remote_staging, commit_local_root,
    commit_remote_root, ensure_remote_target_available,
};
use crate::modules::transfers::manager::{TaskControl, TransferRunError};
use crate::modules::transfers::models::TransferStage;
use crate::modules::transfers::planner::{RemoteDownloadPlan, RemoteUploadPlan};
use crate::modules::transfers::progress::ExecutionContext;

const COPY_BUFFER_BYTES: usize = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;

type RunResult<T> = Result<T, TransferRunError>;

/// 执行本地打包、单流上传、远端校验解包和最终提交。
pub(crate) async fn execute_upload(
    plan: RemoteUploadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let remote_parent = common_remote_parent(
        plan.roots
            .iter()
            .map(|root| root.stage.as_str())
            .collect::<Vec<_>>()
            .as_slice(),
    )?;
    let mut remote_work: Option<String> = None;
    let result = async {
        ensure_archive_capability(&plan.workspace, context, false).await?;
        let archive = build_upload_archive(&plan, &remote_parent, context).await?;
        context.set_archive_size(archive.size).await;

        let work_dir = join_remote(
            &remote_parent,
            &format!(".terax-archive-{}", Uuid::new_v4()),
        );
        ensure_remote_target_available(&plan.session, &work_dir).await?;
        plan.session
            .create_dir(work_dir.clone())
            .await
            .map_err(|error| message(format!("create remote archive directory: {error}")))?;
        remote_work = Some(work_dir.clone());
        plan.session
            .set_metadata(
                work_dir.clone(),
                FileAttributes {
                    permissions: Some(0o700),
                    ..FileAttributes::default()
                },
            )
            .await
            .map_err(|error| message(format!("secure remote archive directory: {error}")))?;

        let archive_path = join_remote(&work_dir, "payload.tar.gz");
        upload_archive(&plan.session, &archive.path, &archive_path, context).await?;

        context.set_stage(TransferStage::Extracting).await;
        let command = format!(
            "tar -xzf {archive} -C {directory}",
            archive = shell_quote(&archive_path),
            directory = shell_quote(&work_dir),
        );
        run_checked(&plan.workspace, &command, context).await?;
        plan.session
            .remove_file(archive_path)
            .await
            .map_err(|error| message(format!("remove remote archive payload: {error}")))?;

        for root in &plan.roots {
            context.checkpoint().await?;
            let name = remote_name(&root.stage)?;
            let extracted = join_remote(&work_dir, name);
            ensure_remote_target_available(&plan.session, &root.stage).await?;
            plan.session
                .rename(extracted, root.stage.clone())
                .await
                .map_err(|error| {
                    message(format!("publish extracted staging {}: {error}", root.stage))
                })?;
        }
        cleanup_remote_owned_path(&plan.session, &work_dir).await;
        remote_work = None;

        context.set_stage(TransferStage::Verifying).await;
        verify_remote_upload(&plan, context).await?;
        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            commit_remote_root(&plan.session, root).await?;
            context.root_committed().await;
        }
        Ok(())
    }
    .await;
    if let Some(path) = remote_work {
        cleanup_remote_owned_path(&plan.session, &path).await;
    }
    if result.is_err() {
        cleanup_remote_staging(&plan.session, &plan.roots).await;
    }
    close_sftp(&plan.session).await;
    result
}

/// 执行远端打包、单流下载、本地安全解包和最终提交。
pub(crate) async fn execute_download(
    plan: RemoteDownloadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut remote_work: Option<String> = None;
    let result = async {
        ensure_archive_capability(&plan.workspace, context, true).await?;
        context.set_stage(TransferStage::Archiving).await;
        let work_dir = create_remote_work_dir(&plan.workspace, context).await?;
        remote_work = Some(work_dir.clone());
        let archive_path = join_remote(&work_dir, "payload.tar.gz");
        let sources = download_root_sources(&plan)?;
        verify_remote_download_sources(&plan, context).await?;
        let mut command = format!("tar -czf {} -C / --", shell_quote(&archive_path));
        for source in sources {
            let relative = source
                .strip_prefix('/')
                .filter(|value| !value.is_empty())
                .ok_or_else(|| message(format!("invalid remote archive source: {source}")))?;
            command.push(' ');
            command.push_str(&shell_quote(&format!("./{relative}")));
        }
        run_checked(&plan.workspace, &command, context).await?;
        verify_remote_download_sources(&plan, context).await?;

        let archive_metadata = plan
            .session
            .symlink_metadata(archive_path.clone())
            .await
            .map_err(|error| message(format!("stat remote archive: {error}")))?;
        if !archive_metadata.file_type().is_file() {
            return Err(message("remote archive is not a regular file"));
        }
        let archive_size = archive_metadata
            .size
            .ok_or_else(|| message("remote archive size is unavailable"))?;
        context.set_archive_size(archive_size).await;
        context.set_stage(TransferStage::Transferring).await;

        let temporary = tempfile::Builder::new()
            .prefix("terax-archive-")
            .suffix(".tar.gz")
            .tempfile()
            .map_err(|error| message(format!("create local archive: {error}")))?;
        let archive_local_path = temporary.path().to_path_buf();
        let output = temporary
            .reopen()
            .map_err(|error| message(format!("open local archive: {error}")))?;
        let mut output = tokio::fs::File::from_std(output);
        let raw = super::session::open_raw(&plan.workspace).await?;
        let downloaded = super::direct::download_file_into(
            &raw,
            &archive_path,
            &mut output,
            archive_size,
            context,
        )
        .await;
        let _ = raw.close_session();
        downloaded?;
        cleanup_remote_owned_path(&plan.session, &work_dir).await;
        remote_work = None;

        let expected = download_extract_manifest(&plan)?;
        extract_download_archive(&archive_local_path, expected, context).await?;
        apply_download_metadata(&plan, context).await?;

        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            commit_local_root(root).await?;
            context.root_committed().await;
        }
        Ok(())
    }
    .await;
    if let Some(path) = remote_work {
        cleanup_remote_owned_path(&plan.session, &path).await;
    }
    if result.is_err() {
        cleanup_local_staging(&plan.roots).await;
    }
    close_sftp(&plan.session).await;
    result
}

async fn upload_archive(
    session: &Arc<SftpSession>,
    local: &Path,
    remote: &str,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let mut reader = tokio::fs::File::open(local)
        .await
        .map_err(|error| message(format!("open local archive: {error}")))?;
    let mut writer = session
        .open_with_flags(
            remote.to_string(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(|error| message(format!("create remote archive: {error}")))?;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        context.checkpoint().await?;
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| message(format!("read local archive: {error}")))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .await
            .map_err(|error| message(format!("write remote archive: {error}")))?;
        context.report_bytes(read as u64).await;
    }
    writer
        .flush()
        .await
        .map_err(|error| message(format!("flush remote archive: {error}")))?;
    writer
        .sync_all()
        .await
        .map_err(|error| message(format!("sync remote archive: {error}")))?;
    writer
        .shutdown()
        .await
        .map_err(|error| message(format!("close remote archive: {error}")))
}

async fn ensure_archive_capability(
    workspace: &Arc<RemoteWorkspace>,
    context: &ExecutionContext,
    require_mktemp: bool,
) -> RunResult<()> {
    let command = if require_mktemp {
        "command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1 && command -v mktemp >/dev/null 2>&1"
    } else {
        "command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1"
    };
    let output = run_remote(
        workspace,
        command,
        context.control(),
        Duration::from_secs(30),
    )
    .await?;
    if output.exit_code != Some(0) {
        return Err(message(
            "ARCHIVE_UNAVAILABLE: remote tar, gzip or mktemp is unavailable; use Direct transfer",
        ));
    }
    Ok(())
}

async fn create_remote_work_dir(
    workspace: &Arc<RemoteWorkspace>,
    context: &ExecutionContext,
) -> RunResult<String> {
    let output = run_remote(
        workspace,
        "umask 077; mktemp -d \"${TMPDIR:-/tmp}/terax-archive.XXXXXXXX\"",
        context.control(),
        Duration::from_secs(30),
    )
    .await?;
    if output.exit_code != Some(0) || output.truncated {
        return Err(remote_command_error(
            "create remote archive directory",
            &output,
        ));
    }
    let path = String::from_utf8(output.stdout)
        .map_err(|_| message("remote temporary path is not valid UTF-8"))?
        .trim()
        .to_string();
    let name = path.rsplit('/').next().unwrap_or_default();
    let suffix = name.strip_prefix("terax-archive.").unwrap_or_default();
    if !path.starts_with('/')
        || path == "/"
        || path.contains('\n')
        || path.contains('\0')
        || path.split('/').any(|part| matches!(part, "." | ".."))
        || suffix.len() != 8
        || !suffix.bytes().all(|value| value.is_ascii_alphanumeric())
    {
        return Err(message("remote mktemp returned an invalid path"));
    }
    Ok(path)
}

async fn run_checked(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    context: &ExecutionContext,
) -> RunResult<()> {
    let output = run_remote(workspace, command, context.control(), COMMAND_TIMEOUT).await?;
    if output.exit_code == Some(0) && !output.timed_out && !output.truncated {
        Ok(())
    } else {
        Err(remote_command_error("remote archive command", &output))
    }
}

async fn run_remote(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    control: Arc<TaskControl>,
    timeout: Duration,
) -> RunResult<ExecOutput> {
    let mut channel = {
        let handle = workspace.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|error| message(format!("open archive command channel: {error}")))?
    };
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|error| message(format!("start archive command: {error}")))?;
    let deadline = tokio::time::Instant::now() + timeout;
    let mut output = ExecOutput::default();
    let mut remote_paused = false;
    loop {
        let paused = control.is_paused();
        if paused != remote_paused {
            channel
                .signal(Sig::Custom(if paused { "STOP" } else { "CONT" }.into()))
                .await
                .map_err(|error| message(format!("control archive command: {error}")))?;
            remote_paused = paused;
        }
        tokio::select! {
            changed = control.wait_for_change() => {
                if matches!(changed, Err(TransferRunError::Canceled)) {
                    let _ = channel.signal(Sig::KILL).await;
                    let _ = channel.close().await;
                    return Err(TransferRunError::Canceled);
                }
            }
            message = tokio::time::timeout_at(deadline, channel.wait()) => {
                match message {
                    Ok(Some(ChannelMsg::Data { data })) => {
                        append_output(&mut output.stdout, &data, &mut output.truncated);
                    }
                    Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                        append_output(&mut output.stderr, &data, &mut output.truncated);
                    }
                    Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                        output.exit_code = Some(exit_status as i32);
                    }
                    Ok(Some(ChannelMsg::ExitSignal { .. })) => output.exit_code = Some(128),
                    Ok(Some(ChannelMsg::Close)) | Ok(None) => return Ok(output),
                    Ok(_) => {}
                    Err(_) => {
                        let _ = channel.close().await;
                        output.timed_out = true;
                        return Ok(output);
                    }
                }
            }
        }
    }
}

async fn verify_remote_upload(
    plan: &RemoteUploadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    for file in &plan.files {
        context.checkpoint().await?;
        let metadata = plan
            .session
            .symlink_metadata(file.destination.clone())
            .await
            .map_err(|error| message(format!("verify remote file: {error}")))?;
        if !metadata.file_type().is_file() || metadata.size != Some(file.size) {
            return Err(message(format!(
                "remote archive output mismatch: {}",
                file.destination
            )));
        }
        file.metadata
            .apply_remote(&plan.session, &file.destination)
            .await?;
        context.complete_file().await;
    }
    for directory in plan.directories.iter().rev() {
        context.checkpoint().await?;
        let metadata = plan
            .session
            .symlink_metadata(directory.destination.clone())
            .await
            .map_err(|error| message(format!("verify remote directory: {error}")))?;
        if !metadata.file_type().is_dir() {
            return Err(message(format!(
                "remote archive directory mismatch: {}",
                directory.destination
            )));
        }
        directory
            .metadata
            .apply_remote(&plan.session, &directory.destination)
            .await?;
    }
    Ok(())
}

async fn verify_remote_download_sources(
    plan: &RemoteDownloadPlan,
    context: &ExecutionContext,
) -> RunResult<()> {
    for file in &plan.files {
        context.checkpoint().await?;
        let metadata = plan
            .session
            .symlink_metadata(file.source.clone())
            .await
            .map_err(|error| message(format!("verify remote source: {error}")))?;
        if !metadata.file_type().is_file()
            || metadata.size != Some(file.size)
            || file
                .metadata
                .modified()
                .is_some_and(|expected| metadata.modified().ok() != Some(expected))
        {
            return Err(message(format!(
                "remote source changed while archiving: {}",
                file.source
            )));
        }
    }
    for directory in &plan.directories {
        context.checkpoint().await?;
        let metadata = plan
            .session
            .symlink_metadata(directory.source.clone())
            .await
            .map_err(|error| message(format!("verify remote directory: {error}")))?;
        if !metadata.file_type().is_dir() {
            return Err(message(format!(
                "remote source changed while archiving: {}",
                directory.source
            )));
        }
    }
    Ok(())
}

fn download_extract_manifest(
    plan: &RemoteDownloadPlan,
) -> RunResult<HashMap<String, ExtractEntry>> {
    let mut expected = HashMap::with_capacity(plan.directories.len() + plan.files.len());
    for directory in &plan.directories {
        insert_extract_entry(
            &mut expected,
            archive_source_path(&directory.source)?,
            ExtractEntry {
                destination: directory.destination.clone(),
                size: 0,
                is_dir: true,
            },
        )?;
    }
    for file in &plan.files {
        insert_extract_entry(
            &mut expected,
            archive_source_path(&file.source)?,
            ExtractEntry {
                destination: file.destination.clone(),
                size: file.size,
                is_dir: false,
            },
        )?;
    }
    Ok(expected)
}

fn insert_extract_entry(
    expected: &mut HashMap<String, ExtractEntry>,
    path: String,
    entry: ExtractEntry,
) -> RunResult<()> {
    if expected.insert(path.clone(), entry).is_some() {
        Err(message(format!("duplicate archive source path: {path}")))
    } else {
        Ok(())
    }
}

async fn apply_download_metadata(
    plan: &RemoteDownloadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Verifying).await;
    for file in &plan.files {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&file.destination)
            .await
            .map_err(|error| message(format!("verify extracted file: {error}")))?;
        if !metadata.is_file() || metadata.len() != file.size {
            return Err(message(format!(
                "local archive output mismatch: {}",
                file.destination.display()
            )));
        }
        file.metadata.apply_local(&file.destination).await?;
        context.complete_file().await;
    }
    for directory in plan.directories.iter().rev() {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&directory.destination)
            .await
            .map_err(|error| message(format!("verify extracted directory: {error}")))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(message(format!(
                "local archive directory mismatch: {}",
                directory.destination.display()
            )));
        }
        directory
            .metadata
            .apply_local(&directory.destination)
            .await?;
    }
    Ok(())
}

fn download_root_sources(plan: &RemoteDownloadPlan) -> RunResult<Vec<String>> {
    let mut sources = Vec::with_capacity(plan.roots.len());
    for root in &plan.roots {
        let source = plan
            .files
            .iter()
            .find(|file| file.destination == root.stage)
            .map(|file| file.source.clone())
            .or_else(|| {
                plan.directories
                    .iter()
                    .find(|directory| directory.destination == root.stage)
                    .map(|directory| directory.source.clone())
            })
            .ok_or_else(|| message("archive root is missing from the manifest"))?;
        sources.push(source);
    }
    Ok(sources)
}

fn archive_source_path(source: &str) -> RunResult<String> {
    source
        .strip_prefix('/')
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| message(format!("invalid remote archive source: {source}")))
}

fn common_remote_parent(paths: &[&str]) -> RunResult<String> {
    let first = paths
        .first()
        .ok_or_else(|| message("archive manifest has no roots"))?;
    let parent = remote_parent(first)?;
    if paths
        .iter()
        .skip(1)
        .any(|path| remote_parent(path).ok().as_deref() != Some(parent.as_str()))
    {
        return Err(message("archive roots do not share one destination"));
    }
    Ok(parent)
}

fn remote_parent(path: &str) -> RunResult<String> {
    let (parent, name) = path
        .trim_end_matches('/')
        .rsplit_once('/')
        .ok_or_else(|| message(format!("invalid remote path: {path}")))?;
    if name.is_empty() {
        return Err(message(format!("invalid remote path: {path}")));
    }
    Ok(if parent.is_empty() {
        "/".to_string()
    } else {
        parent.to_string()
    })
}

fn remote_name(path: &str) -> RunResult<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| message(format!("invalid remote path: {path}")))
}

fn remote_command_error(action: &str, output: &ExecOutput) -> TransferRunError {
    let detail = if output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    };
    let reason = if output.timed_out {
        "timed out".to_string()
    } else if output.truncated {
        "output exceeded the safety limit".to_string()
    } else if detail.is_empty() {
        format!("exit {:?}", output.exit_code)
    } else {
        detail
    };
    message(format!("{action}: {reason}"))
}

fn append_output(target: &mut Vec<u8>, data: &[u8], truncated: &mut bool) {
    let remaining = COMMAND_OUTPUT_LIMIT.saturating_sub(target.len());
    if remaining < data.len() {
        *truncated = true;
    }
    target.extend_from_slice(&data[..data.len().min(remaining)]);
}

async fn close_sftp(session: &Arc<SftpSession>) {
    let _ = tokio::time::timeout(Duration::from_secs(1), session.close()).await;
}

fn message(value: impl Into<String>) -> TransferRunError {
    TransferRunError::Message(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_archive_paths_are_relative_and_parents_are_stable() {
        assert_eq!(
            archive_source_path("/home/user/file.txt").unwrap(),
            "home/user/file.txt"
        );
        assert_eq!(remote_parent("/home/user/file.txt").unwrap(), "/home/user");
        assert_eq!(remote_parent("/file.txt").unwrap(), "/");
        assert_eq!(remote_name("/home/user/file.txt").unwrap(), "file.txt");
    }
}
