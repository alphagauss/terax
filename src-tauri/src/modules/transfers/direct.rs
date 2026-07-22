//! Direct 文件传输的扫描、流式复制与原子提交。
//!
//! 每个顶层来源先写入目标同级 staging 路径，全部文件完成大小校验后再重命名。
//! 当前版本顺序复制文件，后续可在不改变任务协议的前提下增加文件级并发和 journal。

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::modules::remote;
use crate::modules::remote::session::{join_remote, RemoteWorkspace};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

use super::manager::{ExecutionContext, TransferRunError};
use super::models::{EnqueueTransferRequest, TransferDirection, TransferStage};

const COPY_BUFFER_BYTES: usize = 256 * 1024;

type RunResult<T> = Result<T, TransferRunError>;

struct LocalRoot {
    stage: PathBuf,
    final_path: PathBuf,
}

struct LocalFile {
    source: PathBuf,
    destination: PathBuf,
    size: u64,
}

struct LocalPlan {
    directories: Vec<PathBuf>,
    files: Vec<LocalFile>,
    roots: Vec<LocalRoot>,
}

struct RemoteRoot {
    stage: String,
    final_path: String,
}

struct RemoteUploadFile {
    source: PathBuf,
    destination: String,
    size: u64,
}

struct RemoteUploadPlan {
    workspace: Arc<RemoteWorkspace>,
    session: Arc<SftpSession>,
    directories: Vec<String>,
    files: Vec<RemoteUploadFile>,
    roots: Vec<RemoteRoot>,
}

struct RemoteDownloadFile {
    source: String,
    destination: PathBuf,
    size: u64,
}

struct RemoteDownloadPlan {
    session: Arc<SftpSession>,
    directories: Vec<PathBuf>,
    files: Vec<RemoteDownloadFile>,
    roots: Vec<LocalRoot>,
}

enum DirectPlan {
    Local(LocalPlan),
    RemoteUpload(RemoteUploadPlan),
    RemoteDownload(RemoteDownloadPlan),
}

impl DirectPlan {
    fn totals(&self) -> (u64, u64) {
        match self {
            Self::Local(plan) => totals(plan.files.iter().map(|file| file.size)),
            Self::RemoteUpload(plan) => totals(plan.files.iter().map(|file| file.size)),
            Self::RemoteDownload(plan) => totals(plan.files.iter().map(|file| file.size)),
        }
    }
}

/// 扫描并执行一个 Direct 传输任务。
///
/// 返回值是发生工作区写入的路径，供 Explorer 精确刷新。下载只写宿主机目录，
/// 因此返回空列表。
pub(crate) async fn execute(
    workspace: &WorkspaceEnv,
    request: &EnqueueTransferRequest,
    task_id: &str,
    context: &mut ExecutionContext,
) -> RunResult<Vec<String>> {
    context.checkpoint().await?;
    let plan = match workspace {
        WorkspaceEnv::Local => {
            return Err(TransferRunError::Message(
                "local workspaces do not require file transfer".into(),
            ));
        }
        WorkspaceEnv::Wsl { .. } => {
            let (sources, destination, sanitize_names) = match request.direction {
                TransferDirection::Upload => {
                    validate_wsl_path(&request.destination)?;
                    (
                        request.sources.iter().map(PathBuf::from).collect(),
                        resolve_path(&request.destination, workspace),
                        false,
                    )
                }
                TransferDirection::Download => {
                    for source in &request.sources {
                        validate_wsl_path(source)?;
                    }
                    (
                        request
                            .sources
                            .iter()
                            .map(|source| resolve_path(source, workspace))
                            .collect(),
                        PathBuf::from(&request.destination),
                        true,
                    )
                }
            };
            DirectPlan::Local(
                plan_local(sources, destination, sanitize_names, task_id, context).await?,
            )
        }
        WorkspaceEnv::Ssh { profile_id } => {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let session = remote::sftp::open_session(&remote_workspace).await?;
            let planned = match request.direction {
                TransferDirection::Upload => plan_remote_upload(
                    remote_workspace,
                    session.clone(),
                    &request.sources,
                    &request.destination,
                    task_id,
                    context,
                )
                .await
                .map(DirectPlan::RemoteUpload),
                TransferDirection::Download => plan_remote_download(
                    remote_workspace,
                    session.clone(),
                    &request.sources,
                    Path::new(&request.destination),
                    task_id,
                    context,
                )
                .await
                .map(DirectPlan::RemoteDownload),
            };
            match planned {
                Ok(plan) => plan,
                Err(error) => {
                    close_sftp(&session).await;
                    return Err(error);
                }
            }
        }
    };

    let (total_files, total_bytes) = plan.totals();
    context.set_totals(total_files, total_bytes).await;
    let result = match plan {
        DirectPlan::Local(plan) => execute_local(plan, context).await,
        DirectPlan::RemoteUpload(plan) => execute_remote_upload(plan, context).await,
        DirectPlan::RemoteDownload(plan) => execute_remote_download(plan, context).await,
    };
    result?;
    Ok(if request.direction == TransferDirection::Upload {
        vec![request.destination.clone()]
    } else {
        Vec::new()
    })
}

