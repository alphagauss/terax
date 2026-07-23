//! Direct 与 Archive 共用的只读扫描与 Manifest 生成。
//!
//! 本模块在写入目标前解析来源、校验 Workspace 边界、拒绝符号链接与特殊文件，
//! 并生成带私有 staging 路径的不可变计划。规划阶段不创建或修改文件。

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::SftpSession;

use crate::modules::remote;
use crate::modules::remote::session::{join_remote, RemoteWorkspace};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

use super::commit::{
    ensure_local_target_available, ensure_remote_target_available, local_stage_path,
    remote_stage_path, LocalRoot, RemoteRoot,
};
use super::manager::TransferRunError;
use super::metadata::EntryMetadata;
use super::models::{EnqueueTransferRequest, TransferDirection};
use super::progress::ExecutionContext;

type RunResult<T> = Result<T, TransferRunError>;

/// 同一宿主文件系统中的单文件复制项。
pub(crate) struct LocalFile {
    pub(crate) source: PathBuf,
    pub(crate) destination: PathBuf,
    pub(crate) size: u64,
    pub(crate) metadata: EntryMetadata,
}

/// 创建后需要在子项完成时恢复元数据的目录。
pub(crate) struct PlannedDirectory<S, D> {
    pub(crate) source: S,
    pub(crate) destination: D,
    pub(crate) metadata: EntryMetadata,
}

/// Host 与 WSL 之间由 Direct 和 Archive 共用的完整计划。
pub(crate) struct LocalPlan {
    pub(crate) wsl: WslArchiveContext,
    pub(crate) destination_parent: PathBuf,
    pub(crate) directories: Vec<PlannedDirectory<PathBuf, PathBuf>>,
    pub(crate) files: Vec<LocalFile>,
    pub(crate) roots: Vec<LocalRoot>,
}

/// WSL Archive 执行时保留的 Linux 路径，不允许执行器从 UNC 路径反向猜测。
pub(crate) enum WslArchiveContext {
    Upload {
        distro: String,
        destination_parent: String,
    },
    Download {
        distro: String,
        sources: Vec<String>,
    },
}

/// 从宿主机写入 SSH staging 的单文件复制项。
pub(crate) struct RemoteUploadFile {
    pub(crate) source: PathBuf,
    pub(crate) destination: String,
    pub(crate) size: u64,
    pub(crate) metadata: EntryMetadata,
}

/// SSH 上传 Manifest 及其任务独占 SFTP 会话和命令 transport。
pub(crate) struct RemoteUploadPlan {
    pub(crate) workspace: Arc<RemoteWorkspace>,
    pub(crate) session: Arc<SftpSession>,
    pub(crate) directories: Vec<PlannedDirectory<PathBuf, String>>,
    pub(crate) files: Vec<RemoteUploadFile>,
    pub(crate) roots: Vec<RemoteRoot>,
}

/// 从 SSH 来源写入本地 staging 的单文件复制项。
pub(crate) struct RemoteDownloadFile {
    pub(crate) source: String,
    pub(crate) destination: PathBuf,
    pub(crate) size: u64,
    pub(crate) metadata: EntryMetadata,
}

/// SSH 下载计划及扫描、复制所需的任务连接上下文。
pub(crate) struct RemoteDownloadPlan {
    pub(crate) workspace: Arc<RemoteWorkspace>,
    pub(crate) session: Arc<SftpSession>,
    pub(crate) directories: Vec<PlannedDirectory<String, PathBuf>>,
    pub(crate) files: Vec<RemoteDownloadFile>,
    pub(crate) roots: Vec<LocalRoot>,
}

/// 按当前 Workspace 环境选择的数据面 Manifest。
pub(crate) enum TransferManifest {
    Local(LocalPlan),
    RemoteUpload(RemoteUploadPlan),
    RemoteDownload(RemoteDownloadPlan),
}

