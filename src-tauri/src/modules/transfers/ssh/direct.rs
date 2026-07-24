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

use crate::modules::transfers::commit::{
    cleanup_local_staging, commit_local_root, commit_remote_root,
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
    let mut next_offset = 0u64;
    let mut completed = 0u64;
    let mut canceled = false;
    let mut failure = None;
    let mut inflight = FuturesUnordered::new();
    let mut digest = hash_download.then(OrderedSha256::new);

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
            && inflight.len() + digest.as_ref().map_or(0, OrderedSha256::buffered_chunks)
                < MAX_INFLIGHT_READS
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
                    context.report_bytes(data_len).await;
                }
            }
            Err(error) => failure = Some(error),
        }
    }

    if let Some(error) = failure {
        return Err(error);
    }
    if canceled {
        return Err(TransferRunError::Canceled);
    }
    let close_result = super::io::run(
        format!("close remote source {remote}"),
        session.close(handle),
    )
    .await;
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
        let mut pending: Vec<_> = plan.roots.iter().map(|root| root.stage.clone()).collect();
        if !super::cleanup::should_defer(&result) {
            pending = super::cleanup::remove_now(&plan.workspace, &pending).await;
        }
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
