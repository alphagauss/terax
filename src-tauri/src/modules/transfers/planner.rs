//! Direct 与 Archive 共用的只读扫描与 Manifest 生成。
//!
//! 本模块在写入目标前解析来源、校验 Workspace 边界并生成带私有 staging 路径的
//! 不可变计划。Direct 会递归扫描全部条目；Archive 只确认顶层根，子树交给打包或
//! 接收端安全解压处理，从而避免高延迟环境中的重复遍历。目录同步额外通过批量清单
//! 筛选需要归档的条目。规划阶段不创建或修改文件。

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::SftpSession;
use uuid::Uuid;

use crate::modules::remote;
use crate::modules::remote::session::{join_remote, RemoteWorkspace};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

use super::commit::{
    ensure_local_target_available, ensure_remote_target_available, local_stage_path,
    remote_stage_path, LocalRoot, RemoteRoot, RootCommitMode,
};
use super::errors::{io_failure, TransferErrorCode, TransferFailure};
use super::manager::TransferRunError;
use super::metadata::EntryMetadata;
use super::models::{
    EnqueueTransferRequest, TransferDirection, TransferEntryKind, TransferFileFailure,
    TransferStrategy,
};
use super::progress::ExecutionContext;
use super::source::LocalSourceIdentity;

type RunResult<T> = Result<T, TransferRunError>;

/// 规划期间使用的任务归属与单文件下载目标名。
#[derive(Clone, Copy)]
struct PlanningTaskIdentity<'a> {
    staging_id: &'a str,
    owner_id: &'a str,
    destination_name: Option<&'a str>,
    contents: bool,
}

/// 同一宿主文件系统中的单文件复制项。
pub(crate) struct LocalFile {
    pub(crate) root_index: usize,
    pub(crate) source: PathBuf,
    pub(crate) destination: PathBuf,
    pub(crate) final_destination: PathBuf,
    pub(crate) retry_source_path: String,
    pub(crate) final_destination_path: String,
    pub(crate) size: u64,
    pub(crate) metadata: EntryMetadata,
    pub(crate) source_identity: Option<LocalSourceIdentity>,
}

/// 创建后需要在子项完成时恢复元数据的目录。
pub(crate) struct PlannedDirectory<S, D> {
    pub(crate) root_index: usize,
    pub(crate) source: S,
    pub(crate) destination: D,
    pub(crate) final_destination: D,
    pub(crate) metadata: EntryMetadata,
    pub(crate) source_identity: Option<LocalSourceIdentity>,
}

/// Host 与 WSL 之间由 Direct 和 Archive 共用的完整计划。
pub(crate) struct LocalPlan {
    pub(crate) sync: Option<super::sync::SyncSelection>,
    pub(crate) task_id: String,
    pub(crate) owner_task_id: String,
    pub(crate) wsl: WslArchiveContext,
    #[cfg_attr(
        not(windows),
        expect(dead_code, reason = "WSL Archive 仅在 Windows 使用宿主目标目录")
    )]
    pub(crate) destination_parent: PathBuf,
    pub(crate) directories: Vec<PlannedDirectory<PathBuf, PathBuf>>,
    pub(crate) files: Vec<LocalFile>,
    pub(crate) roots: Vec<LocalRoot>,
    pub(crate) scan_failures: u64,
}

/// WSL Archive 执行时保留的 Linux 路径，不允许执行器从 UNC 路径反向猜测。
pub(crate) enum WslArchiveContext {
    Upload {
        #[cfg_attr(
            not(windows),
            expect(dead_code, reason = "WSL 执行器仅在 Windows 读取发行版")
        )]
        distro: String,
        destination_parent: String,
    },
    Download {
        #[cfg_attr(
            not(windows),
            expect(dead_code, reason = "WSL 执行器仅在 Windows 读取发行版")
        )]
        distro: String,
        sources: Vec<String>,
    },
}

/// 从宿主机写入 SSH staging 的单文件复制项。
pub(crate) struct RemoteUploadFile {
    pub(crate) root_index: usize,
    pub(crate) source: PathBuf,
    pub(crate) destination: String,
    pub(crate) final_destination: String,
    pub(crate) size: u64,
    pub(crate) metadata: EntryMetadata,
    pub(crate) source_identity: Option<LocalSourceIdentity>,
}

/// SSH 上传 Manifest 及其任务独占 SFTP 会话和命令 transport。
pub(crate) struct RemoteUploadPlan {
    pub(crate) sync: Option<super::sync::SyncSelection>,
    pub(crate) workspace: Arc<RemoteWorkspace>,
    pub(crate) session: Arc<SftpSession>,
    pub(crate) task_id: String,
    pub(crate) owner_task_id: String,
    pub(crate) directories: Vec<PlannedDirectory<PathBuf, String>>,
    pub(crate) files: Vec<RemoteUploadFile>,
    pub(crate) roots: Vec<RemoteRoot>,
    pub(crate) scan_failures: u64,
}

