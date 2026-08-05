//! 文件传输目标冲突探测与用户决策。
//!
//! 本模块只读取最终目标并调整 Manifest，不写入用户路径。Direct 目录只询问真正
//! 重叠的来源路径，并移除用户跳过的条目；Archive 目录以一次根级决策覆盖整个提交。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::Hash;
use std::path::{Path, PathBuf};

use futures_util::stream::{self, StreamExt};
use uuid::Uuid;

use super::commit::{MergePrecondition, RootCommitMode, TransferRoot};
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
const MAX_LOCAL_CONFLICT_PROBES: usize = 32;

/// 检查计划中的最终目标并取得完成执行所需的全部覆盖授权。
pub(crate) async fn resolve(
    prepared: &mut PreparedTransfer,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<bool> {
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
) -> RunResult<bool> {
    let mut replace_remaining = false;
    resolve_roots(
        &mut plan.roots,
        strategy,
        &mut replace_remaining,
        context,
        local_kinds,
        |path| path.to_string_lossy().into_owned(),
    )
    .await?;
    if strategy == TransferStrategy::Direct {
        let resolution =
            resolve_local_direct_entries(plan, &mut replace_remaining, context).await?;
        assign_merge_preconditions(&mut plan.roots, resolution.preconditions);
        return Ok(retain_local_unskipped(plan, &resolution.skipped));
    }
    Ok(false)
}

async fn resolve_remote_upload(
    plan: &mut RemoteUploadPlan,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<bool> {
    let mut replace_remaining = false;
    let session = plan.session.clone();
    resolve_roots(
        &mut plan.roots,
        strategy,
        &mut replace_remaining,
        context,
        move |paths| {
            let session = session.clone();
            async move { super::ssh::io::entry_kinds(&session, paths).await }
        },
        Clone::clone,
    )
    .await?;
    if strategy == TransferStrategy::Direct {
        let resolution =
            resolve_remote_direct_entries(plan, &mut replace_remaining, context).await?;
        assign_merge_preconditions(&mut plan.roots, resolution.preconditions);
        return Ok(retain_remote_upload_unskipped(plan, &resolution.skipped));
    }
    Ok(false)
}

async fn resolve_remote_download(
    plan: &mut RemoteDownloadPlan,
    strategy: TransferStrategy,
    context: &mut ExecutionContext,
) -> RunResult<bool> {
    let mut replace_remaining = false;
    resolve_roots(
        &mut plan.roots,
        strategy,
        &mut replace_remaining,
        context,
        local_kinds,
        |path| path.to_string_lossy().into_owned(),
    )
    .await?;
    if strategy == TransferStrategy::Direct {
        let resolution =
            resolve_download_direct_entries(plan, &mut replace_remaining, context).await?;
        assign_merge_preconditions(&mut plan.roots, resolution.preconditions);
        return Ok(retain_remote_download_unskipped(plan, &resolution.skipped));
    }
    Ok(false)
}

/// 批量探测最终目标，并为三种传输方向复用根级冲突决策流程。
async fn resolve_roots<P, Query, QueryFuture, Display>(
    roots: &mut [TransferRoot<P>],
    strategy: TransferStrategy,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
    query_kinds: Query,
    display: Display,
) -> RunResult<()>
where
    P: Clone + Eq + Hash,
    Query: FnOnce(Vec<P>) -> QueryFuture,
    QueryFuture: Future<Output = RunResult<HashMap<P, Option<TransferEntryKind>>>>,
    Display: Fn(&P) -> String,
{
    let root_kinds =
        query_kinds(roots.iter().map(|root| root.final_path.clone()).collect()).await?;
    for root in roots {
        let destination_kind = root_kinds.get(&root.final_path).copied().flatten();
        root.destination_kind = destination_kind;
        root.mode = resolve_root(
            strategy,
            root.kind,
            destination_kind,
            root.source_path.clone(),
            display(&root.final_path),
            replace_remaining,
            context,
        )
        .await?;
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
            archive_directory_conflict(source_path, destination_path),
        )
        .await?;
        return match decision {
            TransferConflictDecision::ReplaceDirectory => Ok(RootCommitMode::Replace),
            TransferConflictDecision::Merge => Ok(RootCommitMode::Merge),
            TransferConflictDecision::MergeSkip => Ok(RootCommitMode::MergeSkip),
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

fn archive_directory_conflict(source_path: String, destination_path: String) -> TransferConflict {
    TransferConflict {
        id: Uuid::new_v4().to_string(),
        kind: TransferConflictKind::ArchiveDirectory,
        source_kind: TransferEntryKind::Directory,
        destination_kind: TransferEntryKind::Directory,
        source_path,
        destination_path,
        decisions: vec![
            TransferConflictDecision::Cancel,
            TransferConflictDecision::ReplaceDirectory,
            TransferConflictDecision::Merge,
            TransferConflictDecision::MergeSkip,
        ],
        allow_apply_to_remaining: false,
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
    root_index: usize,
    depth: usize,
    source: String,
    target: T,
}

/// 一次 Direct 合并冲突探测所需的目录状态和待检查条目。
struct DirectConflictPlan<T> {
    active_directories: HashSet<T>,
    directories: Vec<DirectConflictEntry<T>>,
    files: Vec<DirectConflictEntry<T>>,
}

/// Direct 逐项冲突解析后的提交前置条件和用户明确跳过的目标。
struct DirectResolution<T> {
    preconditions: Vec<(usize, MergePrecondition<T>)>,
    skipped: Vec<T>,
}

#[derive(Clone, Copy)]
enum DirectEntryAction {
    Replace,
    Skip,
}

/// 收集 Host 或 WSL Direct 合并条目，并进入分层冲突探测。
async fn resolve_local_direct_entries(
    plan: &LocalPlan,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<DirectResolution<PathBuf>> {
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
                directory.root_index,
                plan.roots.get(directory.root_index)?,
                &directory.destination,
                directory.final_destination.clone(),
                directory.source.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let files = plan
        .files
        .iter()
        .filter_map(|file| {
            local_direct_entry(
                file.root_index,
                plan.roots.get(file.root_index)?,
                &file.destination,
                file.final_destination.clone(),
                file.retry_source_path.clone(),
            )
        })
        .collect();
    resolve_local_direct_conflicts(active, directories, files, replace_remaining, context).await
}

/// 收集 SSH 下载到 Host 的 Direct 合并条目，并进入分层冲突探测。
async fn resolve_download_direct_entries(
    plan: &RemoteDownloadPlan,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<DirectResolution<PathBuf>> {
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
                directory.root_index,
                plan.roots.get(directory.root_index)?,
                &directory.destination,
                directory.final_destination.clone(),
                directory.source.clone(),
            )
        })
        .collect();
    let files = plan
        .files
        .iter()
        .filter_map(|file| {
            local_direct_entry(
                file.root_index,
                plan.roots.get(file.root_index)?,
                &file.destination,
                file.final_destination.clone(),
                file.source.clone(),
            )
        })
        .collect();
    resolve_local_direct_conflicts(active, directories, files, replace_remaining, context).await
}

/// 按目录层级批量探测本地目标，缺失或将被整体替换的子树不再产生无效探测。
async fn resolve_local_direct_conflicts(
    active_directories: HashSet<PathBuf>,
    directories: Vec<DirectConflictEntry<PathBuf>>,
    files: Vec<DirectConflictEntry<PathBuf>>,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<DirectResolution<PathBuf>> {
    resolve_direct_conflicts(
        DirectConflictPlan {
            active_directories,
            directories,
            files,
        },
        replace_remaining,
        context,
        local_kinds,
        |path| path.parent().map(Path::to_path_buf),
        |path| path.to_string_lossy().into_owned(),
    )
    .await
}

/// 按目录层级批量探测 SSH 目标，避免对缺失或待替换子树继续发起请求。
async fn resolve_remote_direct_entries(
    plan: &RemoteUploadPlan,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
) -> RunResult<DirectResolution<String>> {
    let active_directories: HashSet<_> = plan
        .roots
        .iter()
        .filter(|root| root.mode == RootCommitMode::Merge)
        .map(|root| root.final_path.clone())
        .collect();
    let directories: Vec<_> = plan
        .directories
        .iter()
        .filter_map(|directory| {
            remote_direct_entry(
                directory.root_index,
                plan.roots.get(directory.root_index)?,
                &directory.destination,
                directory.final_destination.clone(),
                directory.source.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let files: Vec<_> = plan
        .files
        .iter()
        .filter_map(|file| {
            remote_direct_entry(
                file.root_index,
                plan.roots.get(file.root_index)?,
                &file.destination,
                file.final_destination.clone(),
                file.source.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let session = plan.session.clone();
    resolve_direct_conflicts(
        DirectConflictPlan {
            active_directories,
            directories,
            files,
        },
        replace_remaining,
        context,
        move |paths| {
            let session = session.clone();
            async move { super::ssh::io::entry_kinds(&session, paths).await }
        },
        |path| remote_parent(path).map(str::to_string),
        Clone::clone,
    )
    .await
}

/// 复用 Direct 目录合并的分层探测和逐项授权流程，路径 I/O 由后端批量查询函数提供。
async fn resolve_direct_conflicts<P, Query, QueryFuture, Parent, Display>(
    mut plan: DirectConflictPlan<P>,
    replace_remaining: &mut bool,
    context: &mut ExecutionContext,
    mut query_kinds: Query,
    parent: Parent,
    display: Display,
) -> RunResult<DirectResolution<P>>
where
    P: Clone + Eq + Hash,
    Query: FnMut(Vec<P>) -> QueryFuture,
    QueryFuture: Future<Output = RunResult<HashMap<P, Option<TransferEntryKind>>>>,
    Parent: Fn(&P) -> Option<P>,
    Display: Fn(&P) -> String,
{
    plan.directories.sort_by_key(|entry| entry.depth);
    let mut preconditions = Vec::new();
    let mut skipped = Vec::new();
    let mut skip_remaining = false;
    let mut index = 0;
    while index < plan.directories.len() {
        let depth = plan.directories[index].depth;
        let end = plan.directories[index..]
            .iter()
            .position(|entry| entry.depth != depth)
            .map_or(plan.directories.len(), |offset| index + offset);
        let candidates: Vec<_> = plan.directories[index..end]
            .iter()
            .filter(|entry| {
                parent(&entry.target).is_some_and(|path| plan.active_directories.contains(&path))
            })
            .collect();
        let kinds = query_kinds(
            candidates
                .iter()
                .map(|entry| entry.target.clone())
                .collect(),
        )
        .await?;
        for entry in candidates {
            let destination_kind = kinds.get(&entry.target).copied().flatten();
            let skip = match destination_kind {
                Some(TransferEntryKind::Directory) => {
                    plan.active_directories.insert(entry.target.clone());
                    false
                }
                Some(kind) => matches!(
                    direct_entry_action(
                        replace_remaining,
                        &mut skip_remaining,
                        context,
                        entry.source.clone(),
                        display(&entry.target),
                        TransferEntryKind::Directory,
                        kind,
                    )
                    .await?,
                    DirectEntryAction::Skip
                ),
                None => false,
            };
            if skip {
                skipped.push(entry.target.clone());
            } else {
                preconditions.push((
                    entry.root_index,
                    MergePrecondition {
                        path: entry.target.clone(),
                        expected_kind: destination_kind,
                    },
                ));
            }
        }
        index = end;
    }

    let candidates: Vec<_> = plan
        .files
        .iter()
        .filter(|entry| {
            parent(&entry.target).is_some_and(|path| plan.active_directories.contains(&path))
        })
        .collect();
    let kinds = query_kinds(
        candidates
            .iter()
            .map(|entry| entry.target.clone())
            .collect(),
    )
    .await?;
    for entry in candidates {
        let destination_kind = kinds.get(&entry.target).copied().flatten();
        let skip = if let Some(kind) = destination_kind {
            matches!(
                direct_entry_action(
                    replace_remaining,
                    &mut skip_remaining,
                    context,
                    entry.source.clone(),
                    display(&entry.target),
                    TransferEntryKind::File,
                    kind,
                )
                .await?,
                DirectEntryAction::Skip
            )
        } else {
            false
        };
        if skip {
            skipped.push(entry.target.clone());
        } else {
            preconditions.push((
                entry.root_index,
                MergePrecondition {
                    path: entry.target.clone(),
                    expected_kind: destination_kind,
                },
            ));
        }
    }
    Ok(DirectResolution {
        preconditions,
        skipped,
    })
}

/// 从 Host 或 WSL 的实际执行 Manifest 移除用户跳过的条目及目录子树。
fn retain_local_unskipped(plan: &mut LocalPlan, skipped: &[PathBuf]) -> bool {
    let previous = plan.directories.len() + plan.files.len();
    plan.directories
        .retain(|entry| !local_target_skipped(&entry.final_destination, skipped));
    plan.files
        .retain(|entry| !local_target_skipped(&entry.final_destination, skipped));
    previous != plan.directories.len() + plan.files.len()
}

/// 从 SSH 上传 Manifest 移除用户跳过的远端条目及目录子树。
fn retain_remote_upload_unskipped(plan: &mut RemoteUploadPlan, skipped: &[String]) -> bool {
    let previous = plan.directories.len() + plan.files.len();
    plan.directories
        .retain(|entry| !remote_target_skipped(&entry.final_destination, skipped));
    plan.files
        .retain(|entry| !remote_target_skipped(&entry.final_destination, skipped));
    previous != plan.directories.len() + plan.files.len()
}

/// 从 SSH 下载 Manifest 移除用户跳过的本地条目及目录子树。
fn retain_remote_download_unskipped(plan: &mut RemoteDownloadPlan, skipped: &[PathBuf]) -> bool {
    let previous = plan.directories.len() + plan.files.len();
    plan.directories
        .retain(|entry| !local_target_skipped(&entry.final_destination, skipped));
    plan.files
        .retain(|entry| !local_target_skipped(&entry.final_destination, skipped));
    previous != plan.directories.len() + plan.files.len()
}

fn local_target_skipped(path: &Path, skipped: &[PathBuf]) -> bool {
    skipped.iter().any(|target| path.starts_with(target))
}

fn remote_target_skipped(path: &str, skipped: &[String]) -> bool {
    skipped.iter().any(|target| {
        path == target
            || path
                .strip_prefix(target)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

/// 将逐项前置条件归属到规划阶段记录的 Direct 合并根。
fn assign_merge_preconditions<P>(
    roots: &mut [TransferRoot<P>],
    preconditions: Vec<(usize, MergePrecondition<P>)>,
) {
    for (root_index, precondition) in preconditions {
        if let Some(root) = roots
            .get_mut(root_index)
            .filter(|root| root.mode == RootCommitMode::Merge)
        {
            root.merge_preconditions.push(precondition);
        }
    }
}

/// 复用本次任务的批量决策，否则请求用户处理一个 Direct 子项冲突。
async fn direct_entry_action(
    replace_remaining: &mut bool,
    skip_remaining: &mut bool,
    context: &mut ExecutionContext,
    source_path: String,
    destination_path: String,
    source_kind: TransferEntryKind,
    destination_kind: TransferEntryKind,
) -> RunResult<DirectEntryAction> {
    if *replace_remaining {
        return Ok(DirectEntryAction::Replace);
    }
    if *skip_remaining {
        return Ok(DirectEntryAction::Skip);
    }
    let resolution = context
        .request_conflict(direct_entry_conflict(
            source_path,
            destination_path,
            source_kind,
            destination_kind,
        ))
        .await?;
    let action = match resolution.decision {
        TransferConflictDecision::Replace => DirectEntryAction::Replace,
        TransferConflictDecision::Skip => DirectEntryAction::Skip,
        _ => return Err(TransferRunError::Canceled),
    };
    if resolution.apply_to_remaining {
        match action {
            DirectEntryAction::Replace => *replace_remaining = true,
            DirectEntryAction::Skip => *skip_remaining = true,
        }
    }
    Ok(action)
}

fn direct_entry_conflict(
    source_path: String,
    destination_path: String,
    source_kind: TransferEntryKind,
    destination_kind: TransferEntryKind,
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
            TransferConflictDecision::Skip,
            TransferConflictDecision::Replace,
        ],
        allow_apply_to_remaining: true,
    }
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
        .buffer_unordered(MAX_LOCAL_CONFLICT_PROBES);
    let mut result = HashMap::new();
    while let Some(probe) = pending.next().await {
        let (path, kind) = probe?;
        result.insert(path, kind);
    }
    Ok(result)
}

/// 将本地 staging 条目映射为已进入 Merge 模式的最终目标。
fn local_direct_entry(
    root_index: usize,
    root: &super::commit::LocalRoot,
    stage: &Path,
    target: PathBuf,
    source: String,
) -> Option<DirectConflictEntry<PathBuf>> {
    if root.mode != RootCommitMode::Merge {
        return None;
    }
    let relative = stage.strip_prefix(&root.stage).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(DirectConflictEntry {
        root_index,
        depth: relative.components().count(),
        source,
        target,
    })
}

/// 将 SSH 上传 staging 条目映射为已进入 Merge 模式的远端最终目标。
fn remote_direct_entry(
    root_index: usize,
    root: &super::commit::RemoteRoot,
    stage: &str,
    target: String,
    source: String,
) -> Option<DirectConflictEntry<String>> {
    if root.mode != RootCommitMode::Merge {
        return None;
    }
    let relative = stage
        .strip_prefix(&root.stage)
        .and_then(|suffix| suffix.strip_prefix('/'))?;
    Some(DirectConflictEntry {
        root_index,
        depth: relative.split('/').count(),
        source,
        target,
    })
}

fn remote_parent(path: &str) -> Option<&str> {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
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
    fn archive_directory_conflicts_offer_both_merge_precedence_modes() {
        let conflict = archive_directory_conflict("/source".into(), "/target".into());

        assert_eq!(
            conflict.decisions,
            vec![
                TransferConflictDecision::Cancel,
                TransferConflictDecision::ReplaceDirectory,
                TransferConflictDecision::Merge,
                TransferConflictDecision::MergeSkip,
            ]
        );
        assert!(!conflict.allow_apply_to_remaining);
    }

    #[test]
    fn direct_child_conflicts_offer_skip_and_subtree_matching_is_component_safe() {
        let conflict = direct_entry_conflict(
            "/source/file".into(),
            "/target/file".into(),
            TransferEntryKind::File,
            TransferEntryKind::File,
        );

        assert_eq!(
            conflict.decisions,
            vec![
                TransferConflictDecision::Cancel,
                TransferConflictDecision::Skip,
                TransferConflictDecision::Replace,
            ]
        );
        assert!(conflict.allow_apply_to_remaining);
        assert!(local_target_skipped(
            Path::new("/target/folder/file"),
            &[PathBuf::from("/target/folder")],
        ));
        assert!(!local_target_skipped(
            Path::new("/target/folder-copy/file"),
            &[PathBuf::from("/target/folder")],
        ));
        assert!(remote_target_skipped(
            "/target/folder/file",
            &["/target/folder".into()],
        ));
        assert!(!remote_target_skipped(
            "/target/folder-copy/file",
            &["/target/folder".into()],
        ));
    }

    #[test]
    fn direct_entries_keep_their_planned_root_index() {
        let root = super::super::commit::RemoteRoot {
            source_path: "/source".into(),
            stage: "/target/.terax-part-task-0".into(),
            final_path: "/target/project".into(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::Merge,
            merge_preconditions: Vec::new(),
        };

        let entry = remote_direct_entry(
            7,
            &root,
            "/target/.terax-part-task-0/src/main.rs",
            "/target/project/src/main.rs".into(),
            "/source/src/main.rs".into(),
        )
        .expect("a child of a merge root should be checked");

        assert_eq!(entry.root_index, 7);
        assert_eq!(entry.depth, 2);
    }
}
