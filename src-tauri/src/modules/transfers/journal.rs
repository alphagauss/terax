//! 文件传输任务的扁平 Journal 持久化。
//!
//! 每个任务只使用 `~/.terax/transfers` 下一个 JSONL 文件。创建、追加、读取和删除
//! 共用一个短时注册锁，避免多个 Workspace 进程交叉写入。进度字节不逐次落盘，
//! 提交 backup 的 recovery/disposable 转换则必须同步持久化。

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::modules::app_data::{self, Directory};
use crate::modules::storage::FileLock;
use crate::modules::workspace::WorkspaceEnv;
use crate::modules::workspace_process::environment_filename_key;

use super::cleanup_ticket::CleanupTicket;
use super::errors::{TransferErrorCode, TransferFailure};
use super::models::{
    EnqueueTransferRequest, TransferFileFailure, TransferStatus, TransferTaskSnapshot,
};

const REGISTRY_LOCK: &str = "registry.lock";
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize, Serialize)]
#[serde(tag = "record", rename_all = "snake_case")]
enum JournalRecord {
    Created {
        request: EnqueueTransferRequest,
        snapshot: TransferTaskSnapshot,
    },
    Snapshot {
        snapshot: TransferTaskSnapshot,
    },
    FileFailures {
        failures: Vec<TransferFileFailure>,
    },
    CommittedProgress {
        committed_roots: u64,
        completed_files: u64,
        updated_at: u64,
    },
    CleanupTicket {
        ticket: CleanupTicket,
    },
    CleanupFinished {
        ticket_id: String,
    },
}

/// 从 Journal 恢复的任务及其原始请求。
pub(crate) struct LoadedTask {
    pub(crate) request: EnqueueTransferRequest,
    pub(crate) snapshot: TransferTaskSnapshot,
    pub(crate) path: PathBuf,
    pub(crate) cleanup_tickets: Vec<CleanupTicket>,
}

/// 追加一条 recovery 或 disposable 清理票据。
pub(crate) async fn append_cleanup_ticket(
    path: &Path,
    ticket: &CleanupTicket,
) -> Result<(), TransferFailure> {
    append_record(
        path,
        &JournalRecord::CleanupTicket {
            ticket: ticket.clone(),
        },
        "append transfer cleanup ticket",
    )
    .await
}

/// 记录指定清理票据已经完成，重放时不再执行。
pub(crate) async fn append_cleanup_finished(
    path: &Path,
    ticket_id: &str,
) -> Result<(), TransferFailure> {
    append_record(
        path,
        &JournalRecord::CleanupFinished {
            ticket_id: ticket_id.to_string(),
        },
        "finish transfer cleanup ticket",
    )
    .await
}

/// 创建任务 Journal，并把请求和首个快照写为第一行。
pub(crate) async fn create(
    env: &WorkspaceEnv,
    workspace_id: &str,
    request: &EnqueueTransferRequest,
    snapshot: &TransferTaskSnapshot,
) -> Result<PathBuf, TransferFailure> {
    let root = transfers_root()?;
    let prefix = journal_prefix(env, workspace_id)?;
    let path = root.join(format!("{prefix}.{}.jsonl", snapshot.id));
    let record = serialize(&JournalRecord::Created {
        request: request.clone(),
        snapshot: snapshot.clone(),
    })?;
    let result_path = path.clone();
    tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&root)?;
        let _lock = FileLock::acquire(&root.join(REGISTRY_LOCK), LOCK_TIMEOUT)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(&record)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok::<_, std::io::Error>(())
    })
    .await
    .map_err(|error| internal(format!("join transfer journal create: {error}")))?
    .map_err(|error| io_error("create transfer journal", error))?;
    Ok(result_path)
}

/// 追加一个值得恢复的任务快照，不记录高频字节进度。
pub(crate) async fn append(
    path: &Path,
    snapshot: &TransferTaskSnapshot,
) -> Result<(), TransferFailure> {
    append_record(
        path,
        &JournalRecord::Snapshot {
            snapshot: snapshot.clone(),
        },
        "append transfer journal",
    )
    .await
}

