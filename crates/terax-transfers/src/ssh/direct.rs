//! SSH Direct 文件传输流水线。
//!
//! 上传复用高层 SFTP 的有界写入队列，下载在任务独占 raw SFTP channel 中保持有限
//! 数量的 READ 请求并发。两种方向只写 staging，并由统一提交层公开最终目标。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::commit::{
    cleanup_local_staging, commit_local_root_tracked, commit_remote_root_tracked,
    schedule_local_cleanup,
};
use crate::errors::{io_failure, TransferErrorCode};
use crate::manager::TransferRunError;
use crate::models::{TransferEntryKind, TransferFileFailure, TransferStage};
use crate::planner::{RemoteDownloadFile, RemoteDownloadPlan, RemoteUploadFile, RemoteUploadPlan};
use crate::progress::ExecutionContext;
use uuid::Uuid;

const DOWNLOAD_CHUNK_BYTES: usize = 32 * 1024;
const MAX_INFLIGHT_READS: usize = 32;
const COPY_BUFFER_BYTES: usize = 256 * 1024;

type RunResult<T> = Result<T, TransferRunError>;

struct OrderedSha256 {
    digest: Sha256,
    pending: BTreeMap<u64, Vec<u8>>,
    hashed_until: u64,
}

impl OrderedSha256 {
    fn new() -> Self {
        Self {
            digest: Sha256::new(),
            pending: BTreeMap::new(),
            hashed_until: 0,
        }
    }

    /// 接收一个可能乱序完成的 READ 块，并尽快推进连续摘要前缀。
    fn push(&mut self, offset: u64, data: Vec<u8>) -> bool {
        if self.pending.insert(offset, data).is_some() {
            return false;
        }
        while let Some(chunk) = self.pending.remove(&self.hashed_until) {
            self.digest.update(&chunk);
            self.hashed_until = self.hashed_until.saturating_add(chunk.len() as u64);
        }
        true
    }

    fn finish(self, expected_size: u64) -> Option<String> {
        (self.hashed_until == expected_size && self.pending.is_empty())
            .then(|| format!("{:x}", self.digest.finalize()))
    }

    #[cfg(test)]
    fn buffered_chunks(&self) -> usize {
        self.pending.len()
    }
}

/// 通过有界 raw SFTP 流水线下载一个文件到排他 staging 目标。
pub(crate) async fn download_file(
    session: &Arc<RawSftpSession>,
    remote: &str,
    local: &Path,
    expected_size: u64,
    context: &mut ExecutionContext,
) -> Result<(), TransferRunError> {
    let existing = tokio::fs::symlink_metadata(local).await.ok();
    if existing
        .as_ref()
        .is_some_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err(crate::resume::changed());
    }
    if existing
        .as_ref()
        .is_some_and(|metadata| metadata.len() == expected_size)
        && context
            .resume
            .as_ref()
            .is_some_and(|state| state.files.get(remote) == Some(&expected_size))
    {
        context.report_bytes(expected_size).await;
        return Ok(());
    }
    let mut writer = match tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(existing.is_none() || context.resume.is_none())
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
    if result.is_err() && !context.retains_partial(&result) {
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
    download_file_into_inner(session, remote, writer, expected_size, context, false)
        .await
        .map(|_| ())
}

/// 通过同一条有界下载流水线写入文件并按远端字节顺序计算 SHA-256。
///
/// READ 请求允许乱序完成，函数最多暂存一个并发窗口的数据并按 offset 喂给摘要，
/// 因此不会为了校验再次读取已经落盘的归档。
pub(crate) async fn download_file_into_sha256(
    session: &Arc<RawSftpSession>,
    remote: &str,
    writer: &mut tokio::fs::File,
    expected_size: u64,
    context: &mut ExecutionContext,
) -> Result<String, TransferRunError> {
    download_file_into_inner(session, remote, writer, expected_size, context, true)
        .await?
        .ok_or_else(|| {
            TransferRunError::failed(
                TransferErrorCode::IntegrityCheckFailed,
                "download checksum state is unavailable",
            )
        })
}