/// 扫描同一宿主文件系统中的来源，并为每个顶层项目生成同级 staging 目标。
async fn plan_local(
    sources: Vec<PathBuf>,
    destination_parent: PathBuf,
    sanitize_names: bool,
    task_id: &str,
    context: &ExecutionContext,
) -> RunResult<LocalPlan> {
    let destination_metadata = tokio::fs::metadata(&destination_parent)
        .await
        .map_err(|error| {
            message(format!(
                "stat destination {}: {error}",
                destination_parent.display()
            ))
        })?;
    if !destination_metadata.is_dir() {
        return Err(message(format!(
            "transfer destination is not a directory: {}",
            destination_parent.display()
        )));
    }
    let destination_parent = tokio::fs::canonicalize(&destination_parent)
        .await
        .map_err(|error| message(format!("canonicalize destination: {error}")))?;
    let mut plan = LocalPlan {
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
    };
    let mut root_names = HashSet::new();

    for source in sources {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| message(format!("stat source {}: {error}", source.display())))?;
        reject_local_symlink_or_special(&source, &metadata)?;
        let source = tokio::fs::canonicalize(&source).await.map_err(|error| {
            message(format!("canonicalize source {}: {error}", source.display()))
        })?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| message(format!("stat source {}: {error}", source.display())))?;
        reject_local_symlink_or_special(&source, &metadata)?;
        let source_name = source
            .file_name()
            .ok_or_else(|| message(format!("invalid source path: {}", source.display())))?;
        let destination_name = local_destination_name(source_name, sanitize_names);
        let identity = local_name_identity(&destination_name);
        if !root_names.insert(identity) {
            return Err(message(format!(
                "multiple sources map to the same destination name: {}",
                destination_name.to_string_lossy()
            )));
        }
        let final_path = destination_parent.join(&destination_name);
        validate_local_relationship(&source, &final_path, metadata.is_dir())?;
        ensure_local_target_available(&final_path).await?;
        let stage = local_stage_path(&final_path, task_id, plan.roots.len())?;
        ensure_local_target_available(&stage).await?;
        plan.roots.push(LocalRoot {
            stage: stage.clone(),
            final_path,
        });

        if metadata.is_file() {
            plan.files.push(LocalFile {
                source,
                destination: stage,
                size: metadata.len(),
            });
            continue;
        }

        plan.directories.push(stage.clone());
        let mut pending = vec![(source, stage)];
        while let Some((source_dir, destination_dir)) = pending.pop() {
            context.checkpoint().await?;
            let mut entries = tokio::fs::read_dir(&source_dir).await.map_err(|error| {
                message(format!("read directory {}: {error}", source_dir.display()))
            })?;
            let mut destination_names = HashSet::new();
            while let Some(entry) = entries.next_entry().await.map_err(|error| {
                message(format!("read directory {}: {error}", source_dir.display()))
            })? {
                context.checkpoint().await?;
                let source_path = entry.path();
                let metadata =
                    tokio::fs::symlink_metadata(&source_path)
                        .await
                        .map_err(|error| {
                            message(format!("stat source {}: {error}", source_path.display()))
                        })?;
                reject_local_symlink_or_special(&source_path, &metadata)?;
                let name = local_destination_name(&entry.file_name(), sanitize_names);
                if !destination_names.insert(local_name_identity(&name)) {
                    return Err(message(format!(
                        "source names collide after local filename sanitization in {}",
                        source_dir.display()
                    )));
                }
                let destination_path = destination_dir.join(name);
                if metadata.is_dir() {
                    plan.directories.push(destination_path.clone());
                    pending.push((source_path, destination_path));
                } else {
                    plan.files.push(LocalFile {
                        source: source_path,
                        destination: destination_path,
                        size: metadata.len(),
                    });
                }
            }
        }
    }
    Ok(plan)
}