impl TransferManifest {
    fn totals(&self) -> (u64, u64) {
        match self {
            Self::Local(plan) => totals(plan.files.iter().map(|file| file.size)),
            Self::RemoteUpload(plan) => totals(plan.files.iter().map(|file| file.size)),
            Self::RemoteDownload(plan) => totals(plan.files.iter().map(|file| file.size)),
        }
    }

    fn target_keys(&self) -> Vec<String> {
        match self {
            Self::Local(plan) => local_target_keys(&plan.roots),
            Self::RemoteDownload(plan) => local_target_keys(&plan.roots),
            Self::RemoteUpload(plan) => plan
                .roots
                .iter()
                .map(|root| format!("ssh:{}", root.final_path))
                .collect(),
        }
    }
}

fn local_target_keys(roots: &[LocalRoot]) -> Vec<String> {
    roots
        .iter()
        .map(|root| {
            let value = root.final_path.to_string_lossy();
            if cfg!(windows) {
                format!("local:{}", value.to_lowercase())
            } else {
                format!("local:{value}")
            }
        })
        .collect()
}

/// 扫描完成且尚未写入目标的通用传输 Manifest。
pub(crate) struct PreparedTransfer {
    pub(crate) manifest: TransferManifest,
    pub(crate) changed_paths: Vec<String>,
}

impl PreparedTransfer {
    /// 返回需要由当前任务独占的规范最终目标。
    pub(crate) fn target_keys(&self) -> Vec<String> {
        self.manifest.target_keys()
    }
}

/// 扫描传输来源并生成不产生写入副作用的执行计划。
///
/// 返回值是发生工作区写入的路径，供 Explorer 精确刷新。下载只写宿主机目录，
/// 因此返回空列表。
pub(crate) async fn prepare(
    workspace: &WorkspaceEnv,
    request: &EnqueueTransferRequest,
    task_id: &str,
    context: &ExecutionContext,
) -> RunResult<PreparedTransfer> {
    context.checkpoint().await?;
    let plan = match workspace {
        WorkspaceEnv::Local => {
            return Err(TransferRunError::Message(
                "local workspaces do not require file transfer".into(),
            ));
        }
        WorkspaceEnv::Wsl { distro } => {
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
            let archive = match request.direction {
                TransferDirection::Upload => WslArchiveContext::Upload {
                    distro: distro.clone(),
                    destination_parent: request.destination.clone(),
                },
                TransferDirection::Download => WslArchiveContext::Download {
                    distro: distro.clone(),
                    sources: request.sources.clone(),
                },
            };
            TransferManifest::Local(
                plan_local(
                    sources,
                    destination,
                    sanitize_names,
                    archive,
                    task_id,
                    context,
                )
                .await?,
            )
        }
        WorkspaceEnv::Ssh { profile_id } => {
            let manager = remote::manager::global_manager()?;
            let remote_workspace = manager.workspace(profile_id).await?;
            let session = super::ssh::session::open(&remote_workspace).await?;
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
                .map(TransferManifest::RemoteUpload),
                TransferDirection::Download => plan_remote_download(
                    remote_workspace,
                    session.clone(),
                    &request.sources,
                    Path::new(&request.destination),
                    task_id,
                    context,
                )
                .await
                .map(TransferManifest::RemoteDownload),
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
    let changed_paths = if request.direction == TransferDirection::Upload {
        vec![request.destination.clone()]
    } else {
        Vec::new()
    };
    Ok(PreparedTransfer {
        manifest: plan,
        changed_paths,
    })
}

/// 扫描同一宿主文件系统中的来源，并为每个顶层项目生成同级 staging 目标。
async fn plan_local(
    sources: Vec<PathBuf>,
    destination_parent: PathBuf,
    sanitize_names: bool,
    wsl: WslArchiveContext,
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
        wsl,
        destination_parent: destination_parent.clone(),
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
                metadata: EntryMetadata::from_local(&metadata),
            });
            continue;
        }

        plan.directories.push(PlannedDirectory {
            source: source.clone(),
            destination: stage.clone(),
            metadata: EntryMetadata::from_local(&metadata),
        });
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
                    plan.directories.push(PlannedDirectory {
                        source: source_path.clone(),
                        destination: destination_path.clone(),
                        metadata: EntryMetadata::from_local(&metadata),
                    });
                    pending.push((source_path, destination_path));
                } else {
                    plan.files.push(LocalFile {
                        source: source_path,
                        destination: destination_path,
                        size: metadata.len(),
                        metadata: EntryMetadata::from_local(&metadata),
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
                metadata: EntryMetadata::from_local(&metadata),
            });
            continue;
        }

        plan.directories.push(PlannedDirectory {
            source: source.clone(),
            destination: stage.clone(),
            metadata: EntryMetadata::from_local(&metadata),
        });
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
                    plan.directories.push(PlannedDirectory {
                        source: source_path.clone(),
                        destination: destination_path.clone(),
                        metadata: EntryMetadata::from_local(&metadata),
                    });
                    pending.push((source_path, destination_path));
                } else {
                    plan.files.push(RemoteUploadFile {
                        source: source_path,
                        destination: destination_path,
                        size: metadata.len(),
                        metadata: EntryMetadata::from_local(&metadata),
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
        workspace,
        session,
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
    };
    let mut root_names = HashSet::new();

    for source in sources {
        context.checkpoint().await?;
        validate_remote_workspace_path(source, &home)?;
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
                metadata: EntryMetadata::from_remote(&source_metadata),
            });
            continue;
        }

        plan.directories.push(PlannedDirectory {
            source: source.clone(),
            destination: stage.clone(),
            metadata: EntryMetadata::from_remote(&source_metadata),
        });
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
                    let metadata = entry.metadata();
                    plan.directories.push(PlannedDirectory {
                        source: source_path.clone(),
                        destination: destination_path.clone(),
                        metadata: EntryMetadata::from_remote(&metadata),
                    });
                    pending.push((source_path, destination_path));
                } else {
                    let metadata = entry.metadata();
                    plan.files.push(RemoteDownloadFile {
                        source: source_path.clone(),
                        destination: destination_path,
                        size: remote_size(&metadata, &source_path)?,
                        metadata: EntryMetadata::from_remote(&metadata),
                    });
                }
            }
        }
    }
    Ok(plan)
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
    validate_remote_workspace_path(path, &home)?;
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