async fn download_file_into_inner(
    session: &Arc<RawSftpSession>,
    remote: &str,
    writer: &mut tokio::fs::File,
    expected_size: u64,
    context: &mut ExecutionContext,
    hash_download: bool,
) -> Result<Option<String>, TransferRunError> {
    let control = context.control();
    let handle = super::io::run_cancellable(
        format!("open remote source {remote}"),
        session.open(remote, OpenFlags::READ, FileAttributes::default()),
        control.as_ref(),
    )
    .await?
    .handle;
    let saved = context.resume_offset(remote);
    let actual = writer
        .metadata()
        .await
        .map_err(|error| io_failure("stat partial download", &error))?
        .len();
    let saved = crate::resume::validated_offset(saved, actual, expected_size)?;
    writer
        .set_len(saved)
        .await
        .map_err(|error| io_failure("truncate unconfirmed download tail", &error))?;
    let mut next_offset = saved;
    let mut completed = saved;
    let mut prefix = crate::resume::ConfirmedPrefix::new(saved);
    context.report_bytes(saved).await;
    let mut canceled = false;
    let mut failure = None;
    let mut inflight = FuturesUnordered::new();
    let mut digest = hash_download.then(OrderedSha256::new);
    if let Some(digest) = digest.as_mut() {
        writer
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|error| io_failure("seek partial archive", &error))?;
        let mut remaining = saved;
        let mut buffer = vec![0; COPY_BUFFER_BYTES];
        while remaining > 0 {
            context.checkpoint().await?;
            let length = remaining.min(buffer.len() as u64) as usize;
            writer
                .read_exact(&mut buffer[..length])
                .await
                .map_err(|error| io_failure("hash partial archive", &error))?;
            digest.digest.update(&buffer[..length]);
            remaining -= length as u64;
        }
        digest.hashed_until = saved;
    }

    while next_offset < expected_size || !inflight.is_empty() {
        // 暂停先收完已发出的有限窗口，避免暂停时间计入请求超时。
        if !canceled && failure.is_none() && (!control.is_paused() || inflight.is_empty()) {
            match context.checkpoint().await {
                Ok(()) => {}
                Err(TransferRunError::Canceled) => canceled = true,
                Err(error) => failure = Some(error),
            }
        }
        while !canceled
            && failure.is_none()
            && !control.is_paused()
            && next_offset < expected_size
            && inflight.len() + prefix.pending() < MAX_INFLIGHT_READS
        {
            let offset = next_offset;
            let length = ((expected_size - offset) as usize).min(DOWNLOAD_CHUNK_BYTES);
            next_offset += length as u64;
            let session = session.clone();
            let handle = handle.clone();
            let task = context.task_id().to_string();
            inflight.push(async move {
                let mut data = Vec::with_capacity(length);
                let mut cursor = offset;
                let end = offset + length as u64;
                while cursor < end {
                    let chunk = super::io::retry_read(
                        &format!(
                            "read remote source {remote} task={task} offset={cursor} length={}",
                            end - cursor
                        ),
                        || session.read(handle.clone(), cursor, (end - cursor) as u32),
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

        let result = tokio::select! {
            result = inflight.next() => result,
            _ = control.cancelled() => {
                canceled = true;
                None
            }
        };
        let Some(result) = result else {
            break;
        };
        if canceled || failure.is_some() {
            continue;
        }
        match result {
            Ok((offset, data)) => {
                if data.len() as u64 != (expected_size - offset).min(DOWNLOAD_CHUNK_BYTES as u64) {
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
                    let data_len = data.len() as u64;
                    if let Some(digest) = digest.as_mut() {
                        if !digest.push(offset, data) {
                            failure = Some(source_changed(format!(
                                "remote source returned a duplicate block: {remote}"
                            )));
                            continue;
                        }
                    }
                    completed = completed.saturating_add(data_len);
                    let confirmed = prefix.complete(offset, data_len);
                    if confirmed.saturating_sub(context.resume_offset(remote))
                        >= crate::resume::CHECKPOINT_BYTES
                    {
                        writer
                            .sync_data()
                            .await
                            .map_err(|error| io_failure("sync download checkpoint", &error))?;
                        context.save_offset(remote, confirmed).await?;
                    }
                    context.report_bytes(data_len).await;
                }
            }
            Err(error) => failure = Some(error),
        }
    }

    // 取消后由外层立即关闭任务独占的 raw session，不能为了单个句柄再等待 I/O 超时。
    if canceled {
        return Err(TransferRunError::Canceled);
    }
    let close_result = super::io::run(
        format!("close remote source {remote}"),
        session.close(handle),
    )
    .await;
    if let Some(error) = failure {
        return Err(error);
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
    context.save_offset(remote, expected_size).await?;
    digest
        .map(|digest| {
            digest.finish(expected_size).ok_or_else(|| {
                source_changed(format!("remote source hash stream is incomplete: {remote}"))
            })
        })
        .transpose()
}

/// 执行 SSH 上传并确保独立 SFTP channel 在终态前关闭。
pub(crate) async fn execute_upload(
    plan: RemoteUploadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context
        .prepare_resume(crate::resume::ResumeState::upload(&plan))
        .await?;
    context.set_stage(TransferStage::Transferring).await;
    let cleanup_scope = super::cleanup::RemoteCleanupScope::for_upload(
        &plan.workspace,
        plan.task_id.clone(),
        plan.owner_task_id.clone(),
        plan.roots.iter().map(|root| root.final_path.as_str()),
    );
    let mut pending_cleanup = Vec::new();
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            match super::io::run_cancellable(
                format!("inspect remote staging directory {}", directory.destination),
                plan.session.symlink_metadata(&directory.destination),
                &context.control(),
            )
            .await
            {
                Ok(metadata) if metadata.is_dir() && !metadata.is_symlink() => {}
                Ok(_) => return Err(crate::resume::changed()),
                Err(TransferRunError::Failed(failure))
                    if failure.code == TransferErrorCode::SourceUnavailable =>
                {
                    super::io::run(
                        format!("create remote directory {}", directory.destination),
                        plan.session.create_dir(directory.destination.clone()),
                    )
                    .await?;
                }
                Err(error) => return Err(error),
            }
        }
        let mut successful = vec![true; plan.files.len()];
        for (index, file) in plan.files.iter().enumerate() {
            if let Err(error) = copy_remote_upload_file(&plan.session, file, context).await {
                record_remote_upload_failure(&plan, file, error, context).await?;
                successful[index] = false;
                remove_remote_partial_file(&plan.session, &file.destination).await?;
                context.save_offset(&file.destination, 0).await?;
            }
        }
        context.set_stage(TransferStage::Verifying).await;
        for (index, file) in plan.files.iter().enumerate() {
            if !successful[index] {
                continue;
            }
            context.checkpoint().await?;
            match verify_remote_file(&plan.session, &file.destination, file.size).await {
                Ok(()) => {}
                Err(error) => {
                    record_remote_upload_failure(&plan, file, error, context).await?;
                    successful[index] = false;
                    remove_remote_partial_file(&plan.session, &file.destination).await?;
                    context.save_offset(&file.destination, 0).await?;
                }
            }
        }
        for directory in plan.directories.iter().rev() {
            context.checkpoint().await?;
            directory
                .metadata
                .apply_remote(&plan.session, &directory.destination)
                .await?;
        }
        context.begin_finalizing().await?;
        for (root_index, root) in plan.roots.iter().enumerate() {
            context.checkpoint().await?;
            pending_cleanup.extend(
                commit_remote_root_tracked(
                    &plan.workspace,
                    &plan.session,
                    root,
                    &cleanup_scope,
                    context,
                )
                .await?,
            );
            let completed = plan
                .files
                .iter()
                .enumerate()
                .filter(|(index, file)| successful[*index] && file.root_index == root_index)
                .count() as u64;
            context.roots_committed(1, completed).await?;
        }
        Ok(())
    }
    .await;
    let mut pending = pending_cleanup;
    if result.is_err() && !context.retains_partial(&result) {
        pending.extend(plan.roots.iter().map(|root| root.stage.clone()));
    }
    if !pending.is_empty() && !super::cleanup::should_defer(&result) {
        pending = super::cleanup::remove_now(&plan.workspace, &cleanup_scope, &pending).await;
    }
    super::cleanup::schedule(cleanup_scope, pending);
    close_sftp(&plan.session).await;
    result
}

/// 执行 SSH 下载并确保独立 SFTP channel 在终态前关闭。
pub(crate) async fn execute_download(
    plan: RemoteDownloadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context
        .prepare_resume(crate::resume::ResumeState::download(&plan))
        .await?;
    context.set_stage(TransferStage::Transferring).await;
    let raw_session = super::session::open_raw(&plan.workspace).await?;
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            match tokio::fs::symlink_metadata(&directory.destination).await {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err(crate::resume::changed()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    tokio::fs::create_dir(&directory.destination)
                        .await
                        .map_err(|error| io_failure("create download staging directory", &error))?;
                }
                Err(error) => {
                    return Err(io_failure("inspect download staging directory", &error).into())
                }
            }
        }
        let mut successful = vec![true; plan.files.len()];
        for (index, file) in plan.files.iter().enumerate() {
            let result = async {
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
                file.metadata.apply_local(&file.destination).await
            }
            .await;
            match result {
                Ok(()) => {}
                Err(error) => {
                    record_remote_download_failure(&plan, file, error, context).await?;
                    successful[index] = false;
                    remove_local_partial_file(&file.destination).await?;
                    context.save_offset(&file.source, 0).await?;
                }
            }
        }
        context.set_stage(TransferStage::Verifying).await;
        for (index, file) in plan.files.iter().enumerate() {
            if !successful[index] {
                continue;
            }
            context.checkpoint().await?;
            if let Err(error) = verify_local_file(&file.destination, file.size).await {
                record_remote_download_failure(&plan, file, error, context).await?;
                successful[index] = false;
                remove_local_partial_file(&file.destination).await?;
                context.save_offset(&file.source, 0).await?;
            }
        }
        for directory in plan.directories.iter().rev() {
            context.checkpoint().await?;
            directory
                .metadata
                .apply_local(&directory.destination)
                .await?;
        }
        context.begin_finalizing().await?;
        for (root_index, root) in plan.roots.iter().enumerate() {
            context.checkpoint().await?;
            let pending_cleanup =
                commit_local_root_tracked(root, &plan.task_id, &plan.owner_task_id, context)
                    .await?;
            let completed = plan
                .files
                .iter()
                .enumerate()
                .filter(|(index, file)| successful[*index] && file.root_index == root_index)
                .count() as u64;
            let progress = context.roots_committed(1, completed).await;
            schedule_local_cleanup(&plan.owner_task_id, pending_cleanup);
            progress?;
        }
        Ok(())
    }
    .await;
    if result.is_err() && !context.retains_partial(&result) {
        cleanup_local_staging(&plan.task_id, &plan.owner_task_id, &plan.roots).await;
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
    let mut reader = crate::source::open_verified_file(
        &file.source,
        file.source_identity,
        file.size,
        file.metadata.modified(),
    )
    .await?;
    upload_stream(session, &mut reader, &file.destination, file.size, context).await?;
    crate::source::verify_opened_file(
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
    Ok(())
}

/// 将 SSH 上传目录内的文件错误隔离到失败列表，连接和容量故障仍终止任务。
async fn record_remote_upload_failure(
    plan: &RemoteUploadPlan,
    file: &RemoteUploadFile,
    error: TransferRunError,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let Some(root) = plan.roots.get(file.root_index) else {
        return Err(TransferRunError::failed(
            TransferErrorCode::Internal,
            "transfer file references a missing root",
        ));
    };
    if root.kind != TransferEntryKind::Directory || file.destination == root.stage {
        return Err(error);
    }
    if !error.is_file_scoped() {
        return Err(error);
    }
    context
        .record_file_failure(TransferFileFailure {
            id: Uuid::new_v4().to_string(),
            source_path: file.source.to_string_lossy().into_owned(),
            destination_path: file.final_destination.clone(),
            failure: error
                .failure()
                .expect("file-scoped errors contain a failure"),
            attempts: 1,
            ignored: false,
        })
        .await
}

/// 将 SSH 下载目录内的文件错误隔离到失败列表，顶层单文件保持任务级失败。
async fn record_remote_download_failure(
    plan: &RemoteDownloadPlan,
    file: &RemoteDownloadFile,
    error: TransferRunError,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let Some(root) = plan.roots.get(file.root_index) else {
        return Err(TransferRunError::failed(
            TransferErrorCode::Internal,
            "transfer file references a missing root",
        ));
    };
    if root.kind != TransferEntryKind::Directory || file.destination == root.stage {
        return Err(error);
    }
    if !error.is_file_scoped() {
        return Err(error);
    }
    context
        .record_file_failure(TransferFileFailure {
            id: Uuid::new_v4().to_string(),
            source_path: file.source.clone(),
            destination_path: file.final_destination.to_string_lossy().into_owned(),
            failure: error
                .failure()
                .expect("file-scoped errors contain a failure"),
            attempts: 1,
            ignored: false,
        })
        .await
}

async fn remove_remote_partial_file(session: &Arc<SftpSession>, path: &str) -> RunResult<()> {
    let removal = super::io::run(
        format!("remove partial remote transfer file {path}"),
        session.remove_file(path.to_string()),
    )
    .await;
    if removal.is_ok() {
        return Ok(());
    }
    let exists = super::io::run(
        format!("check partial remote transfer file {path}"),
        session.try_exists(path.to_string()),
    )
    .await?;
    if exists {
        removal
    } else {
        Ok(())
    }
}

async fn remove_local_partial_file(path: &Path) -> RunResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TransferRunError::Failed(io_failure(
            format!("remove partial transfer file {}", path.display()),
            &error,
        ))),
    }
}