/// 扫描宿主机来源并生成 SSH 上传计划，远端目标必须位于 Workspace 根内。
async fn plan_remote_upload(
    workspace: Arc<RemoteWorkspace>,
    session: Arc<SftpSession>,
    sources: &[String],
    destination_parent: &str,
    task_id: &str,
    context: &ExecutionContext,
) -> RunResult<RemoteUploadPlan> {
    let destination_parent =
        canonical_remote_directory(&workspace, &session, destination_parent).await?;
    let mut plan = RemoteUploadPlan {
        workspace,
        session,
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
    };
    let mut root_names = HashSet::new();

    for source in sources {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(source)
            .await
            .map_err(|error| message(format!("stat source {source}: {error}")))?;
        reject_local_symlink_or_special(Path::new(source), &metadata)?;
        let source = tokio::fs::canonicalize(source)
            .await
            .map_err(|error| message(format!("canonicalize source {source}: {error}")))?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| message(format!("stat source {}: {error}", source.display())))?;
        reject_local_symlink_or_special(&source, &metadata)?;
        let name = source
            .file_name()
            .and_then(OsStr::to_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| message(format!("invalid local source: {}", source.display())))?
            .to_string();
        if !root_names.insert(name.clone()) {
            return Err(message(format!("duplicate destination name: {name}")));
        }
        let final_path = join_remote(&destination_parent, &name);
        ensure_remote_target_available(&plan.session, &final_path).await?;
        let stage = remote_stage_path(&final_path, task_id, plan.roots.len())?;
        ensure_remote_target_available(&plan.session, &stage).await?;
        plan.roots.push(RemoteRoot {
            stage: stage.clone(),
            final_path,
        });

        if metadata.is_file() {
            plan.files.push(RemoteUploadFile {
                source,
                destination: stage,
                size: metadata.len(),
            });
            continue;
        }

        plan.directories.push(stage.clone());
        let mut pending = vec![(source, stage)];
        while let Some((source_dir, destination_dir)) = pending.pop() {
            context.checkpoint().await?;
            let mut entries = tokio::fs::read_dir(&source_dir).await.map_err(|error| {
                message(format!("read directory {}: {error}", source_dir.display()))
            })?;
            while let Some(entry) = entries.next_entry().await.map_err(|error| {
                message(format!("read directory {}: {error}", source_dir.display()))
            })? {
                context.checkpoint().await?;
                let source_path = entry.path();
                let metadata =
                    tokio::fs::symlink_metadata(&source_path)
                        .await
                        .map_err(|error| {
                            message(format!("stat source {}: {error}", source_path.display()))
                        })?;
                reject_local_symlink_or_special(&source_path, &metadata)?;
                let name = entry.file_name().into_string().map_err(|_| {
                    message(format!(
                        "non-UTF-8 filename is not supported: {}",
                        source_path.display()
                    ))
                })?;
                let destination_path = join_remote(&destination_dir, &name);
                if metadata.is_dir() {
                    plan.directories.push(destination_path.clone());
                    pending.push((source_path, destination_path));
                } else {
                    plan.files.push(RemoteUploadFile {
                        source: source_path,
                        destination: destination_path,
                        size: metadata.len(),
                    });
                }
            }
        }
    }
    Ok(plan)
}