/// 批量持久化 Direct 文件失败，避免逐文件取得全局锁并同步磁盘。
pub(crate) async fn append_file_failures(
    path: &Path,
    failures: &[TransferFileFailure],
) -> Result<(), TransferFailure> {
    if failures.is_empty() {
        return Ok(());
    }
    append_record(
        path,
        &JournalRecord::FileFailures {
            failures: failures.to_vec(),
        },
        "append transfer file failures",
    )
    .await
}

/// 增量记录不可回滚的发布进度，避免 Direct 多根任务反复写入完整失败数组。
pub(crate) async fn append_committed_progress(
    path: &Path,
    snapshot: &TransferTaskSnapshot,
) -> Result<(), TransferFailure> {
    append_record(
        path,
        &JournalRecord::CommittedProgress {
            committed_roots: snapshot.committed_roots,
            completed_files: snapshot.completed_files,
            updated_at: snapshot.updated_at,
        },
        "append committed transfer progress",
    )
    .await
}

/// 在注册锁下追加一条完整记录并同步数据。
async fn append_record(
    path: &Path,
    record: &JournalRecord,
    operation: &'static str,
) -> Result<(), TransferFailure> {
    let root = transfers_root()?;
    let path = path.to_path_buf();
    let record = serialize(record)?;
    tokio::task::spawn_blocking(move || {
        let _lock = FileLock::acquire(&root.join(REGISTRY_LOCK), LOCK_TIMEOUT)?;
        append_bytes_blocking(&path, &record)
    })
    .await
    .map_err(|error| internal(format!("join {operation}: {error}")))?
    .map_err(|error| io_error(operation, error))
}

/// 删除一个任务 Journal。不存在视为已经清理成功。
pub(crate) async fn remove(path: &Path) -> Result<(), TransferFailure> {
    let root = transfers_root()?;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || remove_blocking(&root, &path))
        .await
        .map_err(|error| internal(format!("join transfer journal removal: {error}")))?
        .map_err(|error| io_error("remove transfer journal", error))
}

fn remove_blocking(root: &Path, path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root)?;
    let _lock = FileLock::acquire(&root.join(REGISTRY_LOCK), LOCK_TIMEOUT)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 读取当前环境的任务 Journal，并把异常退出时的活动任务收敛为失败终态。
pub(crate) async fn load(
    env: &WorkspaceEnv,
    workspace_id: &str,
) -> Result<Vec<LoadedTask>, TransferFailure> {
    let root = transfers_root()?;
    let prefix = format!("{}.", journal_prefix(env, workspace_id)?);
    tokio::task::spawn_blocking(move || load_blocking(&root, &prefix))
        .await
        .map_err(|error| internal(format!("join transfer journal load: {error}")))?
        .map_err(|error| io_error("load transfer journals", error))
}

/// 删除已经确认没有进程持有的额外 Workspace 的全部任务 Journal。
pub(crate) fn remove_workspace_files(root: &Path, workspace_id: Uuid) -> Result<(), String> {
    remove_workspace_files_blocking(root, workspace_id).map_err(|error| error.to_string())
}

