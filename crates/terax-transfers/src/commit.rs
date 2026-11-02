//! 文件传输 staging、覆盖事务与任务所有权清理。
//!
//! 每个顶层来源写入最终目标同级的固定长度 staging 路径。新目标和文件使用
//! rename 发布；已存在的目录在原位协调条目，保持最终仍存在的目录身份。失败时按
//! 逆操作恢复任务 backup，清理不删除未经授权的用户路径。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use russh_sftp::client::SftpSession;

use terax_core::modules::remote::session::{join_remote, shell_quote, RemoteWorkspace};

use super::cleanup_ticket::{CleanupTicket, CleanupTicketTarget};
use super::diagnostics::PhaseTimer;
use super::errors::TransferErrorCode;
use super::manager::TransferRunError;
use super::models::TransferEntryKind;
use super::progress::ExecutionContext;

const MAX_REMOTE_PRECONDITION_PROBES: usize = 32;
const REMOTE_COMMIT_OUTPUT_LIMIT: usize = 1024 * 1024;
const LOCAL_CLEANUP_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const LOCAL_CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);
pub(crate) const REMOTE_COMMIT_CLEANUP_PENDING_MARKER: &str = "TERAX_BACKUP_CLEANUP_PENDING_V1";

/// 顶层来源在最终目标上的提交方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RootCommitMode {
    Create,
    Replace,
    Merge,
    MergeSkip,
    MergeNewer,
}

/// 顶层来源的 staging、最终目标和冲突授权。
#[derive(Clone)]
pub(crate) struct TransferRoot<P> {
    pub(crate) source_path: String,
    pub(crate) stage: P,
    pub(crate) final_path: P,
    pub(crate) kind: TransferEntryKind,
    pub(crate) destination_kind: Option<TransferEntryKind>,
    pub(crate) mode: RootCommitMode,
    pub(crate) merge_preconditions: Vec<MergePrecondition<P>>,
}

/// Direct 目录合并在冲突检查时观察到的子项状态。
#[derive(Clone)]
pub(crate) struct MergePrecondition<P> {
    pub(crate) path: P,
    pub(crate) expected_kind: Option<TransferEntryKind>,
}

pub(crate) type LocalRoot = TransferRoot<PathBuf>;
pub(crate) type RemoteRoot = TransferRoot<String>;

fn can_atomically_replace_single_file<P>(root: &TransferRoot<P>) -> bool {
    root.mode == RootCommitMode::Replace
        && root.kind == TransferEntryKind::File
        && root.destination_kind == Some(TransferEntryKind::File)
}

/// 为本地目标的可能 backup 创建持久化 recovery 票据。
pub(crate) fn local_cleanup_ticket(
    staging_task_id: &str,
    owner_task_id: &str,
    roots: &[LocalRoot],
) -> RunResult<Option<CleanupTicket>> {
    local_cleanup_ticket_for_paths(
        staging_task_id,
        owner_task_id,
        roots
            .iter()
            .filter(|root| root.mode != RootCommitMode::Create)
            .map(local_backup_path),
    )
}

/// 为已映射到宿主文件系统的 backup 路径创建 recovery 票据。
pub(crate) fn local_cleanup_ticket_for_paths(
    staging_task_id: &str,
    owner_task_id: &str,
    paths: impl IntoIterator<Item = PathBuf>,
) -> RunResult<Option<CleanupTicket>> {
    let paths = paths
        .into_iter()
        .map(|path| {
            path.into_os_string().into_string().map_err(|_| {
                TransferRunError::failed(
                    TransferErrorCode::InvalidRequest,
                    "transfer cleanup path is not valid UTF-8",
                )
            })
        })
        .collect::<RunResult<Vec<_>>>()?;
    Ok((!paths.is_empty()).then(|| {
        CleanupTicket::recovery(CleanupTicketTarget::Local {
            staging_task_id: staging_task_id.to_string(),
            owner_task_id: owner_task_id.to_string(),
            paths,
        })
    }))
}

/// 返回 SSH 或 WSL 目标上可能保留恢复数据的 backup 路径。
pub(crate) fn remote_backup_paths(roots: &[RemoteRoot]) -> Vec<String> {
    roots
        .iter()
        .filter(|root| root.mode != RootCommitMode::Create)
        .map(remote_backup_path)
        .collect()
}

fn local_ticket_has_pending_paths(ticket: Option<&CleanupTicket>, pending: &[PathBuf]) -> bool {
    let Some(CleanupTicket {
        target: CleanupTicketTarget::Local { paths, .. },
        ..
    }) = ticket
    else {
        return false;
    };
    paths
        .iter()
        .any(|path| pending.iter().any(|pending| pending == Path::new(path)))
}

fn remote_ticket_has_pending_paths(ticket: Option<&CleanupTicket>, pending: &[String]) -> bool {
    let Some(CleanupTicket {
        target: CleanupTicketTarget::Ssh { paths, .. },
        ..
    }) = ticket
    else {
        return false;
    };
    paths.iter().any(|path| pending.contains(path))
}

/// 确认本地目标尚不存在，未知元数据错误不得被当作空闲目标。
pub(crate) async fn ensure_local_target_available(path: &Path) -> RunResult<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Err(TransferRunError::failed(
            TransferErrorCode::DestinationExists,
            format!("destination already exists: {}", path.display()),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(message(format!(
            "stat destination {}: {error}",
            path.display()
        ))),
    }
}

/// 确认 SSH 目标尚不存在。
pub(crate) async fn ensure_remote_target_available(
    session: &Arc<SftpSession>,
    path: &str,
) -> RunResult<()> {
    let exists = super::ssh::io::run(
        format!("stat remote destination {path}"),
        session.try_exists(path.to_string()),
    )
    .await?;
    if exists {
        Err(TransferRunError::failed(
            TransferErrorCode::DestinationExists,
            format!("destination already exists: {path}"),
        ))
    } else {
        Ok(())
    }
}

/// 为本地目标生成固定长度的同级 staging 路径。
pub(crate) fn local_stage_path(
    final_path: &Path,
    task_id: &str,
    root_index: usize,
) -> RunResult<PathBuf> {
    let parent = final_path.parent().ok_or_else(|| {
        message(format!(
            "destination has no parent: {}",
            final_path.display()
        ))
    })?;
    Ok(parent.join(format!(".terax-part-{task_id}-{root_index}")))
}