/// 上传只在全部 WRITE 确认并同步后推进偏移；失败后重新打开文件，不重放 write_all。
pub(crate) async fn upload_stream(
    session: &Arc<SftpSession>,
    reader: &mut tokio::fs::File,
    remote: &str,
    size: u64,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let control = context.control();
    let saved = context.resume_offset(remote);
    let known = context
        .resume
        .as_ref()
        .is_some_and(|state| state.files.contains_key(remote));
    let (flags, truncate) = if !known {
        // 新文件直接排他创建，避免每个小文件额外一次远端 stat。
        context.save_offset(remote, 0).await?;
        (
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            false,
        )
    } else {
        let existing = super::io::run_cancellable(
            "inspect partial upload",
            session.symlink_metadata(remote),
            &control,
        )
        .await;
        match existing {
            Ok(metadata) if metadata.is_regular() => {
                crate::resume::validated_offset(saved, metadata.size.unwrap_or(0), size)?;
                if saved == size && metadata.size == Some(size) {
                    context.report_bytes(size).await;
                    return Ok(());
                }
                (OpenFlags::WRITE, true)
            }
            Err(TransferRunError::Failed(failure))
                if failure.code == TransferErrorCode::SourceUnavailable && saved == 0 =>
            {
                (
                    OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    false,
                )
            }
            Err(error) => return Err(error),
            _ => return Err(crate::resume::changed()),
        }
    };
    let mut writer = super::io::run_cancellable(
        "open partial upload",
        session.open_with_flags(remote, flags),
        &control,
    )
    .await?;
    if truncate {
        super::io::run_cancellable(
            "truncate unconfirmed upload tail",
            writer.set_metadata(FileAttributes {
                size: Some(saved),
                ..Default::default()
            }),
            &control,
        )
        .await?;
    }
    reader
        .seek(std::io::SeekFrom::Start(saved))
        .await
        .map_err(|error| io_failure("seek upload source", &error))?;
    super::io::run_cancellable(
        "seek partial upload",
        writer.seek(std::io::SeekFrom::Start(saved)),
        &control,
    )
    .await?;
    context.report_bytes(saved).await;
    let mut offset = saved;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    while offset < size {
        context.checkpoint().await?;
        let length = (size - offset).min(buffer.len() as u64) as usize;
        let read = reader
            .read(&mut buffer[..length])
            .await
            .map_err(|error| io_failure("read upload source", &error))?;
        if read == 0 {
            return Err(crate::resume::changed());
        }
        super::io::run_cancellable(
            format!("write remote destination {remote} offset={offset}"),
            writer.write_all(&buffer[..read]),
            &control,
        )
        .await?;
        offset += read as u64;
        context.report_bytes(read as u64).await;
        if offset == size
            || offset.saturating_sub(context.resume_offset(remote))
                >= crate::resume::CHECKPOINT_BYTES
        {
            super::io::run_cancellable("flush upload checkpoint", writer.flush(), &control).await?;
            super::io::run_cancellable("sync upload checkpoint", writer.sync_all(), &control)
                .await?;
            context.save_offset(remote, offset).await?;
        }
    }
    if saved == size {
        super::io::run_cancellable(
            "sync empty or truncated upload",
            writer.sync_all(),
            &control,
        )
        .await?;
        context.save_offset(remote, size).await?;
    }
    super::io::run_cancellable("close remote destination", writer.shutdown(), &control).await?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_sha256_accepts_out_of_order_download_blocks() {
        let mut digest = OrderedSha256::new();
        assert!(digest.push(4, b"efgh".to_vec()));
        assert!(digest.push(0, b"abcd".to_vec()));
        assert_eq!(
            digest.finish(8).unwrap(),
            format!("{:x}", Sha256::digest(b"abcdefgh"))
        );
    }

    #[test]
    fn ordered_sha256_rejects_duplicate_or_incomplete_blocks() {
        let mut duplicate = OrderedSha256::new();
        assert!(duplicate.push(4, b"efgh".to_vec()));
        assert!(!duplicate.push(4, b"other".to_vec()));

        let mut incomplete = OrderedSha256::new();
        assert!(incomplete.push(4, b"efgh".to_vec()));
        assert!(incomplete.finish(8).is_none());
    }

    #[test]
    fn ordered_sha256_reports_out_of_order_buffer_usage() {
        let mut digest = OrderedSha256::new();
        for offset in 1..MAX_INFLIGHT_READS {
            assert!(digest.push(offset as u64, vec![0]));
        }
        assert_eq!(digest.buffered_chunks(), MAX_INFLIGHT_READS - 1);
        assert!(digest.push(0, vec![0]));
        assert_eq!(digest.buffered_chunks(), 0);
    }
}