/// 扫描 SSH 来源并生成下载计划，同时处理 Windows 不合法文件名冲突。
async fn plan_remote_download(
    workspace: Arc<RemoteWorkspace>,
    session: Arc<SftpSession>,
    sources: &[String],
    destination_parent: &Path,
    task_id: &str,
    context: &ExecutionContext,
) -> RunResult<RemoteDownloadPlan> {
    let destination_metadata = tokio::fs::metadata(destination_parent)
        .await
        .map_err(|error| {
            message(format!(
                "stat destination {}: {error}",
                destination_parent.display()
            ))
        })?;
    if !destination_metadata.is_dir() {
        return Err(message(format!(
            "transfer destination is not a directory: {}",
            destination_parent.display()
        )));
    }
    let destination_parent = tokio::fs::canonicalize(destination_parent)
        .await
        .map_err(|error| message(format!("canonicalize destination: {error}")))?;
    let home = workspace.home().await;
    let home = session
        .canonicalize(home)
        .await
        .map_err(|error| message(format!("canonicalize remote root: {error}")))?;
    let mut plan = RemoteDownloadPlan {
        session,
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
    };
    let mut root_names = HashSet::new();

    for source in sources {
        context.checkpoint().await?;
        let source_metadata = plan
            .session
            .symlink_metadata(source.clone())
            .await
            .map_err(|error| message(format!("stat remote source {source}: {error}")))?;
        reject_remote_symlink_or_special(source, source_metadata.file_type())?;
        let source = plan
            .session
            .canonicalize(source.clone())
            .await
            .map_err(|error| message(format!("canonicalize remote source {source}: {error}")))?;
        if !remote_path_within(&source, &home) {
            return Err(message(format!(
                "remote source is outside workspace root: {source}"
            )));
        }
        let source_name = remote_name(&source)?.to_string();
        let destination_name = remote::sftp::sanitize_local_name(&source_name);
        if !root_names.insert(local_name_identity(OsStr::new(&destination_name))) {
            return Err(message(format!(
                "multiple remote sources map to the same local name: {destination_name}"
            )));
        }
        let final_path = destination_parent.join(destination_name);
        ensure_local_target_available(&final_path).await?;
        let stage = local_stage_path(&final_path, task_id, plan.roots.len())?;
        ensure_local_target_available(&stage).await?;
        plan.roots.push(LocalRoot {
            stage: stage.clone(),
            final_path,
        });

        if source_metadata.file_type().is_file() {
            plan.files.push(RemoteDownloadFile {
                source,
                destination: stage,
                size: remote_size(&source_metadata, &source_name)?,
            });
            continue;
        }

        plan.directories.push(stage.clone());
        let mut pending = vec![(source, stage)];
        while let Some((source_dir, destination_dir)) = pending.pop() {
            context.checkpoint().await?;
            let entries = plan
                .session
                .read_dir(source_dir.clone())
                .await
                .map_err(|error| message(format!("read remote directory {source_dir}: {error}")))?;
            let mut destination_names = HashSet::new();
            for entry in entries {
                context.checkpoint().await?;
                let entry_type = entry.file_type();
                let source_path = entry.path();
                reject_remote_symlink_or_special(&source_path, entry_type)?;
                let destination_name = remote::sftp::sanitize_local_name(&entry.file_name());
                if !destination_names.insert(local_name_identity(OsStr::new(&destination_name))) {
                    return Err(message(format!(
                        "remote names collide after local filename sanitization in {source_dir}"
                    )));
                }
                let destination_path = destination_dir.join(destination_name);
                if entry_type.is_dir() {
                    plan.directories.push(destination_path.clone());
                    pending.push((source_path, destination_path));
                } else {
                    let metadata = entry.metadata();
                    plan.files.push(RemoteDownloadFile {
                        source: source_path.clone(),
                        destination: destination_path,
                        size: remote_size(&metadata, &source_path)?,
                    });
                }
            }
        }
    }
    Ok(plan)
}

/// 执行 WSL 与宿主机之间的流式复制，并在所有校验成功后提交顶层目标。
async fn execute_local(plan: LocalPlan, context: &mut ExecutionContext) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let mut committed = Vec::new();
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            tokio::fs::create_dir(directory).await.map_err(|error| {
                message(format!("create directory {}: {error}", directory.display()))
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
        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            ensure_local_target_available(&root.final_path).await?;
            tokio::fs::rename(&root.stage, &root.final_path)
                .await
                .map_err(|error| {
                    message(format!(
                        "commit transfer {}: {error}",
                        root.final_path.display()
                    ))
                })?;
            committed.push(root.final_path.clone());
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_local_roots(&plan.roots, &committed).await;
    }
    result
}