/// 为 SSH 目标生成固定长度的同级 staging 路径。
pub(crate) fn remote_stage_path(
    final_path: &str,
    task_id: &str,
    root_index: usize,
) -> RunResult<String> {
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

/// 按冲突阶段确定的模式提交一个本地 staging 根，并返回未清理的任务路径。
pub(crate) async fn commit_local_root(root: &LocalRoot) -> RunResult<Vec<PathBuf>> {
    ensure_local_merge_preconditions(root).await?;
    let final_path = root.final_path.clone();
    let root = root.clone();
    tokio::task::spawn_blocking(move || commit_local_roots_blocking(std::slice::from_ref(&root)))
        .await
        .map_err(|error| message(format!("join local commit task: {error}")))?
        .map_err(|error| message(format!("commit transfer {}: {error}", final_path.display())))
}

/// 在 Journal 清理票据保护下提交一个本地根。
pub(crate) async fn commit_local_root_tracked(
    root: &LocalRoot,
    staging_task_id: &str,
    owner_task_id: &str,
    context: &ExecutionContext,
) -> RunResult<Vec<PathBuf>> {
    let cleanup_ticket = if can_atomically_replace_single_file(root) {
        None
    } else {
        local_cleanup_ticket(staging_task_id, owner_task_id, std::slice::from_ref(root))?
    };
    let mut ticket = context.register_cleanup_ticket(cleanup_ticket).await?;
    let pending = commit_local_root(root).await?;
    let cleanup_pending = local_ticket_has_pending_paths(ticket.as_ref(), &pending);
    context
        .complete_cleanup_ticket(ticket.as_mut(), cleanup_pending)
        .await?;
    Ok(pending)
}

/// 将 Archive 的全部本地根作为一个可回滚事务提交。
///
/// 任一发布失败都会恢复全部旧目标；只有发布全部完成后才会返回可安全重试的残留路径。
pub(crate) async fn commit_local_roots(roots: &[LocalRoot]) -> RunResult<Vec<PathBuf>> {
    let roots = roots.to_vec();
    tokio::task::spawn_blocking(move || commit_local_roots_blocking(&roots))
        .await
        .map_err(|error| message(format!("join local archive commit task: {error}")))?
        .map_err(|error| message(format!("commit local archive transaction: {error}")))
}

/// 在 Journal 清理票据保护下提交 Archive 的全部本地根。
pub(crate) async fn commit_local_roots_tracked(
    roots: &[LocalRoot],
    staging_task_id: &str,
    owner_task_id: &str,
    context: &ExecutionContext,
) -> RunResult<Vec<PathBuf>> {
    let cleanup_ticket = match roots {
        [root] if can_atomically_replace_single_file(root) => None,
        _ => local_cleanup_ticket(staging_task_id, owner_task_id, roots)?,
    };
    let mut ticket = context.register_cleanup_ticket(cleanup_ticket).await?;
    let _timer = PhaseTimer::new(context.task_id(), "local_commit_including_cleanup");
    let pending = commit_local_roots(roots).await?;
    let cleanup_pending = local_ticket_has_pending_paths(ticket.as_ref(), &pending);
    context
        .complete_cleanup_ticket(ticket.as_mut(), cleanup_pending)
        .await?;
    Ok(pending)
}

/// 按冲突阶段确定的模式提交一个 SSH staging 根，并返回未清理的任务路径。
pub(crate) async fn commit_remote_root(
    workspace: &Arc<RemoteWorkspace>,
    session: &Arc<SftpSession>,
    root: &RemoteRoot,
) -> RunResult<Vec<String>> {
    if root.mode == RootCommitMode::Create {
        ensure_remote_target_available(session, &root.final_path).await?;
        super::ssh::io::run(
            format!("commit remote transfer {}", root.final_path),
            session.rename(root.stage.clone(), root.final_path.clone()),
        )
        .await?;
        return Ok(Vec::new());
    }
    ensure_remote_merge_preconditions(session, root).await?;
    if can_atomically_replace_single_file(root) {
        let command = format!(
            "set -e\n{}mv -T -f -- {} {}\n",
            remote_precondition(root),
            shell_quote(&root.stage),
            shell_quote(&root.final_path)
        );
        execute_remote_commit(workspace, &command, "commit remote file replacement").await?;
        return Ok(Vec::new());
    }
    commit_remote_roots(workspace, std::slice::from_ref(root)).await
}

/// 在绑定 SSH endpoint 的 Journal 清理票据保护下提交一个远程根。
pub(crate) async fn commit_remote_root_tracked(
    workspace: &Arc<RemoteWorkspace>,
    session: &Arc<SftpSession>,
    root: &RemoteRoot,
    cleanup_scope: &super::ssh::cleanup::RemoteCleanupScope,
    context: &ExecutionContext,
) -> RunResult<Vec<String>> {
    let cleanup_ticket = if can_atomically_replace_single_file(root) {
        None
    } else {
        cleanup_scope.cleanup_ticket(remote_backup_paths(std::slice::from_ref(root)))?
    };
    let mut ticket = context.register_cleanup_ticket(cleanup_ticket).await?;
    let pending = commit_remote_root(workspace, session, root).await?;
    let cleanup_pending = remote_ticket_has_pending_paths(ticket.as_ref(), &pending);
    context
        .complete_cleanup_ticket(ticket.as_mut(), cleanup_pending)
        .await?;
    Ok(pending)
}

/// 在一次目标端 Shell 事务中提交全部 SSH Archive 根。
///
/// 失败时反向回滚；成功时返回 Shell 未能删除的 staging 或 backup。
pub(crate) async fn commit_remote_roots(
    workspace: &Arc<RemoteWorkspace>,
    roots: &[RemoteRoot],
) -> RunResult<Vec<String>> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let (command, cleanup_paths) = remote_commit_command(roots);
    let cleanup_pending =
        execute_remote_commit(workspace, &command, "commit remote archive transaction").await?;
    Ok(if cleanup_pending {
        cleanup_paths
    } else {
        Vec::new()
    })
}

/// 在绑定 SSH endpoint 的 Journal 清理票据保护下提交全部远程根。
pub(crate) async fn commit_remote_roots_tracked(
    workspace: &Arc<RemoteWorkspace>,
    roots: &[RemoteRoot],
    cleanup_scope: &super::ssh::cleanup::RemoteCleanupScope,
    context: &ExecutionContext,
) -> RunResult<Vec<String>> {
    let mut ticket = context
        .register_cleanup_ticket(cleanup_scope.cleanup_ticket(remote_backup_paths(roots))?)
        .await?;
    let _timer = PhaseTimer::new(context.task_id(), "ssh_commit_including_cleanup");
    let pending = commit_remote_roots(workspace, roots).await?;
    let cleanup_pending = remote_ticket_has_pending_paths(ticket.as_ref(), &pending);
    context
        .complete_cleanup_ticket(ticket.as_mut(), cleanup_pending)
        .await?;
    Ok(pending)
}

/// 为 SSH 或 WSL 目标构建一次服务器本地提交及其受限清理集合。
pub(crate) fn remote_commit_command(roots: &[RemoteRoot]) -> (String, Vec<String>) {
    let cleanup_paths = remote_commit_cleanup_paths(roots);
    let command = remote_transaction_command(roots, &cleanup_paths, REMOTE_RECONCILE_SCRIPT);
    (command, cleanup_paths)
}

fn remote_commit_cleanup_paths(roots: &[RemoteRoot]) -> Vec<String> {
    let mut paths = Vec::new();
    for root in roots {
        if root.mode != RootCommitMode::Create {
            paths.push(remote_backup_path(root));
        }
        if root.kind == TransferEntryKind::Directory
            && root.destination_kind == Some(TransferEntryKind::Directory)
        {
            paths.push(root.stage.clone());
        }
    }
    paths
}

/// 生成可单元测试的 SSH 原位目录提交与反向回滚脚本。
fn remote_transaction_command(
    roots: &[RemoteRoot],
    cleanup_paths: &[String],
    script: &str,
) -> String {
    // 嵌入脚本可能由 Windows 编辑器写入 CRLF，必须在追加路径参数前统一换行。
    let mut command = script.replace("\r\n", "\n");
    for root in roots {
        command.push_str(&remote_precondition(root));
        if root.mode != RootCommitMode::Create {
            let backup = shell_quote(&remote_backup_path(root));
            command.push_str(&format!(
                "if [ -e {backup} ] || [ -L {backup} ]; then echo 'transfer backup already exists; refusing to discard recovery data' >&2; exit 1; fi\n"
            ));
            command.push_str(&format!("terax_backup_roots+=({backup})\n"));
        }
    }
    command.push_str("trap terax_rollback EXIT\n");
    for root in roots {
        let stage = shell_quote(&root.stage);
        let final_path = shell_quote(&root.final_path);
        let backup = shell_quote(&remote_backup_path(root));
        if root.kind == TransferEntryKind::Directory
            && root.destination_kind == Some(TransferEntryKind::Directory)
        {
            let mode = match root.mode {
                RootCommitMode::Replace => "replace",
                RootCommitMode::Merge => "merge",
                RootCommitMode::MergeSkip => "merge_skip",
                RootCommitMode::MergeNewer => "merge_newer",
                RootCommitMode::Create => unreachable!("existing directory cannot use create mode"),
            };
            command.push_str(&format!(
                "terax_reconcile {mode} {stage} {final_path} {backup}\n"
            ));
            continue;
        }
        if root.mode != RootCommitMode::Create {
            command.push_str(&format!("terax_record_move {final_path} {backup}\n"));
        }
        command.push_str(&format!("terax_record_move {stage} {final_path}\n"));
    }
    command.push_str("terax_apply_directory_metadata\ntrap - EXIT\n");
    if !cleanup_paths.is_empty() {
        command.push_str("set +e\n");
        command.push_str(&super::ssh::cleanup::cleanup_command(
            cleanup_paths.iter().map(String::as_str),
        ));
        command.push_str(&format!(
            "\nterax_commit_cleanup_status=$?\nset -e\nif [ \"$terax_commit_cleanup_status\" != 0 ]; then printf '%s\\n' {}; fi\n",
            shell_quote(REMOTE_COMMIT_CLEANUP_PENDING_MARKER)
        ));
    }
    command
}

