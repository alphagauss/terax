//! 文件传输目标冲突探测与用户决策。
//!
//! 本模块只读取最终目标并修改顶层提交模式，不写入用户路径。Direct 目录只询问
//! 真正重叠的来源路径，Archive 目录则以一次根级决策覆盖整个归档提交。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::stream::{self, StreamExt};
use russh_sftp::client::SftpSession;
use uuid::Uuid;

use super::commit::{LocalMergePrecondition, RemoteMergePrecondition, RootCommitMode};
use super::errors::TransferErrorCode;
use super::manager::TransferRunError;
use super::models::{
    TransferConflict, TransferConflictDecision, TransferConflictKind, TransferEntryKind,
    TransferStage, TransferStrategy,
};
use super::planner::{
    LocalPlan, PreparedTransfer, RemoteDownloadPlan, RemoteUploadPlan, TransferManifest,
};
use super::progress::ExecutionContext;

type RunResult<T> = Result<T, TransferRunError>;
const MAX_REMOTE_CONFLICT_PROBES: usize = 32;

/// 检查计划中的最终目标并取得完成执行所需的全部覆盖授权。
pub(crate) async fn resolve(
    prepared: &mut PreparedTransfer,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context.set_stage(TransferStage::CheckingConflicts).await;
    match &mut prepared.manifest {
        TransferManifest::Local(plan) => resolve_local(plan, strategy, context).await,
        TransferManifest::RemoteUpload(plan) => {
            resolve_remote_upload(plan, strategy, context).await
        }
        TransferManifest::RemoteDownload(plan) => {
            resolve_remote_download(plan, strategy, context).await
        }
    }
}

async fn resolve_local(
    plan: &mut LocalPlan,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut replace_remaining = false;
    let paths: Vec<_> = plan
        .roots
        .iter()
        .map(|root| root.final_path.clone())
        .collect();
    let root_kinds = local_kinds(paths).await?;
    for root in &mut plan.roots {
        let destination_kind = root_kinds.get(&root.final_path).copied().flatten();
        root.destination_kind = destination_kind;
        root.mode = resolve_root(
            strategy,
            root.kind,
            destination_kind,
            root.source_path.clone(),
            root.final_path.to_string_lossy().into_owned(),
            &mut replace_remaining,
            context,
        )
        .await?;
    }
    if strategy == TransferStrategy::Direct {
        let preconditions =
            resolve_local_direct_entries(plan, &mut replace_remaining, context).await?;
        assign_local_merge_preconditions(&mut plan.roots, preconditions);
    }
    Ok(())
}

async fn resolve_remote_upload(
    plan: &mut RemoteUploadPlan,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut replace_remaining = false;
    let paths: Vec<_> = plan
        .roots
        .iter()
        .map(|root| root.final_path.clone())
        .collect();
    let root_kinds = remote_kinds(&plan.session, paths).await?;
    for root in &mut plan.roots {
        let destination_kind = root_kinds.get(&root.final_path).copied().flatten();
        root.destination_kind = destination_kind;
        root.mode = resolve_root(
            strategy,
            root.kind,
            destination_kind,
            root.source_path.clone(),
            root.final_path.clone(),
            &mut replace_remaining,
            context,
        )
        .await?;
    }
    if strategy == TransferStrategy::Direct {
        let preconditions =
            resolve_remote_direct_entries(plan, &mut replace_remaining, context).await?;
        assign_remote_merge_preconditions(&mut plan.roots, preconditions);
    }
    Ok(())
}

async fn resolve_remote_download(
    plan: &mut RemoteDownloadPlan,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut replace_remaining = false;
    let paths: Vec<_> = plan
        .roots
        .iter()
        .map(|root| root.final_path.clone())
        .collect();
    let root_kinds = local_kinds(paths).await?;
    for root in &mut plan.roots {
        let destination_kind = root_kinds.get(&root.final_path).copied().flatten();
        root.destination_kind = destination_kind;
        root.mode = resolve_root(
            strategy,
            root.kind,
            destination_kind,
            root.source_path.clone(),
            root.final_path.to_string_lossy().into_owned(),
            &mut replace_remaining,
            context,
        )
        .await?;
    }
    if strategy == TransferStrategy::Direct {
        let preconditions =
            resolve_download_direct_entries(plan, &mut replace_remaining, context).await?;
        assign_local_merge_preconditions(&mut plan.roots, preconditions);
    }
    Ok(())
}

