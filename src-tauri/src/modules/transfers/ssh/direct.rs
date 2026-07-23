//! SSH Direct 文件传输流水线。
//!
//! 上传复用高层 SFTP 的有界写入队列，下载在任务独占 raw SFTP channel 中保持有限
//! 数量的 READ 请求并发。两种方向只写 staging，并由统一提交层公开最终目标。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::modules::transfers::commit::{
    cleanup_local_staging, cleanup_remote_staging, commit_local_root, commit_remote_root,
};
use crate::modules::transfers::errors::{io_failure, TransferErrorCode};
use crate::modules::transfers::manager::TransferRunError;
use crate::modules::transfers::models::TransferStage;
use crate::modules::transfers::planner::{RemoteDownloadPlan, RemoteUploadFile, RemoteUploadPlan};
use crate::modules::transfers::progress::ExecutionContext;

const DOWNLOAD_CHUNK_BYTES: usize = 32 * 1024;
const MAX_INFLIGHT_READS: usize = 32;
const COPY_BUFFER_BYTES: usize = 256 * 1024;

type RunResult<T> = Result<T, TransferRunError>;

/// 通过有界 raw SFTP 流水线下载一个文件到排他 staging 目标。
pub(crate) async fn download_file(
    session: &Arc<RawSftpSession>,
    remote: &str,
    local: &Path,
    expected_size: u64,
    context: &mut ExecutionContext,
) -> Result<(), TransferRunError> {
    let mut writer = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(local)
        .await
    {
        Ok(writer) => writer,
        Err(error) => {
            return Err(TransferRunError::Failed(io_failure(
                format!("create destination {}", local.display()),
                &error,
            )))
        }
    };

    let result = download_file_into(session, remote, &mut writer, expected_size, context).await;
    if result.is_err() {
        drop(writer);
        let _ = tokio::fs::remove_file(local).await;
    }
    result
}

/// 通过有界 raw SFTP 流水线下载到调用方持有的排他文件。
pub(crate) async fn download_file_into(
    session: &Arc<RawSftpSession>,
    remote: &str,
    writer: &mut tokio::fs::File,
    expected_size: u64,
    context: &mut ExecutionContext,
) -> Result<(), TransferRunError> {
    let handle = super::io::run(
        format!("open remote source {remote}"),
        session.open(remote, OpenFlags::READ, FileAttributes::default()),
    )
    .await?
    .handle;
    let mut next_offset = 0u64;
    let mut completed = 0u64;
    let mut canceled = false;
    let mut failure = None;
    let mut inflight = FuturesUnordered::new();

    while next_offset < expected_size || !inflight.is_empty() {
        if !canceled && failure.is_none() {
            match context.checkpoint().await {
                Ok(()) => {}
                Err(TransferRunError::Canceled) => canceled = true,
                Err(error) => failure = Some(error),
            }
        }
        while !canceled
            && failure.is_none()
            && next_offset < expected_size
            && inflight.len() < MAX_INFLIGHT_READS
        {
            let offset = next_offset;
            let length = ((expected_size - offset) as usize).min(DOWNLOAD_CHUNK_BYTES);
            next_offset += length as u64;
            let session = session.clone();
            let handle = handle.clone();
            inflight.push(async move {
                let mut data = Vec::with_capacity(length);
                let mut cursor = offset;
                let end = offset + length as u64;
                while cursor < end {
                    let chunk = super::io::run(
                        format!("read remote source {remote}"),
                        session.read(handle.clone(), cursor, (end - cursor) as u32),
                    )
                    .await?;
                    if chunk.data.is_empty() {
                        break;
                    }
                    cursor += chunk.data.len() as u64;
                    data.extend_from_slice(&chunk.data);
                }
                Ok::<_, TransferRunError>((offset, data))
            });
        }

        let Some(result) = inflight.next().await else {
            break;
        };
        if canceled || failure.is_some() {
            continue;
        }
        match result {
            Ok((offset, data)) => {
                if data.is_empty() {
                    failure = Some(source_changed(format!(
                        "remote source ended before {expected_size} bytes: {remote}"
                    )));
                    continue;
                }
                if let Err(error) = writer.seek(std::io::SeekFrom::Start(offset)).await {
                    failure = Some(TransferRunError::Failed(io_failure(
                        format!("seek download destination for {remote}"),
                        &error,
                    )));
                } else if let Err(error) = writer.write_all(&data).await {
                    failure = Some(TransferRunError::Failed(io_failure(
                        format!("write download destination for {remote}"),
                        &error,
                    )));
                } else {
                    completed = completed.saturating_add(data.len() as u64);
                    context.report_bytes(data.len() as u64).await;
                }
            }
            Err(error) => failure = Some(error),
        }
    }

    let close_result = super::io::run(
        format!("close remote source {remote}"),
        session.close(handle),
    )
    .await;
    if let Some(error) = failure {
        return Err(error);
    }
    if canceled {
        return Err(TransferRunError::Canceled);
    }
    close_result?;
    if completed != expected_size {
        return Err(source_changed(format!(
            "remote source size changed during transfer: {remote} (expected {expected_size} bytes, received {completed})"
        )));
    }
    writer.flush().await.map_err(|error| {
        TransferRunError::Failed(io_failure(
            format!("flush download destination for {remote}"),
            &error,
        ))
    })?;
    writer.sync_all().await.map_err(|error| {
        TransferRunError::Failed(io_failure(
            format!("sync download destination for {remote}"),
            &error,
        ))
    })?;
    Ok(())
}