const REMOTE_RECONCILE_SCRIPT: &str = include_str!("ssh/reconcile.sh");

async fn execute_remote_commit(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    operation: &str,
) -> RunResult<bool> {
    // 脚本走标准输入，避免多根长路径触发远端 exec 的命令行长度上限。
    let output = workspace
        .exec_with_input(
            "bash -s",
            command.as_bytes().to_vec(),
            Duration::from_secs(24 * 60 * 60),
            REMOTE_COMMIT_OUTPUT_LIMIT,
        )
        .await
        .map_err(|error| match error {
            terax_core::modules::remote::transfer::SshTransferError::OperationFailed(detail) => {
                message(format!("{operation}: {detail}"))
            }
            admission => TransferRunError::from(admission),
        })?;
    if output.exit_code == Some(0) && !output.timed_out && !output.truncated {
        Ok(output
            .stdout
            .windows(REMOTE_COMMIT_CLEANUP_PENDING_MARKER.len())
            .any(|value| value == REMOTE_COMMIT_CLEANUP_PENDING_MARKER.as_bytes()))
    } else {
        Err(message(format!(
            "{operation} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn remote_backup_path(root: &RemoteRoot) -> String {
    format!("{}.backup", root.stage)
}

/// 生成目标端提交前置条件，目标类型变化时拒绝沿用旧冲突授权。
fn remote_precondition(root: &RemoteRoot) -> String {
    let path = shell_quote(&root.final_path);
    let condition = match root.destination_kind {
        None => format!("[ ! -e {path} ] && [ ! -L {path} ]"),
        Some(TransferEntryKind::File) => format!("[ -f {path} ] && [ ! -L {path} ]"),
        Some(TransferEntryKind::Directory) => {
            format!("[ -d {path} ] && [ ! -L {path} ]")
        }
        Some(TransferEntryKind::Other) => {
            format!("[ -L {path} ] || {{ [ -e {path} ] && [ ! -f {path} ] && [ ! -d {path} ]; }}")
        }
    };
    format!(
        "if ! {{ {condition}; }}; then echo 'transfer destination changed after conflict approval' >&2; exit 1; fi\n"
    )
}

fn commit_local_roots_blocking(roots: &[LocalRoot]) -> std::io::Result<Vec<PathBuf>> {
    for root in roots {
        ensure_local_commit_precondition(&root.final_path, root.destination_kind)?;
        let backup = local_backup_path(root);
        if root.mode != RootCommitMode::Create && local_entry_kind_blocking(&backup)?.is_some() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!(
                    "transfer backup already exists; refusing to discard recovery data: {}",
                    backup.display()
                ),
            ));
        }
    }

    if let [root] = roots {
        if can_atomically_replace_single_file(root) {
            replace_file(&root.stage, &root.final_path)?;
            return Ok(Vec::new());
        }
    }

    let mut transaction = LocalCommitTransaction::default();
    let committed = roots
        .iter()
        .try_for_each(|root| apply_local_root(root, &mut transaction))
        .and_then(|()| transaction.apply_directory_metadata());
    if let Err(error) = committed {
        let rollback = transaction.rollback();
        if rollback.is_ok() {
            let _ = clean_local_commit_paths(transaction.backup_paths);
        }
        return Err(transaction_error(error, rollback));
    }

    Ok(clean_local_commit_paths(transaction.cleanup_paths))
}

#[derive(Default)]
struct LocalCommitTransaction {
    undo: Vec<LocalUndo>,
    directories: Vec<LocalDirectoryMetadata>,
    backup_paths: Vec<PathBuf>,
    cleanup_paths: Vec<PathBuf>,
}

struct LocalUndo {
    source: PathBuf,
    target: PathBuf,
}

struct LocalDirectoryMetadata {
    target: PathBuf,
    original: std::fs::Metadata,
    final_metadata: std::fs::Metadata,
}

struct LocalDirectoryWork {
    stage: PathBuf,
    target: PathBuf,
    backup: PathBuf,
    mode: RootCommitMode,
}

impl LocalCommitTransaction {
    fn apply_directory_metadata(&self) -> std::io::Result<()> {
        for directory in self.directories.iter().rev() {
            apply_local_metadata(&directory.target, &directory.final_metadata)?;
        }
        Ok(())
    }

    fn rollback(&self) -> std::io::Result<()> {
        let mut failure = None;
        for directory in &self.directories {
            if let Err(error) = make_existing_directory_writable(&directory.target) {
                failure.get_or_insert(error);
            }
        }
        for action in self.undo.iter().rev() {
            if let Err(error) = rename_no_replace(&action.target, &action.source) {
                failure.get_or_insert(error);
            }
        }
        for directory in self.directories.iter().rev() {
            if let Err(error) = apply_local_metadata(&directory.target, &directory.original) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

fn apply_local_root(
    root: &LocalRoot,
    transaction: &mut LocalCommitTransaction,
) -> std::io::Result<()> {
    let preserves_directory = root.kind == TransferEntryKind::Directory
        && root.destination_kind == Some(TransferEntryKind::Directory);
    if preserves_directory {
        let backup = local_backup_path(root);
        transaction.backup_paths.push(backup.clone());
        transaction.cleanup_paths.push(backup.clone());
        reconcile_local_directory(
            LocalDirectoryWork {
                stage: root.stage.clone(),
                target: root.final_path.clone(),
                backup: backup.clone(),
                mode: root.mode,
            },
            transaction,
        )?;
        transaction.cleanup_paths.push(root.stage.clone());
        return Ok(());
    }

    if root.mode != RootCommitMode::Create {
        let backup = local_backup_path(root);
        move_local_entry(&root.final_path, &backup, transaction)?;
        transaction.backup_paths.push(backup.clone());
        transaction.cleanup_paths.push(backup);
    }
    move_local_entry(&root.stage, &root.final_path, transaction)?;
    Ok(())
}

/// 在原位协调两个目录，只移动新增、被替换或应删除的条目。
fn reconcile_local_directory(
    root: LocalDirectoryWork,
    transaction: &mut LocalCommitTransaction,
) -> std::io::Result<()> {
    let mut pending = vec![root];
    while let Some(work) = pending.pop() {
        let stage_metadata = verified_local_directory(&work.stage)?;
        let target_metadata = verified_local_directory(&work.target)?;
        std::fs::create_dir(&work.backup)?;
        make_local_directory_writable(&work.stage, &stage_metadata.permissions())?;
        make_local_directory_writable(&work.target, &target_metadata.permissions())?;
        transaction.directories.push(LocalDirectoryMetadata {
            target: work.target.clone(),
            original: target_metadata.clone(),
            final_metadata: if matches!(
                work.mode,
                RootCommitMode::MergeSkip | RootCommitMode::MergeNewer
            ) {
                target_metadata
            } else {
                stage_metadata
            },
        });

        if work.mode == RootCommitMode::Replace {
            for (name, target) in local_directory_entries(&work.target)? {
                let stage = work.stage.join(&name);
                if local_entry_kind_blocking(&stage)?.is_none() {
                    move_local_entry(&target, &work.backup.join(name), transaction)?;
                }
            }
        }

        let mut child_directories = Vec::new();
        for (name, stage) in local_directory_entries(&work.stage)? {
            let stage_metadata = std::fs::symlink_metadata(&stage)?;
            if stage_metadata.file_type().is_symlink()
                || (!stage_metadata.is_file() && !stage_metadata.is_dir())
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "transfer staging contains an unsupported entry: {}",
                        stage.display()
                    ),
                ));
            }
            let target = work.target.join(&name);
            let backup = work.backup.join(name);
            let target_metadata = match std::fs::symlink_metadata(&target) {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            };
            if stage_metadata.is_dir()
                && target_metadata
                    .as_ref()
                    .is_some_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            {
                child_directories.push(LocalDirectoryWork {
                    stage,
                    target,
                    backup,
                    mode: work.mode,
                });
                continue;
            }
            if work.mode == RootCommitMode::MergeNewer {
                if let Some(metadata) = &target_metadata {
                    if metadata.file_type().is_symlink()
                        || !metadata.is_file()
                        || !stage_metadata.is_file()
                    {
                        return Err(std::io::Error::other("sync target changed type"));
                    }
                    let source_time = stage_metadata
                        .modified()?
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(std::io::Error::other)?
                        .as_secs();
                    let target_time = metadata
                        .modified()?
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(std::io::Error::other)?
                        .as_secs();
                    if source_time <= target_time {
                        continue;
                    }
                }
            }
            if target_metadata.is_some() && work.mode == RootCommitMode::MergeSkip {
                continue;
            }
            if target_metadata.is_some() {
                move_local_entry(&target, &backup, transaction)?;
            }
            move_local_entry(&stage, &target, transaction)?;
        }
        pending.extend(child_directories.into_iter().rev());
    }
    Ok(())
}