async fn resolve_root(
    strategy: TransferStrategy,
    source_kind: TransferEntryKind,
    destination_kind: Option<TransferEntryKind>,
    source_path: String,
    destination_path: String,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<RootCommitMode> {
    let Some(destination_kind) = destination_kind else {
        return Ok(RootCommitMode::Create);
    };
    if source_kind == TransferEntryKind::Directory
        && destination_kind == TransferEntryKind::Directory
    {
        if strategy == TransferStrategy::Direct {
            return Ok(RootCommitMode::Merge);
        }
        let decision = prompt(
            context,
            TransferConflict {
                id: Uuid::new_v4().to_string(),
                kind: TransferConflictKind::ArchiveDirectory,
                source_kind,
                destination_kind,
                source_path,
                destination_path,
                decisions: vec![
                    TransferConflictDecision::Cancel,
                    TransferConflictDecision::ReplaceDirectory,
                    TransferConflictDecision::Merge,
                ],
                allow_apply_to_remaining: false,
            },
        )
        .await?;
        return match decision {
            TransferConflictDecision::ReplaceDirectory => Ok(RootCommitMode::Replace),
            TransferConflictDecision::Merge => Ok(RootCommitMode::Merge),
            _ => Err(TransferRunError::Canceled),
        };
    }

    if strategy == TransferStrategy::Direct && *replace_remaining {
        return Ok(RootCommitMode::Replace);
    }

    let resolution = context
        .request_conflict(replacement_conflict(
            strategy,
            source_kind,
            destination_kind,
            source_path,
            destination_path,
        ))
        .await?;
    if resolution.decision == TransferConflictDecision::Replace {
        if strategy == TransferStrategy::Direct && resolution.apply_to_remaining {
            *replace_remaining = true;
        }
        Ok(RootCommitMode::Replace)
    } else {
        Err(TransferRunError::Canceled)
    }
}

fn replacement_conflict(
    strategy: TransferStrategy,
    source_kind: TransferEntryKind,
    destination_kind: TransferEntryKind,
    source_path: String,
    destination_path: String,
) -> TransferConflict {
    TransferConflict {
        id: Uuid::new_v4().to_string(),
        kind: if source_kind == destination_kind && source_kind == TransferEntryKind::File {
            TransferConflictKind::File
        } else {
            TransferConflictKind::TypeMismatch
        },
        source_kind,
        destination_kind,
        source_path,
        destination_path,
        decisions: vec![
            TransferConflictDecision::Cancel,
            TransferConflictDecision::Replace,
        ],
        allow_apply_to_remaining: strategy == TransferStrategy::Direct,
    }
}

/// Direct 目录合并中一个需要按层级判断可达性的来源条目。
struct DirectConflictEntry<T> {
    depth: usize,
    source: String,
    target: T,
}

/// 收集 Host 或 WSL Direct 合并条目，并进入分层冲突探测。
async fn resolve_local_direct_entries(
    plan: &LocalPlan,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<Vec<LocalMergePrecondition>> {
    let active = plan
        .roots
        .iter()
        .filter(|root| root.mode == RootCommitMode::Merge)
        .map(|root| root.final_path.clone())
        .collect();
    let directories = plan
        .directories
        .iter()
        .filter_map(|directory| {
            local_direct_entry(
                plan,
                &directory.destination,
                directory.source.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let files = plan
        .files
        .iter()
        .filter_map(|file| {
            local_direct_entry(plan, &file.destination, file.retry_source_path.clone())
        })
        .collect();
    resolve_local_direct_conflicts(active, directories, files, replace_remaining, context).await
}

/// 收集 SSH 下载到 Host 的 Direct 合并条目，并进入分层冲突探测。
async fn resolve_download_direct_entries(
    plan: &RemoteDownloadPlan,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<Vec<LocalMergePrecondition>> {
    let active = plan
        .roots
        .iter()
        .filter(|root| root.mode == RootCommitMode::Merge)
        .map(|root| root.final_path.clone())
        .collect();
    let directories = plan
        .directories
        .iter()
        .filter_map(|directory| {
            download_direct_entry(plan, &directory.destination, directory.source.clone())
        })
        .collect();
    let files = plan
        .files
        .iter()
        .filter_map(|file| download_direct_entry(plan, &file.destination, file.source.clone()))
        .collect();
    resolve_local_direct_conflicts(active, directories, files, replace_remaining, context).await
}

/// 按目录层级批量探测本地目标，缺失或将被整体替换的子树不再产生无效探测。
async fn resolve_local_direct_conflicts(
    mut active_directories: HashSet<PathBuf>,
    mut directories: Vec<DirectConflictEntry<PathBuf>>,
    files: Vec<DirectConflictEntry<PathBuf>>,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<Vec<LocalMergePrecondition>> {
    directories.sort_by_key(|entry| entry.depth);
    let mut preconditions = Vec::new();
    let mut index = 0;
    while index < directories.len() {
        let depth = directories[index].depth;
        let end = directories[index..]
            .iter()
            .position(|entry| entry.depth != depth)
            .map_or(directories.len(), |offset| index + offset);
        let candidates: Vec<_> = directories[index..end]
            .iter()
            .filter(|entry| {
                entry
                    .target
                    .parent()
                    .is_some_and(|parent| active_directories.contains(parent))
            })
            .collect();
        let kinds = local_kinds(candidates.iter().map(|entry| entry.target.clone())).await?;
        for entry in candidates {
            let destination_kind = kinds.get(&entry.target).copied().flatten();
            preconditions.push(LocalMergePrecondition {
                path: entry.target.clone(),
                expected_kind: destination_kind,
            });
            match destination_kind {
                Some(TransferEntryKind::Directory) => {
                    active_directories.insert(entry.target.clone());
                }
                Some(kind) if !*replace_remaining => {
                    *replace_remaining = prompt_direct_entry(
                        context,
                        entry.source.clone(),
                        entry.target.to_string_lossy().into_owned(),
                        TransferEntryKind::Directory,
                        kind,
                    )
                    .await?;
                }
                Some(_) => {}
                None => {}
            }
        }
        index = end;
    }

    let candidates: Vec<_> = files
        .iter()
        .filter(|entry| {
            entry
                .target
                .parent()
                .is_some_and(|parent| active_directories.contains(parent))
        })
        .collect();
    let kinds = local_kinds(candidates.iter().map(|entry| entry.target.clone())).await?;
    for entry in candidates {
        let destination_kind = kinds.get(&entry.target).copied().flatten();
        preconditions.push(LocalMergePrecondition {
            path: entry.target.clone(),
            expected_kind: destination_kind,
        });
        if let Some(kind) = destination_kind {
            if !*replace_remaining {
                *replace_remaining = prompt_direct_entry(
                    context,
                    entry.source.clone(),
                    entry.target.to_string_lossy().into_owned(),
                    TransferEntryKind::File,
                    kind,
                )
                .await?;
            }
        }
    }
    Ok(preconditions)
}

/// 按目录层级批量探测 SSH 目标，避免对缺失或待替换子树继续发起请求。
async fn resolve_remote_direct_entries(
    plan: &RemoteUploadPlan,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<Vec<RemoteMergePrecondition>> {
    let mut active_directories: HashSet<_> = plan
        .roots
        .iter()
        .filter(|root| root.mode == RootCommitMode::Merge)
        .map(|root| root.final_path.clone())
        .collect();
    let mut directories: Vec<_> = plan
        .directories
        .iter()
        .filter_map(|directory| {
            remote_direct_entry(
                plan,
                &directory.destination,
                directory.source.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let files: Vec<_> = plan
        .files
        .iter()
        .filter_map(|file| {
            remote_direct_entry(
                plan,
                &file.destination,
                file.source.to_string_lossy().into_owned(),
            )
        })
        .collect();
    directories.sort_by_key(|entry| entry.depth);
    let mut preconditions = Vec::new();
    let mut index = 0;
    while index < directories.len() {
        let depth = directories[index].depth;
        let end = directories[index..]
            .iter()
            .position(|entry| entry.depth != depth)
            .map_or(directories.len(), |offset| index + offset);
        let candidates: Vec<_> = directories[index..end]
            .iter()
            .filter(|entry| {
                remote_parent(&entry.target)
                    .is_some_and(|parent| active_directories.contains(parent))
            })
            .collect();
        let kinds = remote_kinds(
            &plan.session,
            candidates.iter().map(|entry| entry.target.clone()),
        )
        .await?;
        for entry in candidates {
            let destination_kind = kinds.get(&entry.target).copied().flatten();
            preconditions.push(RemoteMergePrecondition {
                path: entry.target.clone(),
                expected_kind: destination_kind,
            });
            match destination_kind {
                Some(TransferEntryKind::Directory) => {
                    active_directories.insert(entry.target.clone());
                }
                Some(kind) if !*replace_remaining => {
                    *replace_remaining = prompt_direct_entry(
                        context,
                        entry.source.clone(),
                        entry.target.clone(),
                        TransferEntryKind::Directory,
                        kind,
                    )
                    .await?;
                }
                Some(_) => {}
                None => {}
            }
        }
        index = end;
    }

    let candidates: Vec<_> = files
        .iter()
        .filter(|entry| {
            remote_parent(&entry.target).is_some_and(|parent| active_directories.contains(parent))
        })
        .collect();
    let kinds = remote_kinds(
        &plan.session,
        candidates.iter().map(|entry| entry.target.clone()),
    )
    .await?;
    for entry in candidates {
        let destination_kind = kinds.get(&entry.target).copied().flatten();
        preconditions.push(RemoteMergePrecondition {
            path: entry.target.clone(),
            expected_kind: destination_kind,
        });
        if let Some(kind) = destination_kind {
            if !*replace_remaining {
                *replace_remaining = prompt_direct_entry(
                    context,
                    entry.source.clone(),
                    entry.target.clone(),
                    TransferEntryKind::File,
                    kind,
                )
                .await?;
            }
        }
    }
    Ok(preconditions)
}

/// 将本地逐项前置条件归属到唯一的 Direct 合并根。
fn assign_local_merge_preconditions(
    roots: &mut [super::commit::LocalRoot],
    preconditions: Vec<LocalMergePrecondition>,
) {
    for precondition in preconditions {
        if let Some(root) = roots.iter_mut().find(|root| {
            root.mode == RootCommitMode::Merge && precondition.path.starts_with(&root.final_path)
        }) {
            root.merge_preconditions.push(precondition);
        }
    }
}

/// 将 SSH 逐项前置条件归属到唯一的 Direct 合并根。
fn assign_remote_merge_preconditions(
    roots: &mut [super::commit::RemoteRoot],
    preconditions: Vec<RemoteMergePrecondition>,
) {
    for precondition in preconditions {
        if let Some(root) = roots.iter_mut().find(|root| {
            root.mode == RootCommitMode::Merge
                && remote_path_is_within(&root.final_path, &precondition.path)
        }) {
            root.merge_preconditions.push(precondition);
        }
    }
}

fn remote_path_is_within(root: &str, path: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

async fn prompt_direct_entry(
    context: &mut ExecutionContext,
    source_path: String,
    destination_path: String,
    source_kind: TransferEntryKind,
    destination_kind: TransferEntryKind,
) -> RunResult<bool> {
    let kind = if source_kind == destination_kind && source_kind == TransferEntryKind::File {
        TransferConflictKind::File
    } else {
        TransferConflictKind::TypeMismatch
    };
    let resolution = context
        .request_conflict(TransferConflict {
            id: Uuid::new_v4().to_string(),
            kind,
            source_kind,
            destination_kind,
            source_path,
            destination_path,
            decisions: vec![
                TransferConflictDecision::Cancel,
                TransferConflictDecision::Replace,
            ],
            allow_apply_to_remaining: true,
        })
        .await?;
    if resolution.decision == TransferConflictDecision::Cancel {
        return Err(TransferRunError::Canceled);
    }
    Ok(resolution.apply_to_remaining)
}

async fn prompt(
    context: &mut ExecutionContext,
    conflict: TransferConflict,
) -> RunResult<TransferConflictDecision> {
    let resolution = context.request_conflict(conflict).await?;
    Ok(resolution.decision)
}

async fn local_kind(path: &Path) -> RunResult<Option<TransferEntryKind>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(Some(TransferEntryKind::File)),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            Ok(Some(TransferEntryKind::Directory))
        }
        Ok(_) => Ok(Some(TransferEntryKind::Other)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(message(format!(
            "stat transfer destination {}: {error}",
            path.display()
        ))),
    }
}

/// 以有界并发探测本地或 WSL UNC 目标，减少网络文件系统上的串行等待。
async fn local_kinds(
    paths: impl IntoIterator<Item = PathBuf>,
) -> RunResult<HashMap<PathBuf, Option<TransferEntryKind>>> {
    let unique: HashSet<_> = paths.into_iter().collect();
    let mut pending = stream::iter(unique)
        .map(|path| async move {
            let kind = local_kind(&path).await?;
            Ok::<_, TransferRunError>((path, kind))
        })
        .buffer_unordered(MAX_REMOTE_CONFLICT_PROBES);
    let mut result = HashMap::new();
    while let Some(probe) = pending.next().await {
        let (path, kind) = probe?;
        result.insert(path, kind);
    }
    Ok(result)
}

async fn remote_kind(
    session: &Arc<SftpSession>,
    path: &str,
) -> RunResult<Option<TransferEntryKind>> {
    let metadata = match super::ssh::io::run(
        format!("stat remote transfer destination {path}"),
        session.symlink_metadata(path.to_string()),
    )
    .await
    {
        Ok(metadata) => metadata,
        Err(TransferRunError::Failed(failure))
            if failure.code == TransferErrorCode::SourceUnavailable =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    Ok(Some(if metadata.file_type().is_file() {
        TransferEntryKind::File
    } else if metadata.file_type().is_dir() {
        TransferEntryKind::Directory
    } else {
        TransferEntryKind::Other
    }))
}

/// 将本地 staging 条目映射为已进入 Merge 模式的最终目标。
fn local_direct_entry(
    plan: &LocalPlan,
    stage: &Path,
    source: String,
) -> Option<DirectConflictEntry<PathBuf>> {
    let (root_stage, target) = local_final_path(plan, stage)?;
    let root = plan
        .roots
        .iter()
        .find(|root| root.stage == root_stage && root.mode == RootCommitMode::Merge)?;
    let relative = stage.strip_prefix(&root.stage).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(DirectConflictEntry {
        depth: relative.components().count(),
        source,
        target,
    })
}

/// 将 SSH 下载 staging 条目映射为已进入 Merge 模式的本地最终目标。
fn download_direct_entry(
    plan: &RemoteDownloadPlan,
    stage: &Path,
    source: String,
) -> Option<DirectConflictEntry<PathBuf>> {
    let (root_stage, target) = local_download_final_path(plan, stage)?;
    let root = plan
        .roots
        .iter()
        .find(|root| root.stage == root_stage && root.mode == RootCommitMode::Merge)?;
    let relative = stage.strip_prefix(&root.stage).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(DirectConflictEntry {
        depth: relative.components().count(),
        source,
        target,
    })
}

/// 将 SSH 上传 staging 条目映射为已进入 Merge 模式的远端最终目标。
fn remote_direct_entry(
    plan: &RemoteUploadPlan,
    stage: &str,
    source: String,
) -> Option<DirectConflictEntry<String>> {
    let (root_stage, target) = remote_final_path(plan, stage)?;
    let root = plan
        .roots
        .iter()
        .find(|root| root.stage == root_stage && root.mode == RootCommitMode::Merge)?;
    let relative = stage
        .strip_prefix(&root.stage)
        .and_then(|suffix| suffix.strip_prefix('/'))?;
    Some(DirectConflictEntry {
        depth: relative.split('/').count(),
        source,
        target,
    })
}

fn remote_parent(path: &str) -> Option<&str> {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
}

/// 以固定并发窗口批量探测 SSH 目标，避免高延迟链路逐文件串行往返。
async fn remote_kinds(
    session: &Arc<SftpSession>,
    paths: impl IntoIterator<Item = String>,
) -> RunResult<HashMap<String, Option<TransferEntryKind>>> {
    let unique: HashSet<_> = paths.into_iter().collect();
    let mut pending = stream::iter(unique)
        .map(|path| {
            let session = session.clone();
            async move {
                let kind = remote_kind(&session, &path).await?;
                Ok::<_, TransferRunError>((path, kind))
            }
        })
        .buffer_unordered(MAX_REMOTE_CONFLICT_PROBES);
    let mut result = HashMap::new();
    while let Some(probe) = pending.next().await {
        let (path, kind) = probe?;
        result.insert(path, kind);
    }
    Ok(result)
}

fn local_final_path(plan: &LocalPlan, stage: &Path) -> Option<(PathBuf, PathBuf)> {
    plan.roots.iter().find_map(|root| {
        stage.strip_prefix(&root.stage).ok().map(|relative| {
            (
                root.stage.clone(),
                if relative.as_os_str().is_empty() {
                    root.final_path.clone()
                } else {
                    root.final_path.join(relative)
                },
            )
        })
    })
}

fn local_download_final_path(
    plan: &RemoteDownloadPlan,
    stage: &Path,
) -> Option<(PathBuf, PathBuf)> {
    plan.roots.iter().find_map(|root| {
        stage.strip_prefix(&root.stage).ok().map(|relative| {
            (
                root.stage.clone(),
                if relative.as_os_str().is_empty() {
                    root.final_path.clone()
                } else {
                    root.final_path.join(relative)
                },
            )
        })
    })
}

fn remote_final_path(plan: &RemoteUploadPlan, stage: &str) -> Option<(String, String)> {
    plan.roots.iter().find_map(|root| {
        if stage == root.stage {
            return Some((root.stage.clone(), root.final_path.clone()));
        }
        stage
            .strip_prefix(&root.stage)
            .and_then(|suffix| suffix.strip_prefix('/'))
            .map(|relative| {
                (
                    root.stage.clone(),
                    crate::modules::remote::session::join_remote(&root.final_path, relative),
                )
            })
    })
}

fn message(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IoFailed, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_direct_replacement_conflicts_offer_replace_all() {
        let direct = replacement_conflict(
            TransferStrategy::Direct,
            TransferEntryKind::File,
            TransferEntryKind::File,
            "/source".into(),
            "/target".into(),
        );
        let archive = replacement_conflict(
            TransferStrategy::Archive,
            TransferEntryKind::File,
            TransferEntryKind::File,
            "/source".into(),
            "/target".into(),
        );

        assert!(direct.allow_apply_to_remaining);
        assert!(!archive.allow_apply_to_remaining);
        assert_eq!(direct.kind, TransferConflictKind::File);
        assert_eq!(
            direct.decisions,
            vec![
                TransferConflictDecision::Cancel,
                TransferConflictDecision::Replace
            ]
        );
    }

    #[test]
    fn remote_precondition_ownership_uses_component_boundaries() {
        assert!(remote_path_is_within("/srv/project", "/srv/project/file"));
        assert!(!remote_path_is_within(
            "/srv/project",
            "/srv/project-old/file"
        ));
    }
}
