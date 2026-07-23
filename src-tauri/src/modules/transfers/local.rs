//! Host 与 WSL 之间的 Direct 文件传输执行器。
//!
//! 来源与目标均已由 Planner 规范化。本模块只向任务私有 staging 写入数据，校验
//! 文件长度后通过 Committer 公开顶层目标。

use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::commit::{cleanup_local_staging, commit_local_root};
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
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_local_staging(&plan.roots).await;
    }
    result
}

/// 复制一个同宿主文件并在关闭前同步目标数据。
async fn copy_local_file(file: &LocalFile, context: &mut ExecutionContext) -> RunResult<()> {
    context
        .set_current_file(file.source.to_string_lossy().into_owned())
        .await;
    let mut reader = tokio::fs::File::open(&file.source)
        .await
        .map_err(|error| message(format!("open source {}: {error}", file.source.display())))?;
    let mut writer = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file.destination)
        .await
        .map_err(|error| {
            message(format!(
                "create destination {}: {error}",
                file.destination.display()
            ))
        })?;
    copy_stream(&mut reader, &mut writer, context).await?;
    writer.flush().await.map_err(|error| {
        message(format!(
            "flush destination {}: {error}",
            file.destination.display()
        ))
    })?;
    writer.sync_all().await.map_err(|error| {
        message(format!(
            "sync destination {}: {error}",
            file.destination.display()
        ))
    })?;
    verify_source_size(&file.source, file.size, file.metadata.modified()).await?;
    file.metadata.apply_local(&file.destination).await?;
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
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| message(format!("read transfer source: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        writer
            .write_all(&buffer[..read])
            .await
            .map_err(|error| message(format!("write transfer destination: {error}")))?;
        context.report_bytes(read as u64).await;
    }
}

/// 检查本地来源在复制期间是否发生长度变化。
async fn verify_source_size(
    path: &Path,
    expected_size: u64,
    expected_modified: Option<std::time::SystemTime>,
) -> RunResult<()> {
    let actual = tokio::fs::metadata(path)
        .await
        .map_err(|error| message(format!("verify source {}: {error}", path.display())))?;
    if actual.len() != expected_size
        || expected_modified.is_some_and(|expected| actual.modified().ok() != Some(expected))
    {
        return Err(message(format!(
            "source changed during transfer: {}",
            path.display(),
        )));
    }
    Ok(())
}

/// 校验本地 staging 文件长度与扫描结果一致。
async fn verify_local_file(path: &Path, expected: u64) -> RunResult<()> {
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
    TransferRunError::Message(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verification_rejects_changed_file_sizes() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let destination = directory.path().join("destination");
        tokio::fs::write(&source, b"source").await.unwrap();
        tokio::fs::write(&destination, b"target").await.unwrap();

        let modified = tokio::fs::metadata(&source).await.unwrap().modified().ok();
        assert!(verify_source_size(&source, 1, modified).await.is_err());
        assert!(verify_local_file(&destination, 1).await.is_err());
        assert!(verify_source_size(&source, 6, modified).await.is_ok());
        assert!(verify_local_file(&destination, 6).await.is_ok());
    }
}