/// 执行 SSH 上传并确保独立 SFTP channel 在终态前关闭。
async fn execute_remote_upload(
    plan: RemoteUploadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let mut committed = Vec::new();
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            plan.session
                .create_dir(directory.clone())
                .await
                .map_err(|error| {
                    message(format!("create remote directory {directory}: {error}"))
                })?;
        }
        for file in &plan.files {
            copy_remote_upload_file(&plan.session, file, context).await?;
        }
        context.set_stage(TransferStage::Verifying).await;
        for file in &plan.files {
            context.checkpoint().await?;
            verify_remote_file(&plan.session, &file.destination, file.size).await?;
        }
        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            ensure_remote_target_available(&plan.session, &root.final_path).await?;
            plan.session
                .rename(root.stage.clone(), root.final_path.clone())
                .await
                .map_err(|error| {
                    message(format!(
                        "commit remote transfer {}: {error}",
                        root.final_path
                    ))
                })?;
            committed.push(root.final_path.clone());
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_remote_roots(&plan.workspace, &plan.roots, &committed).await;
    }
    close_sftp(&plan.session).await;
    result
}

/// 执行 SSH 下载并确保独立 SFTP channel 在终态前关闭。
async fn execute_remote_download(
    plan: RemoteDownloadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::Transferring).await;
    let mut committed = Vec::new();
    let result = async {
        for directory in &plan.directories {
            context.checkpoint().await?;
            tokio::fs::create_dir(directory).await.map_err(|error| {
                message(format!("create directory {}: {error}", directory.display()))
            })?;
        }
        for file in &plan.files {
            copy_remote_download_file(&plan.session, file, context).await?;
        }
        context.set_stage(TransferStage::Verifying).await;
        for file in &plan.files {
            context.checkpoint().await?;
            verify_local_file(&file.destination, file.size).await?;
        }
        context.set_stage(TransferStage::Finalizing).await;
        for root in &plan.roots {
            context.checkpoint().await?;
            ensure_local_target_available(&root.final_path).await?;
            tokio::fs::rename(&root.stage, &root.final_path)
                .await
                .map_err(|error| {
                    message(format!(
                        "commit transfer {}: {error}",
                        root.final_path.display()
                    ))
                })?;
            committed.push(root.final_path.clone());
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        cleanup_local_roots(&plan.roots, &committed).await;
    }
    close_sftp(&plan.session).await;
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
    verify_source_size(&file.source, file.size).await?;
    context.complete_file().await;
    Ok(())
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
    let mut reader = tokio::fs::File::open(&file.source)
        .await
        .map_err(|error| message(format!("open source {}: {error}", file.source.display())))?;
    let mut writer = session
        .open_with_flags(
            file.destination.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(|error| message(format!("create remote file {}: {error}", file.destination)))?;
    copy_stream(&mut reader, &mut writer, context).await?;
    writer
        .flush()
        .await
        .map_err(|error| message(format!("flush remote file {}: {error}", file.destination)))?;
    writer
        .sync_all()
        .await
        .map_err(|error| message(format!("sync remote file {}: {error}", file.destination)))?;
    writer
        .shutdown()
        .await
        .map_err(|error| message(format!("close remote file {}: {error}", file.destination)))?;
    verify_source_size(&file.source, file.size).await?;
    context.complete_file().await;
    Ok(())
}

/// 将一个远端文件写入宿主机排他目标并同步落盘。
async fn copy_remote_download_file(
    session: &Arc<SftpSession>,
    file: &RemoteDownloadFile,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_current_file(file.source.clone()).await;
    let mut reader = session
        .open(file.source.clone())
        .await
        .map_err(|error| message(format!("open remote source {}: {error}", file.source)))?;
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
async fn verify_source_size(path: &Path, expected: u64) -> RunResult<()> {
    let actual = tokio::fs::metadata(path)
        .await
        .map_err(|error| message(format!("verify source {}: {error}", path.display())))?
        .len();
    if actual != expected {
        return Err(message(format!(
            "source changed during transfer: {} (expected {expected} bytes, found {actual})",
            path.display()
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

/// 校验远端 staging 文件长度与扫描结果一致。
async fn verify_remote_file(
    session: &Arc<SftpSession>,
    path: &str,
    expected: u64,
) -> RunResult<()> {
    let metadata = session
        .metadata(path.to_string())
        .await
        .map_err(|error| message(format!("verify remote destination {path}: {error}")))?;
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

/// 规范化远端目录并确保其没有逃逸当前 SSH Workspace 根。
async fn canonical_remote_directory(
    workspace: &Arc<RemoteWorkspace>,
    session: &Arc<SftpSession>,
    path: &str,
) -> RunResult<String> {
    let home = session
        .canonicalize(workspace.home().await)
        .await
        .map_err(|error| message(format!("canonicalize remote root: {error}")))?;
    let canonical = session
        .canonicalize(path.to_string())
        .await
        .map_err(|error| message(format!("canonicalize remote destination {path}: {error}")))?;
    let metadata = session
        .metadata(canonical.clone())
        .await
        .map_err(|error| message(format!("stat remote destination {canonical}: {error}")))?;
    if !metadata.file_type().is_dir() {
        return Err(message(format!(
            "remote destination is not a directory: {canonical}"
        )));
    }
    if !remote_path_within(&canonical, &home) {
        return Err(message(format!(
            "remote destination is outside workspace root: {canonical}"
        )));
    }
    Ok(canonical)
}

/// 按远端 POSIX 组件边界判断路径是否位于 Workspace 根内。
fn remote_path_within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    root.is_empty() && path.starts_with('/')
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// 校验前端传入的 WSL 规范绝对路径，避免 UNC 转换接受遍历组件。
fn validate_wsl_path(path: &str) -> RunResult<()> {
    if !path.starts_with('/')
        || path.contains(['\\', '\0'])
        || path
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return Err(message(format!("invalid WSL workspace path: {path}")));
    }
    Ok(())
}

fn reject_local_symlink_or_special(path: &Path, metadata: &std::fs::Metadata) -> RunResult<()> {
    if metadata.file_type().is_symlink() {
        return Err(message(format!(
            "symbolic-link transfer is not supported: {}",
            path.display()
        )));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(message(format!(
            "unsupported source type: {}",
            path.display()
        )));
    }
    Ok(())
}

fn reject_remote_symlink_or_special(
    path: &str,
    file_type: russh_sftp::protocol::FileType,
) -> RunResult<()> {
    if file_type.is_symlink() {
        return Err(message(format!(
            "symbolic-link transfer is not supported: {path}"
        )));
    }
    if !file_type.is_file() && !file_type.is_dir() {
        return Err(message(format!("unsupported remote source type: {path}")));
    }
    Ok(())
}

fn remote_size(metadata: &russh_sftp::protocol::FileAttributes, path: &str) -> RunResult<u64> {
    metadata
        .size
        .ok_or_else(|| message(format!("remote file size is unavailable: {path}")))
}

fn local_destination_name(name: &OsStr, sanitize: bool) -> OsString {
    if sanitize {
        remote::sftp::sanitize_local_name(&name.to_string_lossy()).into()
    } else {
        name.to_os_string()
    }
}

fn local_name_identity(name: &OsStr) -> String {
    let value = name.to_string_lossy();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.into_owned()
    }
}

fn validate_local_relationship(
    source: &Path,
    destination: &Path,
    source_is_dir: bool,
) -> RunResult<()> {
    if source == destination || source_is_dir && destination.starts_with(source) {
        return Err(message(format!(
            "destination cannot be the source or its descendant: {}",
            destination.display()
        )));
    }
    Ok(())
}

/// 确认本地目标尚不存在，未知元数据错误不得被当作空闲目标。
async fn ensure_local_target_available(path: &Path) -> RunResult<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Err(message(format!(
            "destination already exists: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(message(format!(
            "stat destination {}: {error}",
            path.display()
        ))),
    }
}

/// 确认远端目标尚不存在。
async fn ensure_remote_target_available(session: &Arc<SftpSession>, path: &str) -> RunResult<()> {
    let exists = session
        .try_exists(path.to_string())
        .await
        .map_err(|error| message(format!("stat remote destination {path}: {error}")))?;
    if exists {
        Err(message(format!("destination already exists: {path}")))
    } else {
        Ok(())
    }
}

/// 为本地目标生成固定长度的同级 staging 路径，避免长文件名突破平台限制。
fn local_stage_path(final_path: &Path, task_id: &str, root_index: usize) -> RunResult<PathBuf> {
    let parent = final_path.parent().ok_or_else(|| {
        message(format!(
            "destination has no parent: {}",
            final_path.display()
        ))
    })?;
    Ok(parent.join(format!(".terax-part-{task_id}-{root_index}")))
}

/// 为远端目标生成固定长度的同级 staging 路径。
fn remote_stage_path(final_path: &str, task_id: &str, root_index: usize) -> RunResult<String> {
    let trimmed = final_path.trim_end_matches('/');
    let (parent, name) = trimmed
        .rsplit_once('/')
        .ok_or_else(|| message(format!("invalid remote destination: {final_path}")))?;
    let parent = if parent.is_empty() { "/" } else { parent };
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(message(format!("invalid remote destination: {final_path}")));
    }
    Ok(join_remote(
        parent,
        &format!(".terax-part-{task_id}-{root_index}"),
    ))
}

fn remote_name(path: &str) -> RunResult<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| message(format!("cannot transfer remote root: {path}")))
}

/// 失败或取消后清理 staging 与本任务已经提交的顶层目标。
async fn cleanup_local_roots(roots: &[LocalRoot], committed: &[PathBuf]) {
    for path in roots.iter().map(|root| &root.stage).chain(committed.iter()) {
        remove_local_path(path).await;
    }
}

async fn remove_local_path(path: &Path) {
    let Ok(metadata) = tokio::fs::symlink_metadata(path).await else {
        return;
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    if let Err(error) = result {
        log::warn!("failed to clean transfer path {}: {error}", path.display());
    }
}

/// 失败或取消后通过远端文件操作清理 staging 与已提交顶层目标。
async fn cleanup_remote_roots(
    workspace: &Arc<RemoteWorkspace>,
    roots: &[RemoteRoot],
    committed: &[String],
) {
    for path in roots
        .iter()
        .map(|root| root.stage.as_str())
        .chain(committed.iter().map(String::as_str))
    {
        if let Err(error) = remote::sftp::delete(workspace, path).await {
            log::warn!("failed to clean remote transfer path {path}: {error}");
        }
    }
}

async fn close_sftp(session: &Arc<SftpSession>) {
    let _ = tokio::time::timeout(Duration::from_secs(1), session.close()).await;
}

fn totals(sizes: impl Iterator<Item = u64>) -> (u64, u64) {
    sizes.fold((0, 0), |(files, bytes), size| {
        (files + 1, bytes.saturating_add(size))
    })
}

fn message(value: String) -> TransferRunError {
    TransferRunError::Message(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_paths_stay_next_to_final_targets() {
        let local = local_stage_path(Path::new("C:/tmp/file.txt"), "task", 3).unwrap();
        assert_eq!(local, PathBuf::from("C:/tmp/.terax-part-task-3"));
        assert_eq!(
            remote_stage_path("/home/me/file.txt", "task", 3).unwrap(),
            "/home/me/.terax-part-task-3"
        );
    }

    #[test]
    fn remote_scope_requires_a_component_boundary() {
        assert!(remote_path_within("/home/me/project", "/home/me"));
        assert!(remote_path_within("/home/me", "/home/me"));
        assert!(!remote_path_within("/home/other", "/home/me"));
        assert!(!remote_path_within("/home/mean", "/home/me"));
        assert!(remote_path_within("/etc", "/"));
    }

    #[test]
    fn wsl_paths_are_absolute_and_cannot_traverse() {
        assert!(validate_wsl_path("/home/me/project").is_ok());
        for path in ["home/me", "/home/../etc", "/home\\me", "/tmp\0file"] {
            assert!(validate_wsl_path(path).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn local_destination_cannot_be_inside_source() {
        let source = Path::new("C:/work/project");
        assert!(
            validate_local_relationship(source, Path::new("C:/work/project/copy"), true).is_err()
        );
        assert!(validate_local_relationship(source, Path::new("C:/work/other"), true).is_ok());
    }

    #[tokio::test]
    async fn existing_targets_are_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let existing = directory.path().join("existing.txt");
        tokio::fs::write(&existing, b"original").await.unwrap();

        assert!(ensure_local_target_available(&existing).await.is_err());
        assert!(
            ensure_local_target_available(&directory.path().join("new.txt"))
                .await
                .is_ok()
        );
        assert_eq!(tokio::fs::read(existing).await.unwrap(), b"original");
    }
}