/// 从 SSH 来源写入本地 staging 的单文件复制项。
pub(crate) struct RemoteDownloadFile {
    pub(crate) root_index: usize,
    pub(crate) source: String,
    pub(crate) destination: PathBuf,
    pub(crate) final_destination: PathBuf,
    pub(crate) size: u64,
    pub(crate) metadata: EntryMetadata,
}

/// SSH 下载计划及扫描、复制所需的任务连接上下文。
pub(crate) struct RemoteDownloadPlan {
    pub(crate) sync: Option<super::sync::SyncSelection>,
    pub(crate) workspace: Arc<RemoteWorkspace>,
    pub(crate) session: Arc<SftpSession>,
    pub(crate) task_id: String,
    pub(crate) owner_task_id: String,
    pub(crate) directories: Vec<PlannedDirectory<String, PathBuf>>,
    pub(crate) files: Vec<RemoteDownloadFile>,
    pub(crate) roots: Vec<LocalRoot>,
    pub(crate) scan_failures: u64,
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
            Self::Local(plan) => {
                totals(plan.files.iter().map(|file| file.size), plan.scan_failures)
            }
            Self::RemoteUpload(plan) => {
                totals(plan.files.iter().map(|file| file.size), plan.scan_failures)
            }
            Self::RemoteDownload(plan) => {
                totals(plan.files.iter().map(|file| file.size), plan.scan_failures)
            }
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

    fn root_count(&self) -> u64 {
        match self {
            Self::Local(plan) => plan.roots.len() as u64,
            Self::RemoteUpload(plan) => plan.roots.len() as u64,
            Self::RemoteDownload(plan) => plan.roots.len() as u64,
        }
    }