fn move_local_entry(
    source: &Path,
    target: &Path,
    transaction: &mut LocalCommitTransaction,
) -> std::io::Result<()> {
    rename_no_replace(source, target)?;
    transaction.undo.push(LocalUndo {
        source: source.to_path_buf(),
        target: target.to_path_buf(),
    });
    Ok(())
}

fn verified_local_directory(path: &Path) -> std::io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        Ok(metadata)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("transfer directory changed type: {}", path.display()),
        ))
    }
}

fn local_directory_entries(path: &Path) -> std::io::Result<Vec<(std::ffi::OsString, PathBuf)>> {
    std::fs::read_dir(path)?
        .map(|entry| {
            let entry = entry?;
            Ok((entry.file_name(), entry.path()))
        })
        .collect()
}

fn make_existing_directory_writable(path: &Path) -> std::io::Result<()> {
    let metadata = verified_local_directory(path)?;
    make_local_directory_writable(path, &metadata.permissions())
}

fn clean_local_commit_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter(|path| {
            if let Err(error) = remove_local_path_blocking(path) {
                log::warn!(
                    "failed to clean committed transfer path {}: {error}",
                    path.display()
                );
                true
            } else {
                false
            }
        })
        .collect()
}

fn transaction_error(error: std::io::Error, rollback: std::io::Result<()>) -> std::io::Error {
    match rollback {
        Ok(()) => error,
        Err(rollback) => std::io::Error::other(format!(
            "archive commit failed: {error}; rollback failed: {rollback}"
        )),
    }
}

fn local_backup_path(root: &LocalRoot) -> PathBuf {
    root.stage.with_file_name(format!(
        "{}.backup",
        root.stage
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(".terax-transfer")
    ))
}

/// 确认 Direct 合并中的每个可达来源子项仍保持冲突检查时的目标类型。
///
/// 缺失项也必须记录，否则传输期间新出现的同名目标会在没有用户授权时被覆盖。
/// WSL 的本地路径实际是网络文件系统，因此复验也使用有界并发，避免逐项串行等待。
async fn ensure_local_merge_preconditions(root: &LocalRoot) -> RunResult<()> {
    if root.mode != RootCommitMode::Merge {
        return Ok(());
    }
    let mut pending = stream::iter(root.merge_preconditions.iter().cloned())
        .map(|precondition| async move {
            let actual = local_entry_kind(&precondition.path).await?;
            Ok::<_, TransferRunError>((precondition, actual))
        })
        .buffer_unordered(MAX_REMOTE_PRECONDITION_PROBES);
    while let Some(result) = pending.next().await {
        let (precondition, actual) = result?;
        if actual != precondition.expected_kind {
            return Err(message(format!(
                "transfer merge destination changed after conflict approval: {}",
                precondition.path.display()
            )));
        }
    }
    Ok(())
}

async fn local_entry_kind(path: &Path) -> RunResult<Option<TransferEntryKind>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(Some(TransferEntryKind::File)),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            Ok(Some(TransferEntryKind::Directory))
        }
        Ok(_) => Ok(Some(TransferEntryKind::Other)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(message(format!(
            "stat transfer merge destination {}: {error}",
            path.display()
        ))),
    }
}

/// 在 SSH Direct 合并提交前重新检查逐项冲突授权，拒绝新出现或改变类型的目标。
async fn ensure_remote_merge_preconditions(
    session: &Arc<SftpSession>,
    root: &RemoteRoot,
) -> RunResult<()> {
    if root.mode != RootCommitMode::Merge {
        return Ok(());
    }
    let kinds = super::ssh::io::entry_kinds(
        session,
        root.merge_preconditions
            .iter()
            .map(|precondition| precondition.path.clone()),
    )
    .await?;
    for precondition in &root.merge_preconditions {
        let actual = kinds.get(&precondition.path).copied().flatten();
        if actual != precondition.expected_kind {
            return Err(message(format!(
                "remote merge destination changed after conflict approval: {}",
                precondition.path
            )));
        }
    }
    Ok(())
}

/// 在本地破坏性提交边界重新核对用户授权时看到的目标类型。
fn ensure_local_commit_precondition(
    final_path: &Path,
    expected: Option<TransferEntryKind>,
) -> std::io::Result<()> {
    let actual = local_entry_kind_blocking(final_path)?;
    if actual == expected {
        return Ok(());
    }
    Err(std::io::Error::new(
        if expected.is_none() {
            std::io::ErrorKind::AlreadyExists
        } else {
            std::io::ErrorKind::Other
        },
        format!(
            "transfer destination changed after conflict approval: {}",
            final_path.display()
        ),
    ))
}

/// 使用不跟随符号链接的元数据识别本地目标类型。
fn local_entry_kind_blocking(path: &Path) -> std::io::Result<Option<TransferEntryKind>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(TransferEntryKind::File)),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            Ok(Some(TransferEntryKind::Directory))
        }
        Ok(_) => Ok(Some(TransferEntryKind::Other)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

/// 删除经过任务所有权校验的本地临时树。
///
/// 遍历使用显式目录列表，避免超深目录耗尽线程栈；只修复任务私有
/// 目录和普通文件的所需权限，符号链接始终作为链接本身删除。
fn remove_local_path_blocking(path: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return remove_local_symlink(path, &metadata.file_type());
    }
    if !metadata.is_dir() {
        return remove_local_non_directory(path);
    }

    let cleanup_device = local_cleanup_device(path, &metadata)?;
    make_local_directory_writable(path, &metadata.permissions())?;
    let mut directories = vec![path.to_path_buf()];
    let mut index = 0;
    while index < directories.len() {
        let directory = directories[index].clone();
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let child = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                remove_local_symlink(&child, &file_type)?;
            } else if file_type.is_dir() {
                // chmod 前重新读取不跟随链接的元数据，避免使用过期的 DirEntry 类型。
                let metadata = match std::fs::symlink_metadata(&child) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                if metadata.file_type().is_symlink() {
                    remove_local_symlink(&child, &metadata.file_type())?;
                } else if metadata.is_dir() {
                    if !local_cleanup_device_matches(&cleanup_device, &metadata) {
                        continue;
                    }
                    make_local_directory_writable(&child, &metadata.permissions())?;
                    directories.push(child);
                } else {
                    remove_local_non_directory(&child)?;
                }
            } else {
                remove_local_non_directory(&child)?;
            }
        }
        index += 1;
    }
    for directory in directories.into_iter().rev() {
        match std::fs::remove_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
struct LocalCleanupDevice(u64);

#[cfg(not(unix))]
struct LocalCleanupDevice;

#[cfg(unix)]
/// 记录清理根所在设备，并拒绝把挂载点本身当成任务私有目录删除。
fn local_cleanup_device(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> std::io::Result<LocalCleanupDevice> {
    use std::os::unix::fs::MetadataExt;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "transfer cleanup root has no parent",
        )
    })?;
    let device = metadata.dev();
    if std::fs::symlink_metadata(parent)?.dev() != device {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refused to clean a transfer path mounted on another filesystem",
        ));
    }
    Ok(LocalCleanupDevice(device))
}

#[cfg(not(unix))]
/// 非 Unix 平台没有可移植的设备号，仍依赖不跟随符号链接的遍历边界。
fn local_cleanup_device(
    _path: &Path,
    _metadata: &std::fs::Metadata,
) -> std::io::Result<LocalCleanupDevice> {
    Ok(LocalCleanupDevice)
}

#[cfg(unix)]
/// 判断子目录是否仍位于清理根的同一文件系统。
fn local_cleanup_device_matches(device: &LocalCleanupDevice, metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.dev() == device.0
}

#[cfg(not(unix))]
/// 非 Unix 平台不执行设备号比较。
fn local_cleanup_device_matches(
    _device: &LocalCleanupDevice,
    _metadata: &std::fs::Metadata,
) -> bool {
    true
}