/// 执行 SSH 上传并确保独立 SFTP channel 在终态前关闭。
pub(crate) async fn execute_upload(
    plan: RemoteUploadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            super::io::run(
                format!("create remote directory {}", directory.destination),
                plan.session.create_dir(directory.destination.clone()),
            )
            .await?;
        }
        for file in &plan.files {
            copy_remote_upload_file(&plan.session, file, context).await?;
        }
        context.set_stage(TransferStage::Verifying).await;
        for file in &plan.files {
            context.checkpoint().await?;
            verify_remote_file(&plan.session, &file.destination, file.size).await?;
        }
        for directory in plan.directories.iter().rev() {
            context.checkpoint().await?;
            directory
                .metadata
                .apply_remote(&plan.session, &directory.destination)
                .await?;
        }
        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            commit_remote_root(&plan.session, root).await?;
            context.root_committed().await;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let pending = if is_connection_lost(&result) {
            plan.roots.iter().map(|root| root.stage.clone()).collect()
        } else {
            cleanup_remote_staging(&plan.session, &plan.roots).await
        };
        super::cleanup::schedule(plan.workspace.profile.id.clone(), pending);
    }
    close_sftp(&plan.session).await;
    result
}

/// 执行 SSH 下载并确保独立 SFTP channel 在终态前关闭。
pub(crate) async fn execute_download(
    plan: RemoteDownloadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let raw_session = super::session::open_raw(&plan.workspace).await?;
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            tokio::fs::create_dir(&directory.destination)
                .await
                .map_err(|error| {
                    TransferRunError::Failed(io_failure(
                        format!("create directory {}", directory.destination.display()),
                        &error,
                    ))
                })?;
        }
        for file in &plan.files {
            context.set_current_file(file.source.clone()).await;
            verify_remote_source(
                &plan.session,
                &file.source,
                file.size,
                file.metadata.modified(),
            )
            .await?;
            download_file(
                &raw_session,
                &file.source,
                &file.destination,
                file.size,
                context,
            )
            .await?;
            verify_remote_source(
                &plan.session,
                &file.source,
                file.size,
                file.metadata.modified(),
            )
            .await?;
            file.metadata.apply_local(&file.destination).await?;
            context.complete_file().await;
        }
        context.set_stage(TransferStage::Verifying).await;
        for file in &plan.files {
            context.checkpoint().await?;
            verify_local_file(&file.destination, file.size).await?;
        }
        for directory in plan.directories.iter().rev() {
            context.checkpoint().await?;
            directory
                .metadata
                .apply_local(&directory.destination)
                .await?;
        }
        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            commit_local_root(root).await?;
            context.root_committed().await;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_local_staging(&plan.roots).await;
    }
    let _ = raw_session.close_session();
    close_sftp(&plan.session).await;
    result
}