fn remove_workspace_files_blocking(root: &Path, workspace_id: Uuid) -> std::io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let _lock = FileLock::acquire(&root.join(REGISTRY_LOCK), LOCK_TIMEOUT)?;
    let marker = format!(".{workspace_id}.");
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some((_, task_suffix)) = name.split_once(&marker) else {
            continue;
        };
        let Some(task_id) = task_suffix.strip_suffix(".jsonl") else {
            continue;
        };
        if Uuid::parse_str(task_id).is_ok() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn load_blocking(root: &Path, prefix: &str) -> std::io::Result<Vec<LoadedTask>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let _lock = FileLock::acquire(&root.join(REGISTRY_LOCK), LOCK_TIMEOUT)?;
    let mut loaded = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with(prefix) || !name.ends_with(".jsonl") {
            continue;
        }
        match read_task(&path) {
            Ok(Some(mut task)) => {
                if !task.snapshot.status.is_terminal() {
                    recover_interrupted(&mut task.snapshot);
                    append_blocking(
                        &path,
                        &JournalRecord::Snapshot {
                            snapshot: task.snapshot.clone(),
                        },
                    )?;
                }
                loaded.push(task);
            }
            Ok(None) => {
                log::warn!("removing empty transfer journal {}", path.display());
                if let Err(error) = fs::remove_file(&path) {
                    log::warn!(
                        "failed to remove empty transfer journal {}: {error}",
                        path.display()
                    );
                }
            }
            Err(error) => log::warn!(
                "ignored invalid transfer journal {}: {error}",
                path.display()
            ),
        }
    }
    Ok(loaded)
}

fn read_task(path: &Path) -> Result<Option<LoadedTask>, String> {
    let data = fs::read(path).map_err(|error| error.to_string())?;
    let mut request = None;
    let mut snapshot = None;
    let mut cleanup_tickets = HashMap::new();
    let lines: Vec<_> = data.split(|byte| *byte == b'\n').collect();
    for (index, line) in lines.iter().enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let record = match serde_json::from_slice::<JournalRecord>(line) {
            Ok(record) => {
                if index + 1 == lines.len() && !data.ends_with(b"\n") {
                    append_trailing_newline(path).map_err(|repair| repair.to_string())?;
                }
                record
            }
            Err(error) if index + 1 == lines.len() && !data.ends_with(b"\n") => {
                repair_trailing_record(path, &data).map_err(|repair| repair.to_string())?;
                log::warn!(
                    "discarded incomplete transfer journal record {}: {error}",
                    path.display()
                );
                break;
            }
            Err(error) => return Err(error.to_string()),
        };
        match record {
            JournalRecord::Created {
                request: created_request,
                snapshot: created_snapshot,
            } => {
                request = Some(created_request);
                snapshot = Some(created_snapshot);
            }
            JournalRecord::Snapshot {
                snapshot: next_snapshot,
            } => snapshot = Some(next_snapshot),
            JournalRecord::FileFailures { failures } => {
                let Some(current) = snapshot.as_mut() else {
                    return Err("file failure appears before the created record".into());
                };
                for failure in failures {
                    if !current
                        .file_failures
                        .iter()
                        .any(|known| known.id == failure.id)
                    {
                        current.failed_files = current.failed_files.saturating_add(1);
                        current.is_directory = true;
                        current.file_failures.push(failure);
                    }
                }
            }
            JournalRecord::CommittedProgress {
                committed_roots,
                completed_files,
                updated_at,
            } => {
                let Some(current) = snapshot.as_mut() else {
                    return Err("committed progress appears before the created record".into());
                };
                current.committed_roots = committed_roots;
                current.completed_files = completed_files;
                current.updated_at = updated_at;
            }
            JournalRecord::CleanupTicket { ticket } => {
                cleanup_tickets.insert(ticket.id.clone(), ticket);
            }
            JournalRecord::CleanupFinished { ticket_id } => {
                cleanup_tickets.remove(&ticket_id);
            }
        }
    }
    match (request, snapshot) {
        (Some(request), Some(snapshot)) => Ok(Some(LoadedTask {
            request,
            snapshot,
            path: path.to_path_buf(),
            cleanup_tickets: cleanup_tickets.into_values().collect(),
        })),
        (None, None) => Ok(None),
        _ => Err("journal is missing its created record".into()),
    }
}

/// 截断崩溃写入留下的不完整末行，保留此前已经同步的记录。
fn repair_trailing_record(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let valid_len = data
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let file = OpenOptions::new().write(true).open(path)?;
    file.set_len(valid_len as u64)?;
    file.sync_data()
}