/// 在接触远端文件系统前校验路径，避免通过遍历组件探测 Workspace 外部对象。
fn validate_remote_workspace_path(path: &str, root: &str) -> RunResult<()> {
    if !path.starts_with('/')
        || path.contains(['\0', '\r', '\n'])
        || path
            .split('/')
            .any(|component| matches!(component, "." | ".."))
        || !remote_path_within(path, root)
    {
        return Err(message(format!(
            "remote path is outside workspace root: {path}"
        )));
    }
    Ok(())
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

fn remote_name(path: &str) -> RunResult<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| message(format!("cannot transfer remote root: {path}")))
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
    fn remote_scope_requires_a_component_boundary() {
        assert!(remote_path_within("/home/me/project", "/home/me"));
        assert!(remote_path_within("/home/me", "/home/me"));
        assert!(!remote_path_within("/home/other", "/home/me"));
        assert!(!remote_path_within("/home/mean", "/home/me"));
        assert!(remote_path_within("/etc", "/"));
    }

    #[test]
    fn remote_workspace_paths_are_rejected_before_server_access() {
        assert!(validate_remote_workspace_path("/home/me/project", "/home/me").is_ok());
        for path in [
            "home/me/project",
            "/home/me/../other",
            "/home/other",
            "/home/mean",
            "/home/me/file\0name",
        ] {
            assert!(
                validate_remote_workspace_path(path, "/home/me").is_err(),
                "accepted {path:?}"
            );
        }
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
}