/// 将一个宿主机文件写入独立 SFTP 会话中的排他目标。
async fn copy_remote_upload_file(
    session: &Arc<SftpSession>,
    file: &RemoteUploadFile,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context
        .set_current_file(file.source.to_string_lossy().into_owned())
        .await;
    let mut reader = crate::modules::transfers::source::open_verified_file(
        &file.source,
        file.source_identity,
        file.size,
        file.metadata.modified(),
    )
    .await?;
    let mut writer = super::io::run(
        format!("create remote file {}", file.destination),
        session.open_with_flags(
            file.destination.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        ),
    )
    .await?;
    copy_stream(&mut reader, &mut writer, context).await?;
    super::io::run(
        format!("flush remote file {}", file.destination),
        writer.flush(),
    )
    .await?;
    super::io::run(
        format!("sync remote file {}", file.destination),
        writer.sync_all(),
    )
    .await?;
    super::io::run(
        format!("close remote file {}", file.destination),
        writer.shutdown(),
    )
    .await?;
    crate::modules::transfers::source::verify_opened_file(
        &reader,
        &file.source,
        file.source_identity,
        file.size,
        file.metadata.modified(),
    )
    .await?;
    file.metadata
        .apply_remote(session, &file.destination)
        .await?;
    context.complete_file().await;
    Ok(())
}

/// 以固定大小块复制异步流，每个块之间响应暂停和取消并汇总进度。
async fn copy_stream<R, W>(
    reader: &mut R,
    writer: &mut W,
    context: &mut ExecutionContext,
) -> RunResult<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        context.checkpoint().await?;
        let read = reader.read(&mut buffer).await.map_err(|error| {
            TransferRunError::Failed(io_failure("read transfer source", &error))
        })?;
        if read == 0 {
            return Ok(());
        }
        super::io::run(
            "write remote transfer destination",
            writer.write_all(&buffer[..read]),
        )
        .await?;
        context.report_bytes(read as u64).await;
    }
}

/// 校验远端来源在 raw SFTP 下载期间没有改变长度、类型或修改时间。
async fn verify_remote_source(
    session: &Arc<SftpSession>,
    path: &str,
    expected_size: u64,
    expected_modified: Option<std::time::SystemTime>,
) -> RunResult<()> {
    let actual = super::io::run(
        format!("verify remote source {path}"),
        session.symlink_metadata(path.to_string()),
    )
    .await?;
    if !actual.file_type().is_file()
        || actual.size != Some(expected_size)
        || expected_modified.is_some_and(|expected| actual.modified().ok() != Some(expected))
    {
        return Err(source_changed(format!(
            "remote source changed during transfer: {path}"
        )));
    }
    Ok(())
}

/// 校验本地 staging 文件长度与扫描结果一致。
async fn verify_local_file(path: &Path, expected: u64) -> RunResult<()> {
    let actual = tokio::fs::metadata(path)
        .await
        .map_err(|error| {
            TransferRunError::Failed(io_failure(
                format!("verify destination {}", path.display()),
                &error,
            ))
        })?
        .len();
    if actual != expected {
        return Err(message(format!(
            "destination size mismatch: {} (expected {expected} bytes, found {actual})",
            path.display()
        )));
    }
    Ok(())
}

/// 校验远端 staging 文件长度与扫描结果一致。
async fn verify_remote_file(
    session: &Arc<SftpSession>,
    path: &str,
    expected: u64,
) -> RunResult<()> {
    let metadata = super::io::run(
        format!("verify remote destination {path}"),
        session.metadata(path.to_string()),
    )
    .await?;
    let actual = metadata
        .size
        .ok_or_else(|| message(format!("remote destination size is unavailable: {path}")))?;
    if actual != expected {
        return Err(message(format!(
            "remote destination size mismatch: {path} (expected {expected} bytes, found {actual})"
        )));
    }
    Ok(())
}

async fn close_sftp(session: &Arc<SftpSession>) {
    let _ = tokio::time::timeout(Duration::from_secs(1), session.close()).await;
}

fn message(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IntegrityCheckFailed, value)
}

fn source_changed(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::SourceChanged, value)
}

fn is_connection_lost(result: &RunResult<()>) -> bool {
    matches!(
        result,
        Err(TransferRunError::Failed(failure))
            if failure.code == TransferErrorCode::ConnectionLost
    )
}