/// 规范化缺少换行但内容完整的最后一条记录，保证后续追加不粘连。
fn append_trailing_newline(path: &Path) -> std::io::Result<()> {
    let mut file = OpenOptions::new().append(true).open(path)?;
    file.write_all(b"\n")?;
    file.sync_data()
}

fn append_blocking(path: &Path, record: &JournalRecord) -> std::io::Result<()> {
    let data = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    append_bytes_blocking(path, &data)
}

fn append_bytes_blocking(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().append(true).open(path)?;
    file.write_all(data)?;
    file.write_all(b"\n")?;
    file.sync_data()
}

fn recover_interrupted(snapshot: &mut TransferTaskSnapshot) {
    snapshot.status = TransferStatus::Failed;
    snapshot.stage = super::models::TransferStage::Finished;
    snapshot.current_file = None;
    snapshot.conflict = None;
    snapshot.speed_bytes_per_second = 0;
    snapshot.total_files = snapshot.total_files.max(
        snapshot
            .completed_files
            .saturating_add(snapshot.failed_files),
    );
    snapshot.unprocessed_files = snapshot
        .total_files
        .saturating_sub(snapshot.completed_files)
        .saturating_sub(snapshot.failed_files);
    snapshot.failure = Some(TransferFailure::new(
        TransferErrorCode::Internal,
        "Terax exited before the transfer completed",
    ));
    snapshot.updated_at = snapshot.updated_at.saturating_add(1);
}

fn transfers_root() -> Result<PathBuf, TransferFailure> {
    app_data::directory(Directory::Transfers).map_err(internal)
}

fn journal_prefix(env: &WorkspaceEnv, workspace_id: &str) -> Result<String, TransferFailure> {
    let workspace_id = Uuid::parse_str(workspace_id).map_err(|_| {
        TransferFailure::new(
            TransferErrorCode::InvalidRequest,
            "invalid Workspace id for transfer journal",
        )
    })?;
    Ok(format!(
        "{}.{}",
        environment_filename_key(env).map_err(internal)?,
        workspace_id
    ))
}

fn serialize(record: &JournalRecord) -> Result<Vec<u8>, TransferFailure> {
    serde_json::to_vec(record)
        .map_err(|error| internal(format!("serialize transfer journal: {error}")))
}

fn io_error(context: &str, error: std::io::Error) -> TransferFailure {
    super::errors::io_failure(context, &error)
}