    /// 判断聚合任务是否包含目录根，结果随扫描总量一起持久化。
    fn has_directory(&self) -> bool {
        match self {
            Self::Local(plan) => plan
                .roots
                .iter()
                .any(|root| root.kind == TransferEntryKind::Directory),
            Self::RemoteUpload(plan) => plan
                .roots
                .iter()
                .any(|root| root.kind == TransferEntryKind::Directory),
            Self::RemoteDownload(plan) => plan
                .roots
                .iter()
                .any(|root| root.kind == TransferEntryKind::Directory),
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
}

impl PreparedTransfer {
    /// 返回需要由当前任务独占的规范最终目标。
    pub(crate) fn target_keys(&self) -> Vec<String> {
        self.manifest.target_keys()
    }

    /// 发布当前 Manifest 的实际执行总量，冲突跳过条目后可再次调用以收敛进度。
    pub(crate) async fn publish_totals(&self, context: &mut ExecutionContext) -> RunResult<()> {
        let (total_files, total_bytes) = self.manifest.totals();
        context
            .set_totals(
                total_files,
                total_bytes,
                self.manifest.root_count(),
                self.manifest.has_directory(),
            )
            .await
    }
}

/// 扫描传输来源并生成不产生写入副作用的执行计划。
///
/// 返回值包含不可变 Manifest、任务私有 staging 路径和需要由 Scheduler 独占的
/// 最终目标；规划阶段不创建目录或文件。
pub(crate) async fn prepare(
    workspace: &WorkspaceEnv,
    request: &EnqueueTransferRequest,
    task_id: &str,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<PreparedTransfer> {
    context.checkpoint().await?;
    let scan_contents = scans_subtree(strategy);
    let owner_id = context.task_id().to_string();
    let task = PlanningTaskIdentity {
        staging_id: task_id,
        owner_id: &owner_id,
        destination_name: request.destination_name.as_deref(),
        contents: request.sync.is_some(),
    };
    let plan = match workspace {
        WorkspaceEnv::Local => {
            return Err(TransferRunError::failed(
                TransferErrorCode::WorkspaceUnavailable,
                "local workspaces do not require file transfer",
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
                    task,
                    scan_contents,
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
                    task,
                    scan_contents,
                    context,
                )
                .await
                .map(TransferManifest::RemoteUpload),
                TransferDirection::Download => plan_remote_download(
                    remote_workspace,
                    session.clone(),
                    &request.sources,
                    Path::new(&request.destination),
                    task,
                    scan_contents,
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

    let mut prepared = PreparedTransfer { manifest: plan };
    if request.sync.is_some() {
        if let Err(error) = super::sync::prepare(&mut prepared, workspace, request, context).await {
            match &prepared.manifest {
                TransferManifest::RemoteUpload(plan) => close_sftp(&plan.session).await,
                TransferManifest::RemoteDownload(plan) => close_sftp(&plan.session).await,
                TransferManifest::Local(_) => {}
            }
            return Err(error);
        }
    }
    prepared.publish_totals(context).await?;
    Ok(prepared)
}

/// 在检查源目标关系之前应用用户选定的名称，避免改名另存为被原文件名误判。
fn local_root_destination(
    source: &Path,
    parent: &Path,
    sanitize: bool,
    requested_name: Option<&str>,
    is_dir: bool,
) -> RunResult<PathBuf> {
    let name = match requested_name {
        Some(_) if is_dir => return Err(invalid("save as requires one regular file".into())),
        Some(name) => OsString::from(name),
        None => local_destination_name(
            source
                .file_name()
                .ok_or_else(|| message(format!("invalid source path: {}", source.display())))?,
            sanitize,
        ),
    };
    let destination = parent.join(name);
    validate_local_relationship(source, &destination, is_dir)?;
    Ok(destination)
}

/// 扫描同一宿主文件系统中的来源，并为每个顶层项目生成同级 staging 目标。
async fn plan_local(
    sources: Vec<PathBuf>,
    destination_parent: PathBuf,
    sanitize_names: bool,
    wsl: WslArchiveContext,
    task: PlanningTaskIdentity<'_>,
    scan_contents: bool,
    context: &mut ExecutionContext,
) -> RunResult<LocalPlan> {
    let destination_metadata = tokio::fs::metadata(&destination_parent)
        .await
        .map_err(|error| {
            local_io(
                format!("stat destination {}", destination_parent.display()),
                error,
            )
        })?;
    if !destination_metadata.is_dir() {
        return Err(message(format!(
            "transfer destination is not a directory: {}",
            destination_parent.display()
        )));
    }
    let destination_parent =
        tokio::fs::canonicalize(&destination_parent)
            .await
            .map_err(|error| {
                local_io(
                    format!("canonicalize destination {}", destination_parent.display()),
                    error,
                )
            })?;
    let mut plan = LocalPlan {
        task_id: task.staging_id.to_string(),
        owner_task_id: task.owner_id.to_string(),
        wsl,
        destination_parent: destination_parent.clone(),
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
        scan_failures: 0,
        sync: None,
    };
    let mut root_names = HashSet::new();
    let mut source_roots: Vec<PathBuf> = Vec::new();

    for source in sources {
        let root_index = plan.roots.len();
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| local_io(format!("stat source {}", source.display()), error))?;
        reject_local_symlink_or_special(&source, &metadata)?;
        let source = tokio::fs::canonicalize(&source).await.map_err(|error| {
            local_io(format!("canonicalize source {}", source.display()), error)
        })?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| local_io(format!("stat source {}", source.display()), error))?;
        reject_local_symlink_or_special(&source, &metadata)?;
        if !scan_contents
            && source_roots
                .iter()
                .any(|root| local_paths_overlap(root, &source))
        {
            return Err(invalid(format!(
                "archive source roots cannot overlap: {}",
                source.display()
            )));
        }
        source_roots.push(source.clone());
        let source_identity = LocalSourceIdentity::capture(&source, &metadata).await;
        let final_path = if task.contents {
            if !metadata.is_dir() {
                return Err(invalid("folder sync requires a directory source".into()));
            }
            destination_parent.clone()
        } else {
            local_root_destination(
                &source,
                &destination_parent,
                sanitize_names,
                task.destination_name,
                metadata.is_dir(),
            )?
        };
        if !root_names.insert(local_name_identity(final_path.as_os_str())) {
            return Err(message(format!(
                "multiple sources map to the same destination: {}",
                final_path.display()
            )));
        }
        let stage = local_stage_path(&final_path, task.staging_id, plan.roots.len())?;
        ensure_local_target_available(&stage).await?;
        let source_root = source.clone();
        let final_root = final_path.clone();
        let logical_root_source = match &plan.wsl {
            WslArchiveContext::Upload { .. } => source.to_string_lossy().into_owned(),
            WslArchiveContext::Download { sources, .. } => {
                sources.get(root_index).cloned().ok_or_else(|| {
                    invalid(
                        "WSL download source index is missing from the transfer plan".to_string(),
                    )
                })?
            }
        };
        plan.roots.push(LocalRoot {
            source_path: logical_root_source,
            stage: stage.clone(),
            final_path: final_path.clone(),
            kind: if metadata.is_file() {
                TransferEntryKind::File
            } else {
                TransferEntryKind::Directory
            },
            destination_kind: None,
            mode: RootCommitMode::Create,
            merge_preconditions: Vec::new(),
        });

        if metadata.is_file() {
            let (retry_source_path, final_destination_path) = local_logical_file_paths(
                &plan.wsl,
                root_index,
                &source_root,
                &source,
                &final_root,
                &final_path,
            )?;
            plan.files.push(LocalFile {
                root_index,
                source,
                destination: stage,
                final_destination: final_path,
                retry_source_path,
                final_destination_path,
                size: metadata.len(),
                metadata: EntryMetadata::from_local(&metadata),
                source_identity,
            });
            continue;
        }

        plan.directories.push(PlannedDirectory {
            root_index,
            source: source.clone(),
            destination: stage.clone(),
            final_destination: final_path.clone(),
            metadata: EntryMetadata::from_local(&metadata),
            source_identity,
        });
        if !scan_contents {
            continue;
        }
        let mut pending = vec![(source, stage, final_path, source_identity)];
        while let Some((source_dir, destination_dir, final_dir, source_identity)) = pending.pop() {
            context.checkpoint().await?;
            let mut entries =
                super::source::read_verified_directory(&source_dir, source_identity).await?;
            let mut destination_names = HashSet::new();
            while let Some(entry) = entries.next_entry().await.map_err(|error| {
                local_io(format!("read directory {}", source_dir.display()), error)
            })? {
                context.checkpoint().await?;
                let source_path = entry.path();
                let entry_type = entry.file_type().await.map_err(|error| {
                    local_io(format!("read source type {}", source_path.display()), error)
                })?;
                let name = local_destination_name(&entry.file_name(), sanitize_names);
                if !destination_names.insert(local_name_identity(&name)) {
                    return Err(message(format!(
                        "source names collide after local filename sanitization in {}",
                        source_dir.display()
                    )));
                }
                let destination_path = destination_dir.join(&name);
                let final_path = final_dir.join(name);
                let metadata = match tokio::fs::symlink_metadata(&source_path).await {
                    Ok(metadata) => metadata,
                    Err(error) if entry_type.is_file() => {
                        let (retry_source_path, final_destination_path) = local_logical_file_paths(
                            &plan.wsl,
                            root_index,
                            &source_root,
                            &source_path,
                            &final_root,
                            &final_path,
                        )?;
                        record_scan_failure(
                            context,
                            retry_source_path,
                            final_destination_path,
                            io_failure("stat transfer source", &error),
                        )
                        .await?;
                        plan.scan_failures = plan.scan_failures.saturating_add(1);
                        continue;
                    }
                    Err(error) => {
                        return Err(local_io(
                            format!("stat source {}", source_path.display()),
                            error,
                        ));
                    }
                };
                reject_local_symlink_or_special(&source_path, &metadata)?;
                let source_identity = LocalSourceIdentity::capture(&source_path, &metadata).await;
                if metadata.is_dir() {
                    plan.directories.push(PlannedDirectory {
                        root_index,
                        source: source_path.clone(),
                        destination: destination_path.clone(),
                        final_destination: final_path.clone(),
                        metadata: EntryMetadata::from_local(&metadata),
                        source_identity,
                    });
                    pending.push((source_path, destination_path, final_path, source_identity));
                } else {
                    let (retry_source_path, final_destination_path) = local_logical_file_paths(
                        &plan.wsl,
                        root_index,
                        &source_root,
                        &source_path,
                        &final_root,
                        &final_path,
                    )?;
                    plan.files.push(LocalFile {
                        root_index,
                        source: source_path,
                        destination: destination_path,
                        final_destination: final_path,
                        retry_source_path,
                        final_destination_path,
                        size: metadata.len(),
                        metadata: EntryMetadata::from_local(&metadata),
                        source_identity,
                    });
                }
            }
        }
    }
    Ok(plan)
}

/// 扫描宿主机来源并生成 SSH 上传计划。
async fn plan_remote_upload(
    workspace: Arc<RemoteWorkspace>,
    session: Arc<SftpSession>,
    sources: &[String],
    destination_parent: &str,
    task: PlanningTaskIdentity<'_>,
    scan_contents: bool,
    context: &mut ExecutionContext,
) -> RunResult<RemoteUploadPlan> {
    let destination_parent = canonical_remote_directory(&session, destination_parent).await?;
    let mut plan = RemoteUploadPlan {
        workspace,
        session,
        task_id: task.staging_id.to_string(),
        owner_task_id: task.owner_id.to_string(),
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
        scan_failures: 0,
        sync: None,
    };
    let mut root_names = HashSet::new();
    let mut source_roots: Vec<PathBuf> = Vec::new();

    for source in sources {
        let root_index = plan.roots.len();
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(source)
            .await
            .map_err(|error| local_io(format!("stat source {source}"), error))?;
        reject_local_symlink_or_special(Path::new(source), &metadata)?;
        let source = tokio::fs::canonicalize(source)
            .await
            .map_err(|error| local_io(format!("canonicalize source {source}"), error))?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| local_io(format!("stat source {}", source.display()), error))?;
        reject_local_symlink_or_special(&source, &metadata)?;
        if !scan_contents
            && source_roots
                .iter()
                .any(|root| local_paths_overlap(root, &source))
        {
            return Err(invalid(format!(
                "archive source roots cannot overlap: {}",
                source.display()
            )));
        }
        source_roots.push(source.clone());
        let source_identity = LocalSourceIdentity::capture(&source, &metadata).await;
        let name = source
            .file_name()
            .and_then(OsStr::to_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| message(format!("invalid local source: {}", source.display())))?
            .to_string();
        if !root_names.insert(name.clone()) {
            return Err(invalid(format!("duplicate destination name: {name}")));
        }
        let final_path = if task.contents {
            if !metadata.is_dir() {
                return Err(invalid("folder sync requires a directory source".into()));
            }
            destination_parent.clone()
        } else {
            join_remote(&destination_parent, &name)
        };
        let stage = remote_stage_path(&final_path, task.staging_id, root_index)?;
        if !context
            .resume
            .as_ref()
            .is_some_and(|state| !state.discarded && state.remote_paths.contains(&stage))
        {
            ensure_remote_target_available(&plan.session, &stage).await?;
        }
        plan.roots.push(RemoteRoot {
            source_path: source.to_string_lossy().into_owned(),
            stage: stage.clone(),
            final_path: final_path.clone(),
            kind: if metadata.is_file() {
                TransferEntryKind::File
            } else {
                TransferEntryKind::Directory
            },
            destination_kind: None,
            mode: RootCommitMode::Create,
            merge_preconditions: Vec::new(),
        });

        if metadata.is_file() {
            plan.files.push(RemoteUploadFile {
                root_index,
                source,
                destination: stage,
                final_destination: final_path,
                size: metadata.len(),
                metadata: EntryMetadata::from_local(&metadata),
                source_identity,
            });
            continue;
        }

        plan.directories.push(PlannedDirectory {
            root_index,
            source: source.clone(),
            destination: stage.clone(),
            final_destination: final_path.clone(),
            metadata: EntryMetadata::from_local(&metadata),
            source_identity,
        });
        if !scan_contents {
            continue;
        }
        let mut pending = vec![(source, stage, final_path, source_identity)];
        while let Some((source_dir, destination_dir, final_dir, source_identity)) = pending.pop() {
            context.checkpoint().await?;
            let mut entries =
                super::source::read_verified_directory(&source_dir, source_identity).await?;
            while let Some(entry) = entries.next_entry().await.map_err(|error| {
                local_io(format!("read directory {}", source_dir.display()), error)
            })? {
                context.checkpoint().await?;
                let source_path = entry.path();
                let entry_type = entry.file_type().await.map_err(|error| {
                    local_io(format!("read source type {}", source_path.display()), error)
                })?;
                let name = entry.file_name().into_string().map_err(|_| {
                    message(format!(
                        "non-UTF-8 filename is not supported: {}",
                        source_path.display()
                    ))
                })?;
                let destination_path = join_remote(&destination_dir, &name);
                let final_path = join_remote(&final_dir, &name);
                let metadata = match tokio::fs::symlink_metadata(&source_path).await {
                    Ok(metadata) => metadata,
                    Err(error) if entry_type.is_file() => {
                        record_scan_failure(
                            context,
                            source_path.to_string_lossy().into_owned(),
                            final_path.clone(),
                            io_failure("stat transfer source", &error),
                        )
                        .await?;
                        plan.scan_failures = plan.scan_failures.saturating_add(1);
                        continue;
                    }
                    Err(error) => {
                        return Err(local_io(
                            format!("stat source {}", source_path.display()),
                            error,
                        ));
                    }
                };
                reject_local_symlink_or_special(&source_path, &metadata)?;
                let source_identity = LocalSourceIdentity::capture(&source_path, &metadata).await;
                if metadata.is_dir() {
                    plan.directories.push(PlannedDirectory {
                        root_index,
                        source: source_path.clone(),
                        destination: destination_path.clone(),
                        final_destination: final_path.clone(),
                        metadata: EntryMetadata::from_local(&metadata),
                        source_identity,
                    });
                    pending.push((source_path, destination_path, final_path, source_identity));
                } else {
                    plan.files.push(RemoteUploadFile {
                        root_index,
                        source: source_path,
                        destination: destination_path,
                        final_destination: final_path,
                        size: metadata.len(),
                        metadata: EntryMetadata::from_local(&metadata),
                        source_identity,
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
    task: PlanningTaskIdentity<'_>,
    scan_contents: bool,
    context: &mut ExecutionContext,
) -> RunResult<RemoteDownloadPlan> {
    let destination_metadata = tokio::fs::metadata(destination_parent)
        .await
        .map_err(|error| {
            local_io(
                format!("stat destination {}", destination_parent.display()),
                error,
            )
        })?;
    if !destination_metadata.is_dir() {
        return Err(message(format!(
            "transfer destination is not a directory: {}",
            destination_parent.display()
        )));
    }
    let destination_parent =
        tokio::fs::canonicalize(destination_parent)
            .await
            .map_err(|error| {
                local_io(
                    format!("canonicalize destination {}", destination_parent.display()),
                    error,
                )
            })?;
    let mut plan = RemoteDownloadPlan {
        workspace,
        session,
        task_id: task.staging_id.to_string(),
        owner_task_id: task.owner_id.to_string(),
        directories: Vec::new(),
        files: Vec::new(),
        roots: Vec::new(),
        scan_failures: 0,
        sync: None,
    };
    let mut root_names = HashSet::new();
    let mut source_roots: Vec<String> = Vec::new();

    for source in sources {
        let root_index = plan.roots.len();
        context.checkpoint().await?;
        validate_remote_transfer_path(source)?;
        let source_metadata = super::ssh::io::run(
            format!("stat remote source {source}"),
            plan.session.symlink_metadata(source.clone()),
        )
        .await?;
        reject_remote_symlink_or_special(source, source_metadata.file_type())?;
        let source = super::ssh::io::run(
            format!("canonicalize remote source {source}"),
            plan.session.canonicalize(source.clone()),
        )
        .await?;
        validate_remote_transfer_path(&source)?;
        let source_metadata = super::ssh::io::run(
            format!("restat canonical remote source {source}"),
            plan.session.symlink_metadata(source.clone()),
        )
        .await?;
        reject_remote_symlink_or_special(&source, source_metadata.file_type())?;
        if !scan_contents
            && source_roots
                .iter()
                .any(|root| remote_paths_overlap(root, &source))
        {
            return Err(invalid(format!(
                "archive source roots cannot overlap: {source}"
            )));
        }
        source_roots.push(source.clone());
        let source_name = remote_name(&source)?.to_string();
        let destination_name = match task.destination_name {
            Some(_) if !source_metadata.file_type().is_file() => {
                return Err(invalid("save as requires one regular file".into()))
            }
            Some(name) => name.to_owned(),
            None => remote::sftp::sanitize_local_name(&source_name),
        };
        if !root_names.insert(local_name_identity(OsStr::new(&destination_name))) {
            return Err(invalid(format!(
                "multiple remote sources map to the same local name: {destination_name}"
            )));
        }
        let final_path = if task.contents {
            if !source_metadata.file_type().is_dir() {
                return Err(invalid("folder sync requires a directory source".into()));
            }
            destination_parent.clone()
        } else {
            destination_parent.join(destination_name)
        };
        let stage = local_stage_path(&final_path, task.staging_id, root_index)?;
        if !context
            .resume
            .as_ref()
            .is_some_and(|state| !state.discarded && state.local_paths.contains(&stage))
        {
            ensure_local_target_available(&stage).await?;
        }
        plan.roots.push(LocalRoot {
            source_path: source.clone(),
            stage: stage.clone(),
            final_path: final_path.clone(),
            kind: if source_metadata.file_type().is_file() {
                TransferEntryKind::File
            } else {
                TransferEntryKind::Directory
            },
            destination_kind: None,
            mode: RootCommitMode::Create,
            merge_preconditions: Vec::new(),
        });

        if source_metadata.file_type().is_file() {
            plan.files.push(RemoteDownloadFile {
                root_index,
                source,
                destination: stage,
                final_destination: final_path,
                size: remote_size(&source_metadata, &source_name)?,
                metadata: EntryMetadata::from_remote(&source_metadata),
            });
            continue;
        }

        plan.directories.push(PlannedDirectory {
            root_index,
            source: source.clone(),
            destination: stage.clone(),
            final_destination: final_path.clone(),
            metadata: EntryMetadata::from_remote(&source_metadata),
            source_identity: None,
        });
        if !scan_contents {
            continue;
        }
        let mut pending = vec![(source, stage, final_path)];
        while let Some((source_dir, destination_dir, final_dir)) = pending.pop() {
            context.checkpoint().await?;
            let entries = super::ssh::io::run(
                format!("read remote directory {source_dir}"),
                plan.session.read_dir(source_dir.clone()),
            )
            .await?;
            let mut destination_names = HashSet::new();
            for entry in entries {
                context.checkpoint().await?;
                let entry_type = entry.file_type();
                let source_path = entry.path();
                reject_remote_symlink_or_special(&source_path, entry_type)?;
                let destination_name = remote::sftp::sanitize_local_name(&entry.file_name());
                if !destination_names.insert(local_name_identity(OsStr::new(&destination_name))) {
                    return Err(invalid(format!(
                        "remote names collide after local filename sanitization in {source_dir}"
                    )));
                }
                let destination_path = destination_dir.join(&destination_name);
                let final_path = final_dir.join(destination_name);
                if entry_type.is_dir() {
                    let metadata = entry.metadata();
                    plan.directories.push(PlannedDirectory {
                        root_index,
                        source: source_path.clone(),
                        destination: destination_path.clone(),
                        final_destination: final_path.clone(),
                        metadata: EntryMetadata::from_remote(&metadata),
                        source_identity: None,
                    });
                    pending.push((source_path, destination_path, final_path));
                } else {
                    let metadata = entry.metadata();
                    let size = match remote_size(&metadata, &source_path) {
                        Ok(size) => size,
                        Err(TransferRunError::Failed(failure)) => {
                            record_scan_failure(
                                context,
                                source_path.clone(),
                                final_path.to_string_lossy().into_owned(),
                                failure,
                            )
                            .await?;
                            plan.scan_failures = plan.scan_failures.saturating_add(1);
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                    plan.files.push(RemoteDownloadFile {
                        root_index,
                        source: source_path.clone(),
                        destination: destination_path,
                        final_destination: final_path,
                        size,
                        metadata: EntryMetadata::from_remote(&metadata),
                    });
                }
            }
        }
    }
    Ok(plan)
}

/// 规范化用户选择的远端目标目录。
async fn canonical_remote_directory(session: &Arc<SftpSession>, path: &str) -> RunResult<String> {
    validate_remote_transfer_path(path)?;
    let canonical = super::ssh::io::run(
        format!("canonicalize remote destination {path}"),
        session.canonicalize(path.to_string()),
    )
    .await?;
    validate_remote_transfer_path(&canonical)?;
    let metadata = super::ssh::io::run(
        format!("stat remote destination {canonical}"),
        session.metadata(canonical.clone()),
    )
    .await?;
    if !metadata.file_type().is_dir() {
        return Err(invalid(format!(
            "remote destination is not a directory: {canonical}"
        )));
    }
    Ok(canonical)
}

/// 按远端 POSIX 组件边界判断两个规范路径是否相同或互为祖先。
fn remote_paths_overlap(left: &str, right: &str) -> bool {
    remote_path_contains(left, right) || remote_path_contains(right, left)
}

/// 判断规范远端路径是否包含另一个路径。
fn remote_path_contains(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    root.is_empty() && path.starts_with('/')
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// 校验用户明确选择的 SSH 传输路径。
///
/// 传输范围由 SSH 账号权限和用户选择决定；此处只拒绝非绝对路径、控制字符及父级
/// 遍历，删除权限由任务私有 staging 的独立清理授权约束。
fn validate_remote_transfer_path(path: &str) -> RunResult<()> {
    if !path.starts_with('/')
        || path.contains(['\0', '\r', '\n'])
        || path
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return Err(invalid(format!("invalid remote transfer path: {path}")));
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
        return Err(invalid(format!("invalid WSL workspace path: {path}")));
    }
    Ok(())
}

fn reject_local_symlink_or_special(path: &Path, metadata: &std::fs::Metadata) -> RunResult<()> {
    if metadata.file_type().is_symlink() {
        return Err(invalid(format!(
            "symbolic-link transfer is not supported: {}",
            path.display()
        )));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(invalid(format!(
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
        return Err(invalid(format!(
            "symbolic-link transfer is not supported: {path}"
        )));
    }
    if !file_type.is_file() && !file_type.is_dir() {
        return Err(invalid(format!("unsupported remote source type: {path}")));
    }
    Ok(())
}

fn remote_size(metadata: &russh_sftp::protocol::FileAttributes, path: &str) -> RunResult<u64> {
    metadata
        .size
        .ok_or_else(|| message(format!("remote file size is unavailable: {path}")))
}

/// 将 WSL 数据面的 UNC 执行路径还原为失败重试所需的逻辑路径。
fn local_logical_file_paths(
    wsl: &WslArchiveContext,
    root_index: usize,
    source_root: &Path,
    source_path: &Path,
    final_root: &Path,
    final_path: &Path,
) -> RunResult<(String, String)> {
    let relative = source_path.strip_prefix(source_root).map_err(|_| {
        invalid(format!(
            "transfer source escaped its planned root: {}",
            source_path.display()
        ))
    })?;
    match wsl {
        WslArchiveContext::Upload {
            destination_parent, ..
        } => {
            let root_name = final_root.file_name().ok_or_else(|| {
                invalid(format!(
                    "transfer destination root has no filename: {}",
                    final_root.display()
                ))
            })?;
            let logical_root = join_wsl_path(destination_parent, Path::new(root_name));
            Ok((
                source_path.to_string_lossy().into_owned(),
                join_wsl_path(&logical_root, relative),
            ))
        }
        WslArchiveContext::Download { sources, .. } => {
            let logical_root = sources.get(root_index).ok_or_else(|| {
                invalid("WSL download source index is missing from the transfer plan".to_string())
            })?;
            Ok((
                join_wsl_path(logical_root, relative),
                final_path.to_string_lossy().into_owned(),
            ))
        }
    }
}

fn join_wsl_path(root: &str, relative: &Path) -> String {
    let mut result = root.trim_end_matches('/').to_string();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            continue;
        };
        result.push('/');
        result.push_str(&component.to_string_lossy());
    }
    if result.is_empty() {
        "/".to_string()
    } else {
        result
    }
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
        return Err(invalid(format!(
            "destination cannot be the source or its descendant: {}",
            destination.display()
        )));
    }
    Ok(())
}

/// 判断两个已规范化本地来源是否相同或互为祖先，避免归档中出现重复子树。
fn local_paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
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

fn totals(sizes: impl Iterator<Item = u64>, scan_failures: u64) -> (u64, u64) {
    let (files, bytes) = sizes.fold((0u64, 0u64), |(files, bytes), size| {
        (files + 1, bytes.saturating_add(size))
    });
    (files + scan_failures, bytes)
}

/// 返回策略是否需要在规划阶段递归扫描子树。
///
/// Direct 必须提前取得每个写入项的大小和元数据；Archive 只确认顶层根，子树由
/// 打包或接收端安全解压时处理，避免跨 WSL/SSH 的重复逐文件访问。
fn scans_subtree(strategy: TransferStrategy) -> bool {
    strategy == TransferStrategy::Direct
}

/// 将规划阶段的本地 I/O 失败映射为稳定错误码，并保留操作路径。
fn local_io(context: String, error: std::io::Error) -> TransferRunError {
    TransferRunError::Failed(io_failure(context, &error))
}

/// 将递归扫描中已经确认属于普通文件的元数据错误降级为可重试文件失败。
async fn record_scan_failure(
    context: &mut ExecutionContext,
    source_path: String,
    destination_path: String,
    failure: TransferFailure,
) -> RunResult<()> {
    context
        .record_scan_failure(TransferFileFailure {
            id: Uuid::new_v4().to_string(),
            source_path,
            destination_path,
            failure,
            attempts: 1,
            ignored: false,
        })
        .await
}

fn message(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::SourceUnavailable, value)
}

fn invalid(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::InvalidRequest, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_as_checks_the_selected_destination_before_source_overlap() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.txt");
        std::fs::write(&source, b"content").unwrap();
        let renamed =
            local_root_destination(&source, directory.path(), true, Some("renamed.txt"), false)
                .unwrap();
        assert_eq!(renamed, directory.path().join("renamed.txt"));
        assert!(local_root_destination(&source, directory.path(), true, None, false).is_err());
        assert!(
            local_root_destination(&source, directory.path(), true, Some("source.txt"), false)
                .is_err()
        );
        assert!(local_root_destination(
            directory.path(),
            directory.path(),
            true,
            Some("folder"),
            true
        )
        .is_err());
        assert_eq!(std::fs::read(source).unwrap(), b"content");
        assert!(!renamed.exists());
    }

    #[test]
    fn remote_archive_overlap_requires_a_component_boundary() {
        assert!(remote_paths_overlap("/home/me", "/home/me/project"));
        assert!(remote_paths_overlap("/home/me", "/home/me"));
        assert!(!remote_paths_overlap("/home/me", "/home/other"));
        assert!(!remote_paths_overlap("/home/me", "/home/mean"));
        assert!(remote_paths_overlap("/", "/etc"));
    }

    #[test]
    fn remote_transfer_paths_allow_user_selected_absolute_locations() {
        assert!(validate_remote_transfer_path("/home/me/project").is_ok());
        assert!(validate_remote_transfer_path("/srv/releases").is_ok());
        for path in [
            "home/me/project",
            "/home/me/../other",
            "/home/me/file\0name",
        ] {
            let TransferRunError::Failed(failure) =
                validate_remote_transfer_path(path).unwrap_err()
            else {
                panic!("expected a structured failure");
            };
            assert_eq!(failure.code, TransferErrorCode::InvalidRequest);
        }
    }

    #[test]
    fn wsl_paths_are_absolute_and_cannot_traverse() {
        assert!(validate_wsl_path("/home/me/project").is_ok());
        for path in ["home/me", "/home/../etc", "/home\\me", "/tmp\0file"] {
            let TransferRunError::Failed(failure) = validate_wsl_path(path).unwrap_err() else {
                panic!("expected a structured failure");
            };
            assert_eq!(failure.code, TransferErrorCode::InvalidRequest);
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

    #[test]
    fn archive_planning_does_not_prescan_descendants() {
        assert!(scans_subtree(TransferStrategy::Direct));
        assert!(!scans_subtree(TransferStrategy::Archive));
    }

    #[test]
    fn archive_source_roots_cannot_overlap() {
        assert!(local_paths_overlap(
            Path::new("C:/work/project"),
            Path::new("C:/work/project/src")
        ));
        assert!(!local_paths_overlap(
            Path::new("C:/work/project"),
            Path::new("C:/work/other")
        ));
    }

    #[test]
    fn direct_totals_include_files_that_failed_during_scan() {
        assert_eq!(totals([5, 7].into_iter(), 1), (3, 12));
    }

    #[test]
    fn wsl_logical_paths_do_not_leak_unc_execution_paths_into_retries() {
        assert_eq!(
            join_wsl_path("/home/me/project", Path::new("src/main.rs")),
            "/home/me/project/src/main.rs"
        );
        assert_eq!(join_wsl_path("/", Path::new("tmp/file")), "/tmp/file");

        let upload = local_logical_file_paths(
            &WslArchiveContext::Upload {
                distro: "Ubuntu".into(),
                destination_parent: "/home/me".into(),
            },
            0,
            Path::new("C:/source/folder"),
            Path::new("C:/source/folder/src/main.rs"),
            Path::new("//wsl.localhost/Ubuntu/home/me/folder"),
            Path::new("//wsl.localhost/Ubuntu/home/me/folder/src/main.rs"),
        )
        .unwrap();
        assert_eq!(upload.0, "C:/source/folder/src/main.rs");
        assert_eq!(upload.1, "/home/me/folder/src/main.rs");

        let download = local_logical_file_paths(
            &WslArchiveContext::Download {
                distro: "Ubuntu".into(),
                sources: vec!["/home/me/folder".into()],
            },
            0,
            Path::new("//wsl.localhost/Ubuntu/home/me/folder"),
            Path::new("//wsl.localhost/Ubuntu/home/me/folder/src/main.rs"),
            Path::new("C:/target/folder"),
            Path::new("C:/target/folder/src/main.rs"),
        )
        .unwrap();
        assert_eq!(download.0, "/home/me/folder/src/main.rs");
        assert_eq!(download.1, "C:/target/folder/src/main.rs");
    }
}
