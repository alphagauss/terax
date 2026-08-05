//! 文件传输 staging、覆盖事务与任务所有权清理。
//!
//! 每个顶层来源写入最终目标同级的固定长度 staging 路径。本地提交使用平台原生
//! rename；覆盖先保存旧目标，Archive 多根提交失败时统一回滚。清理只作用于任务
//! 命名的 staging 和 backup，不删除未经授权的用户路径。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use russh_sftp::client::SftpSession;

use crate::modules::remote::session::{join_remote, shell_quote, RemoteWorkspace};

use super::errors::TransferErrorCode;
use super::manager::TransferRunError;
use super::models::TransferEntryKind;

const MAX_REMOTE_PRECONDITION_PROBES: usize = 32;
const LOCAL_CLEANUP_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const LOCAL_CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);
const REMOTE_BACKUP_CLEANUP_PENDING_MARKER: &str = "TERAX_BACKUP_CLEANUP_PENDING_V1";

/// 顶层来源在最终目标上的提交方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RootCommitMode {
    Create,
    Replace,
    Merge,
    MergeSkip,
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

/// 按冲突阶段确定的模式公开一个本地 staging 根，并返回未清理的 backup。
pub(crate) async fn commit_local_root(root: &LocalRoot) -> RunResult<Vec<PathBuf>> {
    ensure_local_merge_preconditions(root).await?;
    let final_path = root.final_path.clone();
    let root = root.clone();
    tokio::task::spawn_blocking(move || commit_local_roots_blocking(std::slice::from_ref(&root)))
        .await
        .map_err(|error| message(format!("join local commit task: {error}")))?
        .map_err(|error| message(format!("commit transfer {}: {error}", final_path.display())))
}

/// 将 Archive 的全部本地根作为一个事务提交，并返回未清理的 backup。
///
/// 任一发布失败都会恢复全部旧目标；只有发布全部完成后才会返回可安全重试的残留路径。
pub(crate) async fn commit_local_roots(roots: &[LocalRoot]) -> RunResult<Vec<PathBuf>> {
    let roots = roots.to_vec();
    tokio::task::spawn_blocking(move || commit_local_roots_blocking(&roots))
        .await
        .map_err(|error| message(format!("join local archive commit task: {error}")))?
        .map_err(|error| message(format!("commit local archive transaction: {error}")))
}

/// 按冲突阶段确定的模式公开一个 SSH staging 根，并返回未清理的 backup。
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
    if root.mode == RootCommitMode::Replace
        && root.kind == TransferEntryKind::File
        && root.destination_kind == Some(TransferEntryKind::File)
    {
        let command = format!(
            "set -e\n{}mv -f -- {} {}\n",
            remote_precondition(root),
            shell_quote(&root.stage),
            shell_quote(&root.final_path)
        );
        execute_remote_commit(
            workspace,
            &command,
            &format!("commit remote transfer {}", root.final_path),
        )
        .await?;
        return Ok(Vec::new());
    }
    commit_remote_roots(workspace, std::slice::from_ref(root)).await
}

/// 在一次目标端 Shell 事务中提交全部 SSH Archive 根。
///
/// 失败时反向回滚；发布成功时返回 Shell 未能删除的 backup，供后台受限重试。
pub(crate) async fn commit_remote_roots(
    workspace: &Arc<RemoteWorkspace>,
    roots: &[RemoteRoot],
) -> RunResult<Vec<String>> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let backups: Vec<_> = roots
        .iter()
        .filter(|root| root.mode != RootCommitMode::Create)
        .map(remote_backup_path)
        .collect();
    let command = remote_transaction_command(roots, &backups);
    let cleanup_pending =
        execute_remote_commit(workspace, &command, "commit remote archive transaction").await?;
    Ok(if cleanup_pending { backups } else { Vec::new() })
}