fn internal(detail: impl Into<String>) -> TransferFailure {
    TransferFailure::new(TransferErrorCode::Internal, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::transfers::models::{TransferDirection, TransferStage, TransferStrategy};

    fn snapshot(status: TransferStatus, updated_at: u64) -> TransferTaskSnapshot {
        TransferTaskSnapshot {
            id: "task".into(),
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Direct,
            status,
            stage: TransferStage::Queued,
            source_count: 1,
            destination: "/tmp".into(),
            name: "file.txt".into(),
            total_bytes: 10,
            transferred_bytes: 0,
            total_files: 1,
            completed_files: 0,
            failed_files: 0,
            unprocessed_files: 0,
            total_roots: 1,
            committed_roots: 0,
            speed_bytes_per_second: 0,
            current_file: None,
            failure: None,
            file_failures: Vec::new(),
            conflict: None,
            is_directory: false,
            created_at: 1,
            updated_at,
        }
    }

    #[test]
    fn journal_replay_uses_original_request_and_latest_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("task.jsonl");
        let request = EnqueueTransferRequest {
            destination_name: None,
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Direct,
            sources: vec!["file.txt".into()],
            destination: "/tmp".into(),
        };
        std::fs::File::create(&path).unwrap();
        append_blocking(
            &path,
            &JournalRecord::Created {
                request,
                snapshot: snapshot(TransferStatus::Queued, 1),
            },
        )
        .unwrap();
        let mut latest = snapshot(TransferStatus::Completed, 2);
        latest.is_directory = true;
        latest.total_files = 7;
        latest.total_bytes = 42;
        append_blocking(&path, &JournalRecord::Snapshot { snapshot: latest }).unwrap();
        append_blocking(
            &path,
            &JournalRecord::CommittedProgress {
                committed_roots: 1,
                completed_files: 6,
                updated_at: 3,
            },
        )
        .unwrap();

        let loaded = read_task(&path).unwrap().unwrap();

        assert_eq!(loaded.request.sources, vec!["file.txt"]);
        assert_eq!(loaded.snapshot.status, TransferStatus::Completed);
        assert_eq!(loaded.snapshot.updated_at, 3);
        assert!(loaded.snapshot.is_directory);
        assert_eq!(loaded.snapshot.total_files, 7);
        assert_eq!(loaded.snapshot.total_bytes, 42);
        assert_eq!(loaded.snapshot.committed_roots, 1);
        assert_eq!(loaded.snapshot.completed_files, 6);
    }

    #[test]
    fn journal_replay_applies_incremental_file_failures() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("task.jsonl");
        let request = EnqueueTransferRequest {
            destination_name: None,
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Direct,
            sources: vec!["folder".into()],
            destination: "/tmp".into(),
        };
        std::fs::File::create(&path).unwrap();
        append_blocking(
            &path,
            &JournalRecord::Created {
                request,
                snapshot: snapshot(TransferStatus::Running, 1),
            },
        )
        .unwrap();
        let first_failure = TransferFileFailure {
            id: "failure".into(),
            source_path: "/source/file".into(),
            destination_path: "/target/file".into(),
            failure: TransferFailure::new(TransferErrorCode::SourceChanged, "changed"),
            attempts: 1,
            ignored: false,
        };
        append_blocking(
            &path,
            &JournalRecord::FileFailures {
                failures: vec![
                    first_failure.clone(),
                    TransferFileFailure {
                        id: "second-failure".into(),
                        ..first_failure
                    },
                ],
            },
        )
        .unwrap();

        let loaded = read_task(&path).unwrap().unwrap();

        assert_eq!(loaded.snapshot.failed_files, 2);
        assert!(loaded.snapshot.is_directory);
        assert_eq!(loaded.snapshot.file_failures[0].id, "failure");
        assert_eq!(loaded.snapshot.file_failures[1].id, "second-failure");
    }

    #[test]
    fn journal_replay_keeps_only_unfinished_cleanup_tickets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("task.jsonl");
        std::fs::File::create(&path).unwrap();
        append_blocking(
            &path,
            &JournalRecord::Created {
                request: EnqueueTransferRequest {
                    destination_name: None,
                    direction: TransferDirection::Upload,
                    strategy: TransferStrategy::Archive,
                    sources: vec!["folder".into()],
                    destination: "/tmp".into(),
                },
                snapshot: snapshot(TransferStatus::Running, 1),
            },
        )
        .unwrap();
        let mut pending =
            CleanupTicket::recovery(super::super::cleanup_ticket::CleanupTicketTarget::Local {
                staging_task_id: "staging".into(),
                owner_task_id: "task".into(),
                paths: vec!["/tmp/.terax-part-staging-0.backup".into()],
            });
        let finished =
            CleanupTicket::recovery(super::super::cleanup_ticket::CleanupTicketTarget::Local {
                staging_task_id: "other".into(),
                owner_task_id: "task".into(),
                paths: vec!["/tmp/.terax-part-other-0.backup".into()],
            });
        append_blocking(
            &path,
            &JournalRecord::CleanupTicket {
                ticket: pending.clone(),
            },
        )
        .unwrap();
        pending.mark_disposable();
        append_blocking(
            &path,
            &JournalRecord::CleanupTicket {
                ticket: pending.clone(),
            },
        )
        .unwrap();
        append_blocking(
            &path,
            &JournalRecord::CleanupTicket {
                ticket: finished.clone(),
            },
        )
        .unwrap();
        append_blocking(
            &path,
            &JournalRecord::CleanupFinished {
                ticket_id: finished.id,
            },
        )
        .unwrap();

        let loaded = read_task(&path).unwrap().unwrap();

        assert_eq!(loaded.cleanup_tickets, vec![pending]);
    }

    #[test]
    fn journal_replay_discards_only_an_incomplete_trailing_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("task.jsonl");
        let request = EnqueueTransferRequest {
            destination_name: None,
            direction: TransferDirection::Upload,
            strategy: TransferStrategy::Direct,
            sources: vec!["file.txt".into()],
            destination: "/tmp".into(),
        };
        std::fs::File::create(&path).unwrap();
        append_blocking(
            &path,
            &JournalRecord::Created {
                request,
                snapshot: snapshot(TransferStatus::Completed, 1),
            },
        )
        .unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"record":"snapshot"#).unwrap();
        drop(file);

        let loaded = read_task(&path).unwrap().unwrap();

        assert_eq!(loaded.snapshot.status, TransferStatus::Completed);
        assert!(std::fs::read(&path).unwrap().ends_with(b"\n"));
    }

    #[test]
    fn interrupted_tasks_recover_as_failed_with_unprocessed_count() {
        let mut task = snapshot(TransferStatus::Running, 5);
        task.total_files = 3;
        task.completed_files = 1;
        task.total_roots = 2;
        task.committed_roots = 1;
        task.conflict = Some(super::super::models::TransferConflict {
            id: "conflict".into(),
            kind: super::super::models::TransferConflictKind::File,
            source_kind: super::super::models::TransferEntryKind::File,
            destination_kind: super::super::models::TransferEntryKind::File,
            source_path: "/source".into(),
            destination_path: "/target".into(),
            decisions: vec![super::super::models::TransferConflictDecision::Cancel],
            allow_apply_to_remaining: false,
        });

        recover_interrupted(&mut task);

        assert_eq!(task.status, TransferStatus::Failed);
        assert_eq!(task.stage, TransferStage::Finished);
        assert_eq!(task.completed_files, 1);
        assert_eq!(task.unprocessed_files, 2);
        assert_eq!(task.committed_roots, 1);
        assert_eq!(task.updated_at, 6);
        assert!(task.conflict.is_none());
        assert_eq!(task.failure.unwrap().code, TransferErrorCode::Internal);
    }

    #[test]
    fn journal_removal_deletes_the_task_file_under_the_registry_lock() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("task.jsonl");
        std::fs::write(&path, b"record\n").unwrap();

        remove_blocking(directory.path(), &path).unwrap();

        assert!(!path.exists());
        assert!(directory.path().join(REGISTRY_LOCK).exists());
    }

    #[test]
    fn journal_loading_removes_an_unrecoverable_empty_task_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("local.workspace.task.jsonl");
        std::fs::File::create(&path).unwrap();

        let loaded = load_blocking(directory.path(), "local.workspace.").unwrap();

        assert!(loaded.is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn stale_workspace_cleanup_removes_only_its_valid_task_journals() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Uuid::new_v4();
        let other_workspace = Uuid::new_v4();
        let task = Uuid::new_v4();
        let owned = directory
            .path()
            .join(format!("ssh-server.{workspace}.{task}.jsonl"));
        let other = directory
            .path()
            .join(format!("ssh-server.{other_workspace}.{task}.jsonl"));
        let malformed = directory
            .path()
            .join(format!("ssh-server.{workspace}.not-a-task.jsonl"));
        std::fs::write(&owned, b"owned").unwrap();
        std::fs::write(&other, b"other").unwrap();
        std::fs::write(&malformed, b"malformed").unwrap();

        remove_workspace_files_blocking(directory.path(), workspace).unwrap();

        assert!(!owned.exists());
        assert!(other.exists());
        assert!(malformed.exists());
    }
}