#[cfg(not(windows))]
fn remove_local_symlink(path: &Path, _file_type: &std::fs::FileType) -> std::io::Result<()> {
    remove_local_file(path)
}

#[cfg(windows)]
fn remove_local_symlink(path: &Path, file_type: &std::fs::FileType) -> std::io::Result<()> {
    use std::os::windows::fs::FileTypeExt;

    let result = if file_type.is_symlink_dir() {
        std::fs::remove_dir(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn remove_local_file(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
fn remove_local_non_directory(path: &Path) -> std::io::Result<()> {
    match remove_local_file(path) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return remove_local_symlink(path, &metadata.file_type());
    }
    if metadata.is_dir() {
        return Err(std::io::Error::other(
            "transfer cleanup entry changed to a directory",
        ));
    }
    let mut permissions = metadata.permissions();
    if !permissions.readonly() {
        return remove_local_file(path);
    }
    permissions.set_readonly(false);
    std::fs::set_permissions(path, permissions)?;
    remove_local_file(path)
}

#[cfg(not(windows))]
fn remove_local_non_directory(path: &Path) -> std::io::Result<()> {
    remove_local_file(path)
}

#[cfg(unix)]
fn make_local_directory_writable(
    path: &Path,
    original: &std::fs::Permissions,
) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = original.mode();
    if mode & 0o700 == 0o700 {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o700))?;
    Ok(())
}

#[cfg(not(unix))]
#[allow(clippy::permissions_set_readonly_false)]
fn make_local_directory_writable(
    path: &Path,
    original: &std::fs::Permissions,
) -> std::io::Result<()> {
    if !original.readonly() {
        return Ok(());
    }
    let mut writable = original.clone();
    // Windows 只暴露 readonly 属性，不存在 Unix mode；清除此属性不会扩大 ACL 权限。
    writable.set_readonly(false);
    std::fs::set_permissions(path, writable)?;
    Ok(())
}

/// 将已捕获的目录时间和权限应用到保持身份的目标。
fn apply_local_metadata(destination: &Path, metadata: &std::fs::Metadata) -> std::io::Result<()> {
    if let (Ok(accessed), Ok(modified)) = (metadata.accessed(), metadata.modified()) {
        filetime::set_file_times(
            destination,
            filetime::FileTime::from_system_time(accessed),
            filetime::FileTime::from_system_time(modified),
        )?;
    }
    std::fs::set_permissions(destination, metadata.permissions())
}

/// 失败或取消后只清理任务私有 staging，不删除已经提交的最终目标。
pub(crate) async fn cleanup_local_staging(
    staging_task_id: &str,
    owner_task_id: &str,
    roots: &[LocalRoot],
) {
    let mut paths = Vec::new();
    let mut invalid_ownership = false;
    for root in roots {
        if local_staging_is_owned(&root.stage, staging_task_id) {
            paths.push(root.stage.clone());
        } else {
            invalid_ownership = true;
            log::warn!(
                "refused to clean invalid local transfer temporary path {} for task {staging_task_id}",
                root.stage.display()
            );
        }
    }
    if invalid_ownership {
        // 无法确认所有权时保持清理未完成，历史记录不得掩盖残留临时数据。
        super::manager::begin_deferred_cleanup(owner_task_id);
    }
    let remaining = remove_local_paths(paths).await;
    if remaining.is_empty() {
        return;
    }
    schedule_local_cleanup(owner_task_id, remaining);
}

/// 校验本地 staging 的固定名称确实绑定当前任务。
fn local_staging_is_owned(path: &Path, task_id: &str) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let prefix = format!(".terax-part-{task_id}-");
    name.strip_prefix(&prefix)
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

/// 仅删除票据中与 staging task ID 严格匹配的本地 backup。
pub(crate) async fn remove_persisted_local_backups(
    staging_task_id: &str,
    paths: &[String],
) -> Option<Vec<PathBuf>> {
    let paths: Vec<_> = paths.iter().map(PathBuf::from).collect();
    if paths
        .iter()
        .any(|path| !local_backup_is_owned(path, staging_task_id))
    {
        log::warn!("refused invalid persisted local transfer cleanup ticket");
        return None;
    }
    Some(remove_local_paths(paths).await)
}

fn local_backup_is_owned(path: &Path, task_id: &str) -> bool {
    if uuid::Uuid::parse_str(task_id).is_err()
        || !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let prefix = format!(".terax-part-{task_id}-");
    name.strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix(".backup"))
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

/// 删除一组已经验证的本地任务临时路径并返回仍需重试的项。
pub(crate) async fn remove_local_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    if paths.is_empty() {
        return Vec::new();
    }
    let retry = paths.clone();
    match tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|path| {
                if let Err(error) = remove_local_path_blocking(path) {
                    log::warn!("failed to clean transfer path {}: {error}", path.display());
                    true
                } else {
                    false
                }
            })
            .collect()
    })
    .await
    {
        Ok(remaining) => remaining,
        Err(error) => {
            log::warn!("failed to join local transfer cleanup: {error}");
            retry
        }
    }
}

/// 后台重试已验证所有权的本地临时路径，并在清理后解除历史删除限制。
pub(crate) fn schedule_local_cleanup(task_id: &str, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    super::manager::begin_deferred_cleanup(task_id);
    let task_id = task_id.to_string();
    terax_core::runtime::spawn(async move {
        let cleanup = async {
            let mut remaining = paths;
            loop {
                remaining = remove_local_paths(remaining).await;
                if remaining.is_empty() {
                    return;
                }
                tokio::time::sleep(LOCAL_CLEANUP_RETRY_INTERVAL).await;
            }
        };
        if tokio::time::timeout(LOCAL_CLEANUP_RETRY_WINDOW, cleanup)
            .await
            .is_ok()
        {
            super::manager::finish_deferred_cleanup(&task_id);
        } else {
            log::warn!("local transfer cleanup expired for task {task_id}");
        }
    });
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_vendor = "apple")]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_vendor = "apple"))
))]
fn rename_no_replace(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace rename is not supported on this platform",
    ))
}

type RunResult<T> = Result<T, TransferRunError>;

