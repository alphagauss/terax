//! Host 与 WSL 之间的 Direct 文件传输执行器。
//!
//! 来源与目标均已由 Planner 规范化。本模块只向任务私有 staging 写入数据，校验
//! 文件长度后通过 Committer 公开顶层目标。

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::commit::{cleanup_local_staging, commit_local_root};
use super::errors::{io_failure, TransferErrorCode};
use super::manager::TransferRunError;
use super::models::TransferStage;
use super::planner::{LocalFile, LocalPlan};
use super::progress::ExecutionContext;

const COPY_BUFFER_BYTES: usize = 256 * 1024;

type RunResult<T> = Result<T, TransferRunError>;

/// 执行 WSL 与宿主机之间的流式复制，并在所有校验成功后提交顶层目标。
pub(crate) async fn execute(plan: LocalPlan, context: &mut ExecutionContext) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            tokio::fs::create_dir(&directory.destination)
                .await
                .map_err(|error| {
                    message(format!(
                        "create directory {}: {error}",
                        directory.destination.display()
                    ))
                })?;
        }
        for file in &plan.files {
            copy_local_file(file, context).await?;
        }
        verify_apply_commit(&plan, context).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_local_staging(&plan.roots).await;
    }
    result
}

/// 复验 staging、恢复 Manifest 元数据并以 no-replace 方式提交全部顶层目标。
pub(crate) async fn verify_apply_commit(
    plan: &LocalPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Verifying).await;
    for file in &plan.files {
        context.checkpoint().await?;
        verify_local_file(&file.destination, file.size).await?;
        file.metadata.apply_local(&file.destination).await?;
        context.complete_file().await;
    }
    for directory in plan.directories.iter().rev() {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&directory.destination)
            .await
            .map_err(|error| {
                message(format!(
                    "verify directory {}: {error}",
                    directory.destination.display()
                ))
            })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(message(format!(
                "destination is not a directory: {}",
                directory.destination.display()
            )));
        }
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

/// 复制一个同宿主文件并在关闭前同步目标数据。
async fn copy_local_file(file: &LocalFile, context: &mut ExecutionContext) -> RunResult<()> {
    context
        .set_current_file(file.source.to_string_lossy().into_owned())
        .await;
    let mut reader = super::source::open_verified_file(
        &file.source,
        file.source_identity,
        file.size,
        file.metadata.modified(),
    )
    .await?;
    let mut writer = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file.destination)
        .await
        .map_err(|error| {
            TransferRunError::Failed(io_failure(
                format!("create destination {}", file.destination.display()),
                &error,
            ))
        })?;
    copy_stream(&mut reader, &mut writer, context).await?;
    writer.flush().await.map_err(|error| {
        TransferRunError::Failed(io_failure(
            format!("flush destination {}", file.destination.display()),
            &error,
        ))
    })?;
    writer.sync_all().await.map_err(|error| {
        TransferRunError::Failed(io_failure(
            format!("sync destination {}", file.destination.display()),
            &error,
        ))
    })?;
    super::source::verify_opened_file(
        &reader,
        &file.source,
        file.source_identity,
        file.size,
        file.metadata.modified(),
    )
    .await?;
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
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| message(format!("read transfer source: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..read]).await.map_err(|error| {
            TransferRunError::Failed(io_failure("write transfer destination", &error))
        })?;
        context.report_bytes(read as u64).await;
    }
}

/// 校验本地 staging 文件长度与扫描结果一致。
async fn verify_local_file(path: &std::path::Path, expected: u64) -> RunResult<()> {
    let actual = tokio::fs::metadata(path)
        .await
        .map_err(|error| message(format!("verify destination {}: {error}", path.display())))?
        .len();
    if actual != expected {
        return Err(message(format!(
            "destination size mismatch: {} (expected {expected} bytes, found {actual})",
            path.display()
        )));
    }
    Ok(())
}

fn message(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IoFailed, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verification_rejects_changed_file_sizes() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("destination");
        tokio::fs::write(&destination, b"target").await.unwrap();

        assert!(verify_local_file(&destination, 1).await.is_err());
        assert!(verify_local_file(&destination, 6).await.is_ok());
    }
}