/// 生成可单元测试的 SSH 多根提交与反向回滚脚本。
fn remote_transaction_command(roots: &[RemoteRoot], backups: &[String]) -> String {
    let mut command = String::from("set -e\n");
    for root in roots {
        let stage = shell_quote(&root.stage);
        let final_path = shell_quote(&root.final_path);
        command.push_str(&remote_precondition(root));
        if root.mode != RootCommitMode::Create {
            let backup = shell_quote(&remote_backup_path(root));
            command.push_str(&format!(
                "if [ -e {backup} ] || [ -L {backup} ]; then echo 'archive backup already exists; refusing to discard recovery data' >&2; exit 1; fi\n"
            ));
        }
        match root.mode {
            RootCommitMode::Merge => {
                command.push_str(&remote_source_wins_merge_command(&stage, &final_path));
            }
            RootCommitMode::MergeSkip => {
                command.push_str(&remote_target_wins_merge_command(&stage, &final_path));
            }
            RootCommitMode::Create | RootCommitMode::Replace => {}
        }
    }
    command.push_str("rollback() {\n  status=$?\n  trap - EXIT\n  set +e\n  rollback_failed=0\n");
    for (index, root) in roots.iter().enumerate().rev() {
        let stage = shell_quote(&root.stage);
        let final_path = shell_quote(&root.final_path);
        let backup = shell_quote(&remote_backup_path(root));
        command.push_str(&format!(
            "  if [ \"$published_{index}\" = 1 ] && ! mv -- {final_path} {stage}; then echo 'failed to withdraw published archive root' >&2; rollback_failed=1; fi\n"
        ));
        if root.mode != RootCommitMode::Create {
            command.push_str(&format!(
                "  if [ \"$backed_{index}\" = 1 ]; then\n    if [ -e {final_path} ] || [ -L {final_path} ] || ! mv -- {backup} {final_path}; then echo 'failed to restore archived destination' >&2; rollback_failed=1; fi\n  fi\n"
            ));
        }
    }
    command.push_str(
        "  if [ \"$rollback_failed\" != 0 ]; then echo 'archive rollback failed' >&2; exit 125; fi\n  exit \"$status\"\n}\n",
    );
    for index in 0..roots.len() {
        command.push_str(&format!("published_{index}=0\nbacked_{index}=0\n"));
    }
    command.push_str("trap rollback EXIT\n");
    for (index, root) in roots.iter().enumerate() {
        if root.mode == RootCommitMode::Create {
            continue;
        }
        let final_path = shell_quote(&root.final_path);
        let backup = shell_quote(&remote_backup_path(root));
        command.push_str(&format!("mv -- {final_path} {backup}\nbacked_{index}=1\n"));
    }
    for (index, root) in roots.iter().enumerate() {
        let final_path = shell_quote(&root.final_path);
        command.push_str(&format!(
            "if [ -e {final_path} ] || [ -L {final_path} ]; then echo 'archive destination appeared during commit' >&2; exit 1; fi\nmv -- {} {final_path}\npublished_{index}=1\n",
            shell_quote(&root.stage),
        ));
    }
    command.push_str("trap - EXIT\n");
    if !backups.is_empty() {
        command.push_str("set +e\n");
        command.push_str(&super::ssh::cleanup::cleanup_command(
            backups.iter().map(String::as_str),
        ));
        command.push_str(&format!(
            "\nterax_backup_cleanup_status=$?\nset -e\nif [ \"$terax_backup_cleanup_status\" != 0 ]; then printf '%s\\n' {}; fi\n",
            shell_quote(REMOTE_BACKUP_CLEANUP_PENDING_MARKER)
        ));
    }
    command
}

