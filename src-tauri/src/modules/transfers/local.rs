//! Host 与 WSL 之间的 Direct 文件传输执行器。
//!
//! 来源与目标均已由 Planner 规范化。本模块只向任务私有 staging 写入数据，校验
//! 文件长度后通过 Committer 公开顶层目标。

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::commit::{
    cleanup_local_staging, commit_local_root_tracked, commit_local_roots_tracked,
    schedule_local_cleanup,
};
use super::errors::{io_failure, TransferErrorCode};
use super::manager::TransferRunError;
use super::models::TransferStage;
use super::models::{TransferEntryKind, TransferFileFailure};
use super::planner::{LocalFile, LocalPlan};
use super::progress::ExecutionContext;
use uuid::Uuid;

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
        let mut successful = vec![true; plan.files.len()];
        for (index, file) in plan.files.iter().enumerate() {
            if let Err(error) = copy_local_file(file, context).await {
                record_local_file_failure(&plan, file, error, context).await?;
                successful[index] = false;
                remove_partial_file(&file.destination).await?;
            }
        }
        verify_apply_commit_direct(&plan, &mut successful, context).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_local_staging(&plan.task_id, &plan.owner_task_id, &plan.roots).await;
    }
    result
}

/// 复验 staging、恢复 Manifest 元数据并以 no-replace 方式提交全部顶层目标。
#[cfg(windows)]
pub(crate) async fn verify_apply_commit(
    plan: &LocalPlan,
    committed_files: u64,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut successful = vec![true; plan.files.len()];
    verify_apply_commit_inner(
        plan,
        &mut successful,
        false,
        false,
        committed_files,
        context,
    )
    .await
}

async fn verify_apply_commit_direct(
    plan: &LocalPlan,
    successful: &mut [bool],
    context: &mut ExecutionContext,
) -> RunResult<()> {
    verify_apply_commit_inner(plan, successful, true, true, 0, context).await
}

async fn verify_apply_commit_inner(
    plan: &LocalPlan,
    successful: &mut [bool],
    allow_file_failures: bool,
    count_after_commit: bool,
    transaction_files: u64,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Verifying).await;
    for (index, file) in plan.files.iter().enumerate() {
        if !successful[index] {
            continue;
        }
        context.checkpoint().await?;
        let result = async {
            verify_local_file(&file.destination, file.size).await?;
            file.metadata.apply_local(&file.destination).await
        }
        .await;
        match result {
            Ok(()) => {}
            Err(error) => {
                if !allow_file_failures {
                    return Err(error);
                }
                record_local_file_failure(plan, file, error, context).await?;
                successful[index] = false;
                remove_partial_file(&file.destination).await?;
            }
        }
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
    context.begin_finalizing().await?;
    if count_after_commit {
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
    } else {
        context.checkpoint().await?;
        let pending_cleanup =
            commit_local_roots_tracked(&plan.roots, &plan.task_id, &plan.owner_task_id, context)
                .await?;
        let progress = context
            .roots_committed(plan.roots.len() as u64, transaction_files)
            .await;
        schedule_local_cleanup(&plan.owner_task_id, pending_cleanup);
        progress?;
    }
    Ok(())
}

/// 将目录根内的可恢复文件错误记录为局部失败，任务级错误仍交给上层终止。
async fn record_local_file_failure(
    plan: &LocalPlan,
    file: &LocalFile,
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
    let failure = error
        .failure()
        .expect("file-scoped errors contain a failure");
    context
        .record_file_failure(TransferFileFailure {
            id: Uuid::new_v4().to_string(),
            source_path: file.retry_source_path.clone(),
            destination_path: file.final_destination_path.clone(),
            failure,
            attempts: 1,
            ignored: false,
        })
        .await?;
    Ok(())
}

async fn remove_partial_file(path: &std::path::Path) -> RunResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TransferRunError::Failed(io_failure(
            format!("remove partial transfer file {}", path.display()),
            &error,
        ))),
    }
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