fn message(value: String) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IoFailed, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sync_commit_rechecks_times_preserves_target_only_and_directory_identity() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let target = directory.path().join("target");
        std::fs::create_dir(&stage).unwrap();
        std::fs::create_dir(&target).unwrap();
        for (name, source_time, target_time) in [
            ("newer", 20, 10),
            ("equal", 20, 20),
            ("target-edited", 20, 30),
        ] {
            std::fs::write(stage.join(name), b"source").unwrap();
            std::fs::write(target.join(name), b"target").unwrap();
            filetime::set_file_mtime(
                stage.join(name),
                filetime::FileTime::from_unix_time(source_time, 0),
            )
            .unwrap();
            filetime::set_file_mtime(
                target.join(name),
                filetime::FileTime::from_unix_time(target_time, 0),
            )
            .unwrap();
        }
        std::fs::write(stage.join("new"), b"new").unwrap();
        std::fs::write(target.join("old-name"), b"keep").unwrap();
        let identity = local_identity(&target).await;
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path: target.clone(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::MergeNewer,
            merge_preconditions: Vec::new(),
        };
        commit_local_root(&root).await.unwrap();
        assert_eq!(local_identity(&target).await, identity);
        for (name, expected) in [
            ("newer", "source"),
            ("equal", "target"),
            ("target-edited", "target"),
            ("new", "new"),
            ("old-name", "keep"),
        ] {
            assert_eq!(
                std::fs::read_to_string(target.join(name)).unwrap(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn sync_commit_rolls_back_if_target_changes_type() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let target = directory.path().join("target");
        std::fs::create_dir(&stage).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(stage.join("conflict"), b"source").unwrap();
        std::fs::create_dir(target.join("conflict")).unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path: target.clone(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::MergeNewer,
            merge_preconditions: Vec::new(),
        };
        assert!(commit_local_root(&root).await.is_err());
        assert!(target.join("conflict").is_dir());
    }

    async fn local_identity(path: &Path) -> super::super::source::LocalSourceIdentity {
        let metadata = tokio::fs::symlink_metadata(path).await.unwrap();
        super::super::source::LocalSourceIdentity::capture(path, &metadata)
            .await
            .unwrap()
    }

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
    fn remote_transaction_command_keeps_preconditions_and_reverse_rollback() {
        let roots = vec![
            RemoteRoot {
                source_path: "/source/new".into(),
                stage: "/target/.terax-part-task-0".into(),
                final_path: "/target/new".into(),
                kind: TransferEntryKind::Directory,
                destination_kind: None,
                mode: RootCommitMode::Create,
                merge_preconditions: Vec::new(),
            },
            RemoteRoot {
                source_path: "/source/existing".into(),
                stage: "/target/.terax-part-task-1".into(),
                final_path: "/target/existing".into(),
                kind: TransferEntryKind::Directory,
                destination_kind: Some(TransferEntryKind::Directory),
                mode: RootCommitMode::Merge,
                merge_preconditions: Vec::new(),
            },
            RemoteRoot {
                source_path: "/source/preserve".into(),
                stage: "/target/.terax-part-task-2".into(),
                final_path: "/target/preserve".into(),
                kind: TransferEntryKind::Directory,
                destination_kind: Some(TransferEntryKind::Directory),
                mode: RootCommitMode::MergeSkip,
                merge_preconditions: Vec::new(),
            },
        ];

        let cleanup_paths = remote_commit_cleanup_paths(&roots);
        let command = remote_transaction_command(&roots, &cleanup_paths, REMOTE_RECONCILE_SCRIPT);

        assert!(command.contains("transfer destination changed after conflict approval"));
        assert!(command
            .contains("terax_reconcile merge '/target/.terax-part-task-1' '/target/existing'"));
        assert!(command.contains(
            "terax_reconcile merge_skip '/target/.terax-part-task-2' '/target/preserve'"
        ));
        assert!(command.contains("mv -T -n -- \"$source\" \"$target\""));
        assert!(command.contains("terax_apply_directory_metadata"));
        assert!(command.contains("set -- '/target/.terax-part-task-1.backup'"));
        assert!(command.contains("'/target/.terax-part-task-2.backup'"));
        assert!(command.contains("'/target/.terax-part-task-1'"));
        assert!(command.contains("'/target/.terax-part-task-2'"));
        assert!(command.contains(REMOTE_COMMIT_CLEANUP_PENDING_MARKER));
        assert!(command.ends_with("fi\n"));
        assert!(!command.contains("rm -rf -- '/target/.terax-part-task-1.backup'"));
        assert!(!command.contains("rm -rf -- '/target/.terax-part-task-2.backup'"));

        let lf = REMOTE_RECONCILE_SCRIPT.replace("\r\n", "\n");
        let expected = remote_transaction_command(&roots, &cleanup_paths, &lf);
        assert_eq!(remote_commit_command(&roots).0, expected);
        for script in [
            lf.clone(),
            lf.replace('\n', "\r\n"),
            lf.replacen('\n', "\r\n", 4),
        ] {
            let command = remote_transaction_command(&roots, &cleanup_paths, &script);
            assert_eq!(command, expected);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn remote_file_batches_preserve_directories_and_rollback_partial_moves() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("reconcile.sh");
        std::fs::write(&script, remote_commit_command(&[]).0).unwrap();
        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(include_str!("ssh/reconcile.test.sh"))
            .arg("terax-reconcile-test")
            .arg(&script)
            .arg(directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn remote_target_first_transaction_preserves_both_sides_with_target_precedence() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        std::fs::create_dir(&stage).unwrap();
        std::fs::create_dir(&final_path).unwrap();
        std::fs::write(stage.join("same.txt"), b"source").unwrap();
        std::fs::write(stage.join("source-only.txt"), b"source-only").unwrap();
        std::fs::write(final_path.join("same.txt"), b"target").unwrap();
        std::fs::write(final_path.join("target-only.txt"), b"target-only").unwrap();
        let before = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&final_path).unwrap());
        let root = RemoteRoot {
            source_path: "/source".into(),
            stage: stage.to_string_lossy().into_owned(),
            final_path: final_path.to_string_lossy().into_owned(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::MergeSkip,
            merge_preconditions: Vec::new(),
        };

        let cleanup_paths = remote_commit_cleanup_paths(std::slice::from_ref(&root));
        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(remote_transaction_command(
                &[root],
                &cleanup_paths,
                REMOTE_RECONCILE_SCRIPT,
            ))
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read(final_path.join("same.txt")).unwrap(),
            b"target"
        );
        let after = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&final_path).unwrap());
        assert_eq!(after, before);
        assert_eq!(
            std::fs::read(final_path.join("source-only.txt")).unwrap(),
            b"source-only"
        );
        assert_eq!(
            std::fs::read(final_path.join("target-only.txt")).unwrap(),
            b"target-only"
        );
        assert!(!stage.with_extension("backup").exists());
        assert!(!output
            .stdout
            .windows(REMOTE_COMMIT_CLEANUP_PENDING_MARKER.len())
            .any(|value| value == REMOTE_COMMIT_CLEANUP_PENDING_MARKER.as_bytes()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn remote_replace_preserves_surviving_directory_inodes() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        std::fs::create_dir_all(stage.join("shared")).unwrap();
        std::fs::create_dir_all(final_path.join("shared")).unwrap();
        std::fs::write(stage.join("shared/new.txt"), b"new").unwrap();
        std::fs::create_dir(final_path.join("removed")).unwrap();
        let root_inode = std::fs::metadata(&final_path).unwrap().ino();
        let shared_inode = std::fs::metadata(final_path.join("shared")).unwrap().ino();
        let root = RemoteRoot {
            source_path: "/source".into(),
            stage: stage.to_string_lossy().into_owned(),
            final_path: final_path.to_string_lossy().into_owned(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::Replace,
            merge_preconditions: Vec::new(),
        };
        let cleanup_paths = remote_commit_cleanup_paths(std::slice::from_ref(&root));

        let output = std::process::Command::new("bash")
            .arg("-c")
            .arg(remote_transaction_command(
                &[root],
                &cleanup_paths,
                REMOTE_RECONCILE_SCRIPT,
            ))
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::metadata(&final_path).unwrap().ino(), root_inode);
        assert_eq!(
            std::fs::metadata(final_path.join("shared")).unwrap().ino(),
            shared_inode
        );
        assert_eq!(
            std::fs::read(final_path.join("shared/new.txt")).unwrap(),
            b"new"
        );
        assert!(!final_path.join("removed").exists());
    }

    #[tokio::test]
    async fn local_commit_never_replaces_an_existing_target() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::write(&stage, b"new").await.unwrap();
        tokio::fs::write(&final_path, b"original").await.unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::File,
            destination_kind: None,
            mode: RootCommitMode::Create,
            merge_preconditions: Vec::new(),
        };

        assert!(commit_local_root(&root).await.is_err());
        assert_eq!(
            tokio::fs::read(&root.final_path).await.unwrap(),
            b"original"
        );
        assert_eq!(tokio::fs::read(&root.stage).await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn cleanup_only_removes_task_staging() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join(".terax-part-task-0");
        let final_path = directory.path().join("final");
        tokio::fs::write(&stage, b"partial").await.unwrap();
        tokio::fs::write(&final_path, b"committed").await.unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::File,
            destination_kind: None,
            mode: RootCommitMode::Create,
            merge_preconditions: Vec::new(),
        };

        cleanup_local_staging("task", "task", std::slice::from_ref(&root)).await;

        assert!(!root.stage.exists());
        assert_eq!(
            tokio::fs::read(&root.final_path).await.unwrap(),
            b"committed"
        );
    }

    #[tokio::test]
    async fn local_commit_cleans_a_readonly_backup_without_a_followup_pass() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join(".terax-part-task-0");
        let final_path = directory.path().join("final");
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::Replace,
            merge_preconditions: Vec::new(),
        };
        let backup = local_backup_path(&root);
        let readonly_directory = root.final_path.join("readonly");
        tokio::fs::create_dir_all(&readonly_directory)
            .await
            .unwrap();
        let readonly_file = readonly_directory.join("old.txt");
        tokio::fs::write(&readonly_file, b"old").await.unwrap();
        let mut file_permissions = std::fs::metadata(&readonly_file).unwrap().permissions();
        file_permissions.set_readonly(true);
        std::fs::set_permissions(&readonly_file, file_permissions).unwrap();
        let mut directory_permissions = std::fs::metadata(&readonly_directory)
            .unwrap()
            .permissions();
        directory_permissions.set_readonly(true);
        std::fs::set_permissions(&readonly_directory, directory_permissions).unwrap();
        tokio::fs::create_dir(&root.stage).await.unwrap();
        tokio::fs::write(root.stage.join("new.txt"), b"new")
            .await
            .unwrap();

        let pending_cleanup = commit_local_root(&root).await.unwrap();

        assert!(pending_cleanup.is_empty());
        assert!(!backup.exists());
        assert_eq!(
            tokio::fs::read(root.final_path.join("new.txt"))
                .await
                .unwrap(),
            b"new"
        );
    }

    #[test]
    fn local_cleanup_handles_deep_directory_trees_iteratively() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("deep");
        let mut child = root.clone();
        for _ in 0..80 {
            child.push("d");
        }
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("file"), b"data").unwrap();

        remove_local_path_blocking(&root).unwrap();

        assert!(!root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn local_cleanup_does_not_follow_symbolic_links() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("owned");
        let external = directory.path().join("external");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("keep"), b"data").unwrap();
        std::os::unix::fs::symlink(&external, root.join("link")).unwrap();

        remove_local_path_blocking(&root).unwrap();

        assert!(!root.exists());
        assert_eq!(std::fs::read(external.join("keep")).unwrap(), b"data");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn local_cleanup_refuses_a_mounted_root() {
        let metadata = std::fs::symlink_metadata("/proc").unwrap();

        assert!(local_cleanup_device(Path::new("/proc"), &metadata).is_err());
    }

    #[test]
    fn local_cleanup_ownership_requires_exact_task_and_numeric_index() {
        assert!(local_staging_is_owned(
            Path::new("/tmp/.terax-part-task-12"),
            "task"
        ));
        assert!(!local_staging_is_owned(
            Path::new("/tmp/.terax-part-other-12"),
            "task"
        ));
        assert!(!local_staging_is_owned(
            Path::new("/tmp/.terax-part-task-backup"),
            "task"
        ));
        let directory = tempfile::tempdir().unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        assert!(local_backup_is_owned(
            &directory
                .path()
                .join(format!(".terax-part-{task}-12.backup")),
            &task
        ));
        assert!(!local_backup_is_owned(
            &directory
                .path()
                .join(format!(".terax-part-{}-12.backup", uuid::Uuid::new_v4())),
            &task
        ));
        assert!(!local_backup_is_owned(
            &directory
                .path()
                .join(format!(".terax-part-{task}-12.backup/child")),
            &task
        ));
        assert!(!local_backup_is_owned(
            Path::new(&format!(".terax-part-{task}-12.backup")),
            &task
        ));
    }

    #[tokio::test]
    async fn persisted_cleanup_only_removes_the_exact_task_backup() {
        let directory = tempfile::tempdir().unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        let backup = directory
            .path()
            .join(format!(".terax-part-{task}-0.backup"));
        let unrelated = directory
            .path()
            .join(format!(".terax-part-{}-0.backup", uuid::Uuid::new_v4()));
        tokio::fs::write(&backup, b"disposable").await.unwrap();
        tokio::fs::write(&unrelated, b"keep").await.unwrap();

        let remaining =
            remove_persisted_local_backups(&task, &[backup.to_string_lossy().into_owned()])
                .await
                .unwrap();

        assert!(remaining.is_empty());
        assert!(!backup.exists());
        assert!(unrelated.exists());
        assert!(
            remove_persisted_local_backups(&task, &[unrelated.to_string_lossy().into_owned()])
                .await
                .is_none()
        );
        assert!(unrelated.exists());
    }

    #[tokio::test]
    async fn local_file_replace_publishes_staging_content() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::write(&stage, b"new").await.unwrap();
        tokio::fs::write(&final_path, b"old").await.unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::File,
            destination_kind: Some(TransferEntryKind::File),
            mode: RootCommitMode::Replace,
            merge_preconditions: Vec::new(),
        };

        assert!(commit_local_root(&root).await.unwrap().is_empty());

        assert_eq!(tokio::fs::read(&root.final_path).await.unwrap(), b"new");
        assert!(!root.stage.exists());
    }

    #[tokio::test]
    async fn local_commit_rejects_a_destination_type_change_after_approval() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::write(&stage, b"new").await.unwrap();
        tokio::fs::create_dir(&final_path).await.unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::File,
            destination_kind: Some(TransferEntryKind::File),
            mode: RootCommitMode::Replace,
            merge_preconditions: Vec::new(),
        };

        assert!(commit_local_root(&root).await.is_err());

        assert!(root.final_path.is_dir());
        assert_eq!(tokio::fs::read(&root.stage).await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn local_commit_never_discards_an_existing_recovery_backup() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        let backup = directory.path().join("stage.backup");
        tokio::fs::write(&stage, b"new").await.unwrap();
        tokio::fs::write(&final_path, b"current").await.unwrap();
        tokio::fs::write(&backup, b"recoverable").await.unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::File,
            destination_kind: Some(TransferEntryKind::File),
            mode: RootCommitMode::Replace,
            merge_preconditions: Vec::new(),
        };

        assert!(commit_local_root(&root).await.is_err());

        assert_eq!(tokio::fs::read(&root.stage).await.unwrap(), b"new");
        assert_eq!(tokio::fs::read(&root.final_path).await.unwrap(), b"current");
        assert_eq!(tokio::fs::read(backup).await.unwrap(), b"recoverable");
    }

    #[tokio::test]
    async fn local_directory_merge_preserves_target_only_entries() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::create_dir(&stage).await.unwrap();
        tokio::fs::create_dir(&final_path).await.unwrap();
        tokio::fs::write(stage.join("same.txt"), b"new")
            .await
            .unwrap();
        tokio::fs::write(final_path.join("same.txt"), b"old")
            .await
            .unwrap();
        tokio::fs::write(final_path.join("target-only.txt"), b"keep")
            .await
            .unwrap();
        let stage_shared = stage.join("shared");
        let target_shared = final_path.join("shared");
        tokio::fs::create_dir(&stage_shared).await.unwrap();
        tokio::fs::create_dir(&target_shared).await.unwrap();
        tokio::fs::write(stage_shared.join("source.txt"), b"source")
            .await
            .unwrap();
        let target_only_dir = final_path.join("target-only-dir");
        tokio::fs::create_dir(&target_only_dir).await.unwrap();
        tokio::fs::write(target_only_dir.join("nested.txt"), b"nested")
            .await
            .unwrap();
        let mut target_only_permissions =
            std::fs::metadata(&target_only_dir).unwrap().permissions();
        target_only_permissions.set_readonly(true);
        std::fs::set_permissions(&target_only_dir, target_only_permissions).unwrap();
        let mut stage_permissions = std::fs::metadata(&stage).unwrap().permissions();
        stage_permissions.set_readonly(true);
        std::fs::set_permissions(&stage, stage_permissions).unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::Merge,
            merge_preconditions: Vec::new(),
        };
        let root_identity = local_identity(&root.final_path).await;
        let shared_identity = local_identity(&target_shared).await;
        let target_only_identity = local_identity(&target_only_dir).await;

        assert!(commit_local_root(&root).await.unwrap().is_empty());

        assert_eq!(local_identity(&root.final_path).await, root_identity);
        assert_eq!(local_identity(&target_shared).await, shared_identity);
        assert_eq!(local_identity(&target_only_dir).await, target_only_identity);

        assert_eq!(
            tokio::fs::read(root.final_path.join("same.txt"))
                .await
                .unwrap(),
            b"new"
        );
        assert_eq!(
            tokio::fs::read(root.final_path.join("target-only.txt"))
                .await
                .unwrap(),
            b"keep"
        );
        assert_eq!(
            tokio::fs::read(root.final_path.join("target-only-dir/nested.txt"))
                .await
                .unwrap(),
            b"nested"
        );
        assert!(std::fs::metadata(root.final_path.join("target-only-dir"))
            .unwrap()
            .permissions()
            .readonly());
        assert!(std::fs::metadata(&root.final_path)
            .unwrap()
            .permissions()
            .readonly());
    }

    #[tokio::test]
    async fn local_directory_target_first_merge_preserves_conflicts_and_source_only_entries() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::create_dir(&stage).await.unwrap();
        tokio::fs::create_dir(&final_path).await.unwrap();
        tokio::fs::write(stage.join("same.txt"), b"source")
            .await
            .unwrap();
        tokio::fs::write(stage.join("source-only.txt"), b"source-only")
            .await
            .unwrap();
        tokio::fs::create_dir(stage.join("type-conflict"))
            .await
            .unwrap();
        tokio::fs::write(stage.join("type-conflict/nested.txt"), b"source")
            .await
            .unwrap();
        tokio::fs::write(final_path.join("same.txt"), b"target")
            .await
            .unwrap();
        tokio::fs::write(final_path.join("target-only.txt"), b"target-only")
            .await
            .unwrap();
        tokio::fs::write(final_path.join("type-conflict"), b"target-file")
            .await
            .unwrap();
        let stage_shared = stage.join("shared");
        let target_shared = final_path.join("shared");
        tokio::fs::create_dir(&stage_shared).await.unwrap();
        tokio::fs::create_dir(&target_shared).await.unwrap();
        tokio::fs::write(stage_shared.join("source.txt"), b"source")
            .await
            .unwrap();
        tokio::fs::write(target_shared.join("target.txt"), b"target")
            .await
            .unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::MergeSkip,
            merge_preconditions: Vec::new(),
        };
        let root_identity = local_identity(&root.final_path).await;
        let shared_identity = local_identity(&target_shared).await;

        assert!(commit_local_root(&root).await.unwrap().is_empty());

        assert_eq!(local_identity(&root.final_path).await, root_identity);
        assert_eq!(local_identity(&target_shared).await, shared_identity);

        assert_eq!(
            tokio::fs::read(root.final_path.join("same.txt"))
                .await
                .unwrap(),
            b"target"
        );
        assert_eq!(
            tokio::fs::read(root.final_path.join("source-only.txt"))
                .await
                .unwrap(),
            b"source-only"
        );
        assert_eq!(
            tokio::fs::read(root.final_path.join("target-only.txt"))
                .await
                .unwrap(),
            b"target-only"
        );
        assert_eq!(
            tokio::fs::read(root.final_path.join("type-conflict"))
                .await
                .unwrap(),
            b"target-file"
        );
        assert_eq!(
            tokio::fs::read(target_shared.join("source.txt"))
                .await
                .unwrap(),
            b"source"
        );
        assert_eq!(
            tokio::fs::read(target_shared.join("target.txt"))
                .await
                .unwrap(),
            b"target"
        );
    }

    #[tokio::test]
    async fn local_directory_replace_preserves_surviving_directory_identities() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join(".terax-part-task-0");
        let final_path = directory.path().join("final");
        let stage_shared = stage.join("shared");
        let target_shared = final_path.join("shared");
        tokio::fs::create_dir_all(&stage_shared).await.unwrap();
        tokio::fs::create_dir_all(&target_shared).await.unwrap();
        tokio::fs::write(stage_shared.join("new.txt"), b"new")
            .await
            .unwrap();
        tokio::fs::create_dir(final_path.join("removed"))
            .await
            .unwrap();
        tokio::fs::write(final_path.join("removed/old.txt"), b"old")
            .await
            .unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::Replace,
            merge_preconditions: Vec::new(),
        };
        let root_identity = local_identity(&root.final_path).await;
        let shared_identity = local_identity(&target_shared).await;

        assert!(commit_local_root(&root).await.unwrap().is_empty());

        assert_eq!(local_identity(&root.final_path).await, root_identity);
        assert_eq!(local_identity(&target_shared).await, shared_identity);
        assert_eq!(
            tokio::fs::read(target_shared.join("new.txt"))
                .await
                .unwrap(),
            b"new"
        );
        assert!(!root.final_path.join("removed").exists());
    }

    #[tokio::test]
    async fn local_directory_merge_rejects_a_new_unapproved_collision() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::create_dir(&stage).await.unwrap();
        tokio::fs::create_dir(&final_path).await.unwrap();
        let collision = final_path.join("appeared.txt");
        tokio::fs::write(stage.join("appeared.txt"), b"source")
            .await
            .unwrap();
        tokio::fs::write(&collision, b"external").await.unwrap();
        let root = LocalRoot {
            source_path: "source".into(),
            stage: stage.clone(),
            final_path: final_path.clone(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::Merge,
            merge_preconditions: vec![MergePrecondition {
                path: collision.clone(),
                expected_kind: None,
            }],
        };

        assert!(commit_local_root(&root).await.is_err());

        assert_eq!(tokio::fs::read(collision).await.unwrap(), b"external");
        assert_eq!(
            tokio::fs::read(stage.join("appeared.txt")).await.unwrap(),
            b"source"
        );
    }

    #[tokio::test]
    async fn archive_transaction_rolls_back_all_roots_when_publish_fails() {
        let directory = tempfile::tempdir().unwrap();
        let first_stage = directory.path().join("first-stage");
        let first_final = directory.path().join("first-final");
        let second_stage = directory.path().join("missing-stage");
        let second_final = directory.path().join("second-final");
        tokio::fs::write(&first_stage, b"new-first").await.unwrap();
        tokio::fs::write(&first_final, b"old-first").await.unwrap();
        tokio::fs::write(&second_final, b"old-second")
            .await
            .unwrap();
        let roots = vec![
            LocalRoot {
                source_path: "first".into(),
                stage: first_stage.clone(),
                final_path: first_final.clone(),
                kind: TransferEntryKind::File,
                destination_kind: Some(TransferEntryKind::File),
                mode: RootCommitMode::Replace,
                merge_preconditions: Vec::new(),
            },
            LocalRoot {
                source_path: "second".into(),
                stage: second_stage,
                final_path: second_final.clone(),
                kind: TransferEntryKind::File,
                destination_kind: Some(TransferEntryKind::File),
                mode: RootCommitMode::Replace,
                merge_preconditions: Vec::new(),
            },
        ];

        assert!(commit_local_roots(&roots).await.is_err());

        assert_eq!(tokio::fs::read(first_final).await.unwrap(), b"old-first");
        assert_eq!(tokio::fs::read(second_final).await.unwrap(), b"old-second");
        assert_eq!(tokio::fs::read(first_stage).await.unwrap(), b"new-first");
    }

    #[tokio::test]
    async fn archive_transaction_rolls_back_directory_contents_without_replacing_directories() {
        let directory = tempfile::tempdir().unwrap();
        let first_stage = directory.path().join("first-stage");
        let first_final = directory.path().join("first-final");
        let stage_shared = first_stage.join("shared");
        let target_shared = first_final.join("shared");
        tokio::fs::create_dir_all(&stage_shared).await.unwrap();
        tokio::fs::create_dir_all(&target_shared).await.unwrap();
        tokio::fs::write(stage_shared.join("value.txt"), b"new")
            .await
            .unwrap();
        tokio::fs::write(target_shared.join("value.txt"), b"old")
            .await
            .unwrap();
        let second_final = directory.path().join("second-final");
        tokio::fs::write(&second_final, b"old-second")
            .await
            .unwrap();
        let roots = vec![
            LocalRoot {
                source_path: "first".into(),
                stage: first_stage.clone(),
                final_path: first_final.clone(),
                kind: TransferEntryKind::Directory,
                destination_kind: Some(TransferEntryKind::Directory),
                mode: RootCommitMode::Replace,
                merge_preconditions: Vec::new(),
            },
            LocalRoot {
                source_path: "second".into(),
                stage: directory.path().join("missing-stage"),
                final_path: second_final,
                kind: TransferEntryKind::File,
                destination_kind: Some(TransferEntryKind::File),
                mode: RootCommitMode::Replace,
                merge_preconditions: Vec::new(),
            },
        ];
        let root_identity = local_identity(&first_final).await;
        let shared_identity = local_identity(&target_shared).await;

        assert!(commit_local_roots(&roots).await.is_err());

        assert_eq!(local_identity(&first_final).await, root_identity);
        assert_eq!(local_identity(&target_shared).await, shared_identity);
        assert_eq!(
            tokio::fs::read(target_shared.join("value.txt"))
                .await
                .unwrap(),
            b"old"
        );
        assert_eq!(
            tokio::fs::read(stage_shared.join("value.txt"))
                .await
                .unwrap(),
            b"new"
        );
        assert!(!local_backup_path(&roots[0]).exists());
    }
}