async fn execute_remote_commit(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    operation: &str,
) -> RunResult<bool> {
    let output = workspace
        .exec(command, None, Duration::from_secs(24 * 60 * 60))
        .await
        .map_err(|error| message(format!("{operation}: {error}")))?;
    if output.exit_code == Some(0) && !output.timed_out && !output.truncated {
        Ok(output
            .stdout
            .windows(REMOTE_BACKUP_CLEANUP_PENDING_MARKER.len())
            .any(|value| value == REMOTE_BACKUP_CLEANUP_PENDING_MARKER.as_bytes()))
    } else {
        Err(message(format!(
            "{operation} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn remote_source_wins_merge_command(stage: &str, final_path: &str) -> String {
    format!(
        r#"
find -P {final_path} -mindepth 1 -exec sh -c '
root=$1
stage=$2
shift 2
for item do
  relative=${{item#"$root"/}}
  destination=$stage/$relative
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    continue
  fi
  parent=${{destination%/*}}
  [ -d "$parent" ] || continue
  restore_parent=0
  permissions=$(LC_ALL=C ls -ld -- "$parent") || exit $?
  case "$permissions" in
    ??w*) ;;
    *) chmod u+w -- "$parent" || exit $?; restore_parent=1 ;;
  esac
  status=0
  if [ -d "$item" ] && [ ! -L "$item" ]; then
    cp -a -- "$item" "$destination" || status=$?
  elif [ -f "$item" ] && [ ! -L "$item" ]; then
    ln -- "$item" "$destination" 2>/dev/null || cp -a -- "$item" "$destination" || status=$?
  else
    cp -a -- "$item" "$destination" || status=$?
  fi
  if [ "$restore_parent" = 1 ]; then chmod u-w -- "$parent" || exit $?; fi
  [ "$status" = 0 ] || exit "$status"
done
' terax-merge {final_path} {stage} {{}} +
"#
    )
}

/// 生成目标优先的远端合并脚本，重名项保留目标版本，来源独有项保留在 staging。
fn remote_target_wins_merge_command(stage: &str, final_path: &str) -> String {
    format!(
        r#"
find -P {final_path} -mindepth 1 -exec sh -c '
root=$1
stage=$2
shift 2
for item do
  relative=${{item#"$root"/}}
  destination=$stage/$relative
  parent=${{destination%/*}}
  restore_parent=0
  permissions=$(LC_ALL=C ls -ld -- "$parent") || exit $?
  case "$permissions" in
    ??w*) ;;
    *) chmod u+w -- "$parent" || exit $?; restore_parent=1 ;;
  esac
  status=0
  if [ -d "$item" ] && [ ! -L "$item" ]; then
    if [ -d "$destination" ] && [ ! -L "$destination" ]; then
      :
    else
      if [ -e "$destination" ] || [ -L "$destination" ]; then
        if [ -d "$destination" ] && [ ! -L "$destination" ]; then chmod -R u+w -- "$destination" || status=$?; fi
        [ "$status" = 0 ] && rm -rf -- "$destination" || status=$?
      fi
      [ "$status" = 0 ] && mkdir -- "$destination" || status=$?
    fi
  else
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      if [ -d "$destination" ] && [ ! -L "$destination" ]; then chmod -R u+w -- "$destination" || status=$?; fi
      [ "$status" = 0 ] && rm -rf -- "$destination" || status=$?
    fi
    if [ "$status" = 0 ]; then
      if [ -f "$item" ] && [ ! -L "$item" ]; then
        ln -- "$item" "$destination" 2>/dev/null || cp -a -- "$item" "$destination" || status=$?
      else
        cp -a -- "$item" "$destination" || status=$?
      fi
    fi
  fi
  if [ "$restore_parent" = 1 ]; then chmod u-w -- "$parent" || exit $?; fi
  [ "$status" = 0 ] || exit "$status"
done
' terax-merge-target {final_path} {stage} {{}} +
find -P {final_path} -depth -type d -exec sh -c '
root=$1
stage=$2
shift 2
for item do
  relative=${{item#"$root"/}}
  destination=$stage/$relative
  chmod --reference="$item" -- "$destination" || exit $?
  touch -r "$item" -- "$destination" || exit $?
done
' terax-merge-target-metadata {final_path} {stage} {{}} +
chmod --reference={final_path} -- {stage}
touch -r {final_path} -- {stage}
"#
    )
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
        match root.mode {
            RootCommitMode::Merge => {
                merge_target_only_blocking(&root.final_path, &root.stage)?;
            }
            RootCommitMode::MergeSkip => {
                merge_target_wins_blocking(&root.final_path, &root.stage)?;
            }
            RootCommitMode::Create | RootCommitMode::Replace => {}
        }
    }

    if let [root] = roots {
        if root.mode == RootCommitMode::Replace
            && root.kind == TransferEntryKind::File
            && root.destination_kind == Some(TransferEntryKind::File)
        {
            replace_file(&root.stage, &root.final_path)?;
            return Ok(Vec::new());
        }
    }

    let mut backed = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        if root.mode == RootCommitMode::Create {
            continue;
        }
        let backup = local_backup_path(root);
        if let Err(error) = rename_no_replace(&root.final_path, &backup) {
            let rollback = rollback_local_archive(roots, &[], &backed);
            return Err(transaction_error(error, rollback));
        }
        backed.push(index);
    }

    let mut published = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        if let Err(error) = rename_no_replace(&root.stage, &root.final_path) {
            let rollback = rollback_local_archive(roots, &published, &backed);
            return Err(transaction_error(error, rollback));
        }
        published.push(index);
    }

    let mut pending_cleanup = Vec::new();
    for index in backed {
        let backup = local_backup_path(&roots[index]);
        if let Err(error) = remove_local_path_blocking(&backup) {
            log::warn!(
                "failed to clean committed transfer backup {}: {error}",
                backup.display()
            );
            pending_cleanup.push(backup);
        }
    }
    Ok(pending_cleanup)
}

fn rollback_local_archive(
    roots: &[LocalRoot],
    published: &[usize],
    backed: &[usize],
) -> std::io::Result<()> {
    let mut failure = None;
    for index in published.iter().rev() {
        let root = &roots[*index];
        if let Err(error) = rename_no_replace(&root.final_path, &root.stage) {
            failure.get_or_insert(error);
        }
    }
    for index in backed.iter().rev() {
        let root = &roots[*index];
        if let Err(error) = rename_no_replace(&local_backup_path(root), &root.final_path) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
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

/// 将目标独有内容复制进来源 staging，来源中的同路径条目始终优先。
fn merge_target_only_blocking(source: &Path, stage: &Path) -> std::io::Result<()> {
    let mut pending = vec![(source.to_path_buf(), stage.to_path_buf())];
    while let Some((source_dir, stage_dir)) = pending.pop() {
        let source_metadata = std::fs::symlink_metadata(&source_dir)?;
        if !source_metadata.is_dir() || source_metadata.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotADirectory,
                format!(
                    "merge source changed to a non-directory: {}",
                    source_dir.display()
                ),
            ));
        }
        with_writable_local_directory(&stage_dir, || {
            for entry in std::fs::read_dir(&source_dir)? {
                let entry = entry?;
                let source_path = entry.path();
                let stage_path = stage_dir.join(entry.file_name());
                let source_metadata = std::fs::symlink_metadata(&source_path)?;
                match std::fs::symlink_metadata(&stage_path) {
                    Ok(stage_metadata)
                        if source_metadata.is_dir()
                            && !source_metadata.file_type().is_symlink()
                            && stage_metadata.is_dir()
                            && !stage_metadata.file_type().is_symlink() =>
                    {
                        pending.push((source_path, stage_path));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        copy_local_tree_blocking(&source_path, &stage_path)?;
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

/// 将目标树覆盖到来源 staging，重名项保留目标版本，来源独有项保持不变。
fn merge_target_wins_blocking(target: &Path, stage: &Path) -> std::io::Result<()> {
    let target_metadata = std::fs::symlink_metadata(target)?;
    if !target_metadata.is_dir() || target_metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!(
                "merge target changed to a non-directory: {}",
                target.display()
            ),
        ));
    }
    with_writable_local_directory(stage, || {
        for entry in std::fs::read_dir(target)? {
            let entry = entry?;
            let target_path = entry.path();
            let stage_path = stage.join(entry.file_name());
            let target_metadata = std::fs::symlink_metadata(&target_path)?;
            match std::fs::symlink_metadata(&stage_path) {
                Ok(stage_metadata)
                    if target_metadata.is_dir()
                        && !target_metadata.file_type().is_symlink()
                        && stage_metadata.is_dir()
                        && !stage_metadata.file_type().is_symlink() =>
                {
                    merge_target_wins_blocking(&target_path, &stage_path)?;
                }
                Ok(_) => {
                    remove_local_path_blocking(&stage_path)?;
                    copy_local_tree_blocking(&target_path, &stage_path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    copy_local_tree_blocking(&target_path, &stage_path)?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })?;
    copy_local_metadata(target, stage, &target_metadata)
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

fn copy_local_tree_blocking(source: &Path, destination: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return copy_symlink(source, destination);
    }
    if metadata.is_file() {
        // staging 与最终目标同级，优先硬链接可避免复制体积庞大的目标独有文件。
        if std::fs::hard_link(source, destination).is_err() {
            std::fs::copy(source, destination)?;
            copy_local_metadata(source, destination, &metadata)?;
        }
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "cannot preserve special destination entry {}",
                source.display()
            ),
        ));
    }
    std::fs::create_dir(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        copy_local_tree_blocking(&entry.path(), &destination.join(entry.file_name()))?;
    }
    copy_local_metadata(source, destination, &metadata)?;
    Ok(())
}

/// 临时确保 staging 目录可写，并在复制目标独有条目后恢复来源目录权限。
fn with_writable_local_directory<T>(
    path: &Path,
    action: impl FnOnce() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("merge staging path is not a directory: {}", path.display()),
        ));
    }
    let original = metadata.permissions();
    let changed = make_local_directory_writable(path, &original)?;
    let result = action();
    let restore = changed.then(|| std::fs::set_permissions(path, original));
    match (result, restore) {
        (Ok(value), None | Some(Ok(()))) => Ok(value),
        (Err(error), None | Some(Ok(()))) => Err(error),
        (Ok(_), Some(Err(error))) => Err(error),
        (Err(error), Some(Err(restore))) => Err(std::io::Error::other(format!(
            "merge failed: {error}; restoring directory permissions failed: {restore}"
        ))),
    }
}

#[cfg(unix)]
fn make_local_directory_writable(
    path: &Path,
    original: &std::fs::Permissions,
) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;

    let mode = original.mode();
    if mode & 0o700 == 0o700 {
        return Ok(false);
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o700))?;
    Ok(true)
}

#[cfg(not(unix))]
#[allow(clippy::permissions_set_readonly_false)]
fn make_local_directory_writable(
    path: &Path,
    original: &std::fs::Permissions,
) -> std::io::Result<bool> {
    if !original.readonly() {
        return Ok(false);
    }
    let mut writable = original.clone();
    // Windows 只暴露 readonly 属性，不存在 Unix mode；清除此属性不会扩大 ACL 权限。
    writable.set_readonly(false);
    std::fs::set_permissions(path, writable)?;
    Ok(true)
}

/// 为无法硬链接的目标独有条目恢复基础时间和权限。
fn copy_local_metadata(
    source: &Path,
    destination: &Path,
    metadata: &std::fs::Metadata,
) -> std::io::Result<()> {
    if let (Ok(accessed), Ok(modified)) = (metadata.accessed(), metadata.modified()) {
        filetime::set_file_times(
            destination,
            filetime::FileTime::from_system_time(accessed),
            filetime::FileTime::from_system_time(modified),
        )?;
    }
    std::fs::set_permissions(destination, std::fs::metadata(source)?.permissions())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(source)?, destination)
}

#[cfg(windows)]
fn copy_symlink(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::FileTypeExt;

    let target = std::fs::read_link(source)?;
    let file_type = std::fs::symlink_metadata(source)?.file_type();
    if file_type.is_symlink_dir() {
        std::os::windows::fs::symlink_dir(target, destination)
    } else {
        std::os::windows::fs::symlink_file(target, destination)
    }
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

/// 删除一组已经验证的本地任务临时路径并返回仍需重试的项。
async fn remove_local_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
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
    tauri::async_runtime::spawn(async move {
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

        let backups: Vec<_> = roots
            .iter()
            .filter(|root| root.mode != RootCommitMode::Create)
            .map(remote_backup_path)
            .collect();
        let command = remote_transaction_command(&roots, &backups);

        assert!(command.contains("transfer destination changed after conflict approval"));
        assert!(command.contains("find -P '/target/existing'"));
        assert!(command.contains("terax-merge-target '/target/preserve'"));
        assert!(command.contains("chmod --reference='/target/preserve'"));
        assert!(command.contains("backed_1=1"));
        assert!(command.find("published_1").unwrap() < command.find("published_0").unwrap());
        assert!(command.contains("set -- '/target/.terax-part-task-1.backup'"));
        assert!(command.contains("'/target/.terax-part-task-2.backup'"));
        assert!(command.contains(REMOTE_BACKUP_CLEANUP_PENDING_MARKER));
        assert!(command.ends_with("fi\n"));
        assert!(!command.contains("rm -rf -- '/target/.terax-part-task-1.backup'"));
        assert!(!command.contains("rm -rf -- '/target/.terax-part-task-2.backup'"));
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
        let root = RemoteRoot {
            source_path: "/source".into(),
            stage: stage.to_string_lossy().into_owned(),
            final_path: final_path.to_string_lossy().into_owned(),
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::MergeSkip,
            merge_preconditions: Vec::new(),
        };

        let backups = vec![remote_backup_path(&root)];
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(remote_transaction_command(&[root], &backups))
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
            .windows(REMOTE_BACKUP_CLEANUP_PENDING_MARKER.len())
            .any(|value| value == REMOTE_BACKUP_CLEANUP_PENDING_MARKER.as_bytes()));
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

        assert!(commit_local_root(&root).await.unwrap().is_empty());

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
        let root = LocalRoot {
            source_path: "source".into(),
            stage,
            final_path,
            kind: TransferEntryKind::Directory,
            destination_kind: Some(TransferEntryKind::Directory),
            mode: RootCommitMode::MergeSkip,
            merge_preconditions: Vec::new(),
        };

        assert!(commit_local_root(&root).await.unwrap().is_empty());

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
}
