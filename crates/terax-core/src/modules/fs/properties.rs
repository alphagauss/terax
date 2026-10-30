//! 本地、WSL 与 SSH 文件属性查询和目录汇总。
//!
//! 基础查询始终使用当前进程绑定的 Workspace 环境。目录扫描不跟随符号链接，
//! POSIX 远端优先在服务端聚合以避免逐目录网络往返，失败时安全回退 SFTP。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::modules::remote::session::RemoteWorkspace;
use crate::modules::remote::{self, RemoteState};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};
use crate::modules::workspace_identity::assert_ssh_runtime_owner;

#[cfg(windows)]
const DIRECTORY_SCAN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SFTP_SCAN_CONCURRENCY: usize = 6;

/// 文件属性页使用的共享任务状态。
#[derive(Default)]
pub struct FilePropertiesState {
    scans: Mutex<ScanRegistry>,
}

#[derive(Default)]
struct ScanRegistry {
    active: HashMap<Uuid, CancellationToken>,
    pending_cancellations: HashSet<Uuid>,
}

/// 目录扫描注册守卫，确保命令被取消或异常终止时也会释放扫描 ID。
struct ScanRegistration<'a> {
    state: &'a FilePropertiesState,
    id: Uuid,
}

impl Drop for ScanRegistration<'_> {
    fn drop(&mut self) {
        self.state
            .scans
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active
            .remove(&self.id);
    }
}

/// 注册唯一扫描 ID，并返回与其生命周期绑定的取消令牌和清理守卫。
fn register_scan(
    state: &FilePropertiesState,
    id: Uuid,
) -> Result<(CancellationToken, ScanRegistration<'_>), String> {
    let cancellation = CancellationToken::new();
    let mut scans = state
        .scans
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if scans.active.contains_key(&id) {
        return Err("directory scan id is already active".into());
    }
    if scans.pending_cancellations.remove(&id) {
        cancellation.cancel();
    }
    scans.active.insert(id, cancellation.clone());
    drop(scans);
    Ok((cancellation, ScanRegistration { state, id }))
}

/// 属性页使用的文件系统对象类型。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PropertyKind {
    File,
    Directory,
    Symlink,
}

/// 按平台语义区分的只读访问属性。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AccessProperties {
    Posix {
        mode: u32,
        uid: Option<u32>,
        gid: Option<u32>,
        owner_name: Option<String>,
        group_name: Option<String>,
    },
    Windows {
        read_only: bool,
        owner_name: Option<String>,
    },
    Unavailable,
}

/// 文件或目录自身的快速属性快照。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilePropertiesSnapshot {
    pub path: String,
    pub name: String,
    pub kind: PropertyKind,
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: Option<u64>,
    pub created_at: Option<u64>,
    pub modified_at: Option<u64>,
    pub accessed_at: Option<u64>,
    pub changed_at: Option<u64>,
    pub access: AccessProperties,
}

/// 目录后代的递归汇总，不包含目录自身。
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySummary {
    pub files: u64,
    pub directories: u64,
    pub symlinks: u64,
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: Option<u64>,
    pub unreadable_entries: u64,
    pub complete: bool,
}

/// 读取当前 Workspace 中目标自身的属性。
pub async fn fs_properties_get(
    remote: &RemoteState,
    workspace: WorkspaceEnv,
    environment_key: String,
    path: String,
) -> Result<FilePropertiesSnapshot, String> {
    match &workspace {
        WorkspaceEnv::Ssh { profile_id } => {
            let remote_workspace = remote.manager.workspace(profile_id).await?;
            assert_ssh_runtime_owner(&workspace, &environment_key, &remote_workspace.profile)?;
            remote_snapshot(&path, &remote_workspace).await
        }
        WorkspaceEnv::Wsl { distro } => wsl_snapshot(distro, &path).await,
        WorkspaceEnv::Local => {
            let resolved = resolve_path(&path, &workspace);
            crate::runtime::spawn_blocking(move || local_snapshot(&path, &resolved))
                .await
                .map_err(|error| error.to_string())?
        }
    }
}

/// 启动一个可取消的目录递归汇总。
pub async fn fs_properties_scan(
    remote: &RemoteState,
    workspace: WorkspaceEnv,
    environment_key: String,
    state: &FilePropertiesState,
    path: String,
    scan_id: String,
) -> Result<DirectorySummary, String> {
    let id = Uuid::parse_str(&scan_id).map_err(|_| "invalid directory scan id".to_string())?;
    let (cancellation, _registration) = register_scan(state, id)?;

    async {
        match &workspace {
            WorkspaceEnv::Ssh { profile_id } => {
                let remote_workspace = remote.manager.workspace(profile_id).await?;
                assert_ssh_runtime_owner(&workspace, &environment_key, &remote_workspace.profile)?;
                ssh_scan(&path, remote_workspace, cancellation).await
            }
            WorkspaceEnv::Wsl { distro } => wsl_scan(distro, &path, cancellation).await,
            WorkspaceEnv::Local => {
                let resolved = resolve_path(&path, &workspace);
                crate::runtime::spawn_blocking(move || local_scan(&resolved, &cancellation))
                    .await
                    .map_err(|error| error.to_string())?
            }
        }
    }
    .await
}

/// 取消仍在运行的目录属性汇总。
pub fn fs_properties_scan_cancel(
    state: &FilePropertiesState,
    scan_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&scan_id).map_err(|_| "invalid directory scan id".to_string())?;
    cancel_scan(state, id);
    Ok(())
}

/// 取消活动扫描，或记录尚未注册扫描的提前取消请求。
fn cancel_scan(state: &FilePropertiesState, id: Uuid) {
    let mut scans = state
        .scans
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let cancellation = scans.active.get(&id).cloned();
    if let Some(cancellation) = cancellation {
        cancellation.cancel();
    } else {
        // IPC 命令可能并发调度，先到达的取消请求必须由稍后注册的扫描消费。
        scans.pending_cancellations.insert(id);
    }
}

fn display_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn system_time_millis(value: std::io::Result<SystemTime>) -> Option<u64> {
    value
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

/// 判断路径是否是递归扫描不得跟随的符号链接或 Windows 重解析点。
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn local_snapshot(path: &str, resolved: &Path) -> Result<FilePropertiesSnapshot, String> {
    let metadata = std::fs::symlink_metadata(resolved).map_err(|error| error.to_string())?;
    let kind = if is_link_like(&metadata) {
        PropertyKind::Symlink
    } else if metadata.is_dir() {
        PropertyKind::Directory
    } else {
        PropertyKind::File
    };
    #[cfg(unix)]
    let (allocated_size_bytes, changed_at, access) = {
        use std::os::unix::fs::MetadataExt;
        let changed_at = u64::try_from(metadata.ctime())
            .ok()
            .map(|seconds| seconds.saturating_mul(1000));
        (
            Some(metadata.blocks().saturating_mul(512)),
            changed_at,
            AccessProperties::Posix {
                mode: metadata.mode() & 0o7777,
                uid: Some(metadata.uid()),
                gid: Some(metadata.gid()),
                owner_name: None,
                group_name: None,
            },
        )
    };
    #[cfg(windows)]
    let (allocated_size_bytes, changed_at, access) = (
        None,
        None,
        AccessProperties::Windows {
            read_only: metadata.permissions().readonly(),
            owner_name: None,
        },
    );
    #[cfg(not(any(unix, windows)))]
    let (allocated_size_bytes, changed_at, access) = (None, None, AccessProperties::Unavailable);

    Ok(FilePropertiesSnapshot {
        path: path.to_string(),
        name: display_name(path),
        kind,
        logical_size_bytes: metadata.len(),
        allocated_size_bytes,
        created_at: system_time_millis(metadata.created()),
        modified_at: system_time_millis(metadata.modified()),
        accessed_at: system_time_millis(metadata.accessed()),
        changed_at,
        access,
    })
}

fn local_scan(root: &Path, cancellation: &CancellationToken) -> Result<DirectorySummary, String> {
    let metadata = std::fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link_like(&metadata) {
        return Err("directory scan target is not a directory".into());
    }
    let mut summary = DirectorySummary {
        allocated_size_bytes: if cfg!(unix) { Some(0) } else { None },
        complete: true,
        ..DirectorySummary::default()
    };
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        if cancellation.is_cancelled() {
            return Err("directory scan cancelled".into());
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                summary.unreadable_entries += 1;
                summary.complete = false;
                continue;
            }
        };
        for entry in entries {
            if cancellation.is_cancelled() {
                return Err("directory scan cancelled".into());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    summary.unreadable_entries += 1;
                    summary.complete = false;
                    continue;
                }
            };
            let metadata = match std::fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(_) => {
                    summary.unreadable_entries += 1;
                    summary.complete = false;
                    continue;
                }
            };
            if is_link_like(&metadata) {
                summary.symlinks += 1;
            } else if metadata.is_dir() {
                summary.directories += 1;
                pending.push(entry.path());
            } else {
                summary.files += 1;
                summary.logical_size_bytes =
                    summary.logical_size_bytes.saturating_add(metadata.len());
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    summary.allocated_size_bytes = summary
                        .allocated_size_bytes
                        .map(|size| size.saturating_add(metadata.blocks().saturating_mul(512)));
                }
                #[cfg(not(unix))]
                {
                    summary.allocated_size_bytes = None;
                }
            }
        }
    }
    Ok(summary)
}

async fn remote_snapshot(
    path: &str,
    workspace: &Arc<RemoteWorkspace>,
) -> Result<FilePropertiesSnapshot, String> {
    let metadata = remote::sftp::property_stat(workspace, path).await?;
    let kind = match metadata.kind {
        remote::sftp::RemoteEntryKind::File => PropertyKind::File,
        remote::sftp::RemoteEntryKind::Dir => PropertyKind::Directory,
        remote::sftp::RemoteEntryKind::Symlink => PropertyKind::Symlink,
    };
    let access = metadata
        .permissions
        .map(|mode| AccessProperties::Posix {
            mode,
            uid: metadata.uid,
            gid: metadata.gid,
            owner_name: metadata.user.filter(|value| !value.is_empty()),
            group_name: metadata.group.filter(|value| !value.is_empty()),
        })
        .unwrap_or(AccessProperties::Unavailable);
    Ok(FilePropertiesSnapshot {
        path: path.to_string(),
        name: display_name(path),
        kind,
        logical_size_bytes: metadata.size,
        allocated_size_bytes: None,
        created_at: None,
        modified_at: metadata.mtime,
        accessed_at: metadata.atime,
        changed_at: None,
        access,
    })
}

#[cfg(windows)]
async fn wsl_snapshot(distro: &str, path: &str) -> Result<FilePropertiesSnapshot, String> {
    use std::process::Stdio;

    crate::modules::workspace::validate_wsl_distro_name(distro)?;
    validate_posix_path(path)?;
    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("stat")
        .arg("--printf=TERAX_PROPERTIES_STAT_V1\\0%f\\0%s\\0%X\\0%Y\\0%Z\\0%W\\0%u\\0%g\\0%U\\0%G\\0%b\\0%B")
        .arg("--")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::modules::proc::hide_console(command.as_std_mut());
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| format!("WSL stat timed out: {path}"))?
        .map_err(|error| format!("start WSL stat: {error}"))?;
    if !output.status.success() {
        return Err(command_error("WSL stat", &output.stderr));
    }
    parse_wsl_snapshot(path, &output.stdout)
}

#[cfg(not(windows))]
async fn wsl_snapshot(_distro: &str, _path: &str) -> Result<FilePropertiesSnapshot, String> {
    Err("WSL properties are only available on Windows".into())
}

#[cfg(any(windows, test))]
fn parse_wsl_snapshot(path: &str, output: &[u8]) -> Result<FilePropertiesSnapshot, String> {
    let mut fields = output.split(|byte| *byte == 0);
    if fields.next() != Some(b"TERAX_PROPERTIES_STAT_V1".as_slice()) {
        return Err("WSL stat returned an invalid protocol marker".into());
    }
    let raw_mode = parse_radix_field(fields.next(), 16, "mode")?;
    let logical_size_bytes = parse_field(fields.next(), "size")?;
    let accessed_at = seconds_field(fields.next(), "access time")?;
    let modified_at = seconds_field(fields.next(), "modified time")?;
    let changed_at = seconds_field(fields.next(), "changed time")?;
    let created_at = seconds_field(fields.next(), "created time")?;
    let uid = parse_u32_field(fields.next(), "uid")?;
    let gid = parse_u32_field(fields.next(), "gid")?;
    let owner_name = text_field(fields.next(), "owner")?;
    let group_name = text_field(fields.next(), "group")?;
    let blocks = parse_field(fields.next(), "blocks")?;
    let block_size = parse_field(fields.next(), "block size")?;
    if fields.next().is_some() {
        return Err("WSL stat returned trailing fields".into());
    }
    let kind = match raw_mode & 0o170000 {
        0o040000 => PropertyKind::Directory,
        0o120000 => PropertyKind::Symlink,
        _ => PropertyKind::File,
    };
    Ok(FilePropertiesSnapshot {
        path: path.to_string(),
        name: display_name(path),
        kind,
        logical_size_bytes,
        allocated_size_bytes: Some(blocks.saturating_mul(block_size)),
        created_at,
        modified_at,
        accessed_at,
        changed_at,
        access: AccessProperties::Posix {
            mode: raw_mode & 0o7777,
            uid: Some(uid),
            gid: Some(gid),
            owner_name: Some(owner_name),
            group_name: Some(group_name),
        },
    })
}

#[cfg(windows)]
async fn wsl_scan(
    distro: &str,
    path: &str,
    cancellation: CancellationToken,
) -> Result<DirectorySummary, String> {
    use std::process::Stdio;

    crate::modules::workspace::validate_wsl_distro_name(distro)?;
    validate_posix_path(path)?;
    let command_text = posix_scan_script(path);
    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("bash")
        .arg("-c")
        .arg(command_text)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::modules::proc::hide_console(command.as_std_mut());
    let output = tokio::select! {
        _ = cancellation.cancelled() => return Err("directory scan cancelled".into()),
        output = tokio::time::timeout(DIRECTORY_SCAN_TIMEOUT, command.output()) => {
            output
                .map_err(|_| format!("WSL directory scan timed out: {path}"))?
                .map_err(|error| format!("start WSL directory scan: {error}"))?
        }
    };
    if matches!(output.status.code(), Some(72 | 126 | 127)) {
        let resolved = resolve_path(
            path,
            &WorkspaceEnv::Wsl {
                distro: distro.to_string(),
            },
        );
        return crate::runtime::spawn_blocking(move || local_scan(&resolved, &cancellation))
            .await
            .map_err(|error| error.to_string())?;
    }
    if output.status.code() == Some(73) {
        return Err("directory scan target is not a directory".into());
    }
    parse_scan_output(&output.stdout, &output.stderr, output.status.success())
}

#[cfg(not(windows))]
async fn wsl_scan(
    _distro: &str,
    _path: &str,
    _cancellation: CancellationToken,
) -> Result<DirectorySummary, String> {
    Err("WSL properties are only available on Windows".into())
}

/// 使用集中式 Bash 任务汇总 SSH 目录，能力不可用时回退并发 SFTP 遍历。
async fn ssh_scan(
    path: &str,
    workspace: Arc<RemoteWorkspace>,
    cancellation: CancellationToken,
) -> Result<DirectorySummary, String> {
    remote::session::validate_remote_path(path)?;
    let task = remote::tasks::TaskKind::TreeSummary;
    if workspace.tasks.should_attempt(task) {
        let output = remote::tasks::tree_summary::run(&workspace, path, &cancellation).await?;
        if output.timed_out {
            return Err(format!("remote directory scan timed out: {path}"));
        }
        if output.exit_code == Some(73) {
            return Err("directory scan target is not a directory".into());
        }
        if output.exit_code == Some(72) {
            workspace.mark_task_unavailable(task, "missing GNU find or awk");
        } else {
            match parse_scan_output(&output.stdout, &output.stderr, output.exit_code == Some(0)) {
                Ok(summary) => {
                    workspace.tasks.mark_available(task);
                    return Ok(summary);
                }
                Err(error) => workspace.mark_task_unavailable(task, error),
            }
        }
    }
    sftp_scan(path, workspace, cancellation).await
}

async fn sftp_scan(
    root: &str,
    workspace: Arc<RemoteWorkspace>,
    cancellation: CancellationToken,
) -> Result<DirectorySummary, String> {
    let mut summary = DirectorySummary {
        complete: true,
        ..DirectorySummary::default()
    };
    let mut queued = VecDeque::from([root.to_string()]);
    let mut pending = FuturesUnordered::new();
    loop {
        while pending.len() < SFTP_SCAN_CONCURRENCY {
            let Some(directory) = queued.pop_front() else {
                break;
            };
            let workspace = workspace.clone();
            pending.push(async move {
                let result = remote::sftp::read_dir(&workspace, &directory, true).await;
                (directory, result)
            });
        }
        if pending.is_empty() {
            break;
        }
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Err("directory scan cancelled".into()),
            result = pending.next() => result,
        };
        let Some((directory, entries)) = next else {
            break;
        };
        let entries = match entries {
            Ok(entries) => entries,
            Err(error) if directory == root => return Err(error),
            Err(_) => {
                summary.unreadable_entries += 1;
                summary.complete = false;
                continue;
            }
        };
        for entry in entries {
            match entry.kind {
                remote::sftp::RemoteEntryKind::Dir => {
                    summary.directories += 1;
                    queued.push_back(remote::session::join_remote(&directory, &entry.name));
                }
                remote::sftp::RemoteEntryKind::Symlink => summary.symlinks += 1,
                remote::sftp::RemoteEntryKind::File => {
                    summary.files += 1;
                    summary.logical_size_bytes =
                        summary.logical_size_bytes.saturating_add(entry.size);
                }
            }
        }
    }
    Ok(summary)
}

#[cfg(any(windows, test))]
fn posix_scan_script(path: &str) -> String {
    remote::tasks::tree_summary::script(path)
}

fn parse_scan_output(
    stdout: &[u8],
    stderr: &[u8],
    success: bool,
) -> Result<DirectorySummary, String> {
    let line = std::str::from_utf8(stdout)
        .map_err(|_| "directory scan output is not UTF-8")?
        .lines()
        .find(|line| line.starts_with("TERAX_PROPERTIES_SCAN_V1 "))
        .ok_or_else(|| "directory scan protocol marker is missing".to_string())?;
    let mut fields = line.split_ascii_whitespace();
    if fields.next() != Some("TERAX_PROPERTIES_SCAN_V1") {
        return Err("directory scan protocol marker is invalid".into());
    }
    let files = parse_text_u64(fields.next(), "files")?;
    let directories = parse_text_u64(fields.next(), "directories")?;
    let symlinks = parse_text_u64(fields.next(), "symlinks")?;
    let logical_size_bytes = parse_text_u64(fields.next(), "logical size")?;
    let allocated_size_bytes = parse_text_u64(fields.next(), "allocated size")?;
    if fields.next().is_some() {
        return Err("directory scan protocol has trailing fields".into());
    }
    let error_lines = String::from_utf8_lossy(stderr)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as u64;
    Ok(DirectorySummary {
        files,
        directories,
        symlinks,
        logical_size_bytes,
        allocated_size_bytes: Some(allocated_size_bytes),
        unreadable_entries: if success { 0 } else { error_lines.max(1) },
        complete: success,
    })
}

#[cfg(windows)]
fn validate_posix_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err("properties path must be an absolute POSIX path".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn parse_field(field: Option<&[u8]>, name: &str) -> Result<u64, String> {
    parse_text_u64(std::str::from_utf8(field.unwrap_or_default()).ok(), name)
}

#[cfg(any(windows, test))]
fn parse_radix_field(field: Option<&[u8]>, radix: u32, name: &str) -> Result<u32, String> {
    u32::from_str_radix(
        std::str::from_utf8(field.unwrap_or_default())
            .map_err(|_| format!("{name} is not UTF-8"))?,
        radix,
    )
    .map_err(|_| format!("{name} is invalid"))
}

#[cfg(any(windows, test))]
fn parse_u32_field(field: Option<&[u8]>, name: &str) -> Result<u32, String> {
    std::str::from_utf8(field.unwrap_or_default())
        .map_err(|_| format!("{name} is not UTF-8"))?
        .parse()
        .map_err(|_| format!("{name} is invalid"))
}

#[cfg(any(windows, test))]
fn seconds_field(field: Option<&[u8]>, name: &str) -> Result<Option<u64>, String> {
    let seconds = std::str::from_utf8(field.unwrap_or_default())
        .map_err(|_| format!("{name} is not UTF-8"))?
        .parse::<i64>()
        .map_err(|_| format!("{name} is invalid"))?;
    Ok(u64::try_from(seconds)
        .ok()
        .filter(|seconds| *seconds != 0)
        .map(|seconds| seconds.saturating_mul(1000)))
}

#[cfg(any(windows, test))]
fn text_field(field: Option<&[u8]>, name: &str) -> Result<String, String> {
    std::str::from_utf8(field.unwrap_or_default())
        .map(str::to_string)
        .map_err(|_| format!("{name} is not UTF-8"))
}

fn parse_text_u64(field: Option<&str>, name: &str) -> Result<u64, String> {
    field
        .ok_or_else(|| format!("{name} is missing"))?
        .parse()
        .map_err(|_| format!("{name} is invalid"))
}

#[cfg(windows)]
fn command_error(operation: &str, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        format!("{operation} failed")
    } else {
        format!("{operation} failed: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_protocol_preserves_partial_results() {
        let summary = parse_scan_output(
            b"TERAX_PROPERTIES_SCAN_V1 12 4 2 4096 8192\n",
            b"find: permission denied\n",
            false,
        )
        .unwrap();

        assert_eq!(summary.files, 12);
        assert_eq!(summary.directories, 4);
        assert_eq!(summary.symlinks, 2);
        assert_eq!(summary.logical_size_bytes, 4096);
        assert_eq!(summary.allocated_size_bytes, Some(8192));
        assert_eq!(summary.unreadable_entries, 1);
        assert!(!summary.complete);
    }

    #[test]
    fn unavailable_metadata_serializes_as_explicit_nulls() {
        let snapshot = FilePropertiesSnapshot {
            path: "C:/work/file.txt".into(),
            name: "file.txt".into(),
            kind: PropertyKind::File,
            logical_size_bytes: 4,
            allocated_size_bytes: None,
            created_at: None,
            modified_at: None,
            accessed_at: None,
            changed_at: None,
            access: AccessProperties::Windows {
                read_only: false,
                owner_name: None,
            },
        };
        let value = serde_json::to_value(snapshot).unwrap();

        assert!(value["allocatedSizeBytes"].is_null());
        assert!(value["createdAt"].is_null());
        assert!(value["access"]["ownerName"].is_null());
    }

    #[test]
    fn scan_script_quotes_path_and_uses_fixed_protocol() {
        let script = posix_scan_script("/work/a'b");

        assert!(script.starts_with("target_path='/work/a'\\''b';"));
        assert!(script.contains("exit 73"));
        assert!(script.contains("TERAX_PROPERTIES_SCAN_V1"));
        assert!(script.contains("find -P \"$target_path\""));
    }

    #[test]
    fn duplicate_scan_ids_are_rejected_until_the_guard_is_dropped() {
        let state = FilePropertiesState::default();
        let id = Uuid::new_v4();
        let (_, registration) = register_scan(&state, id).unwrap();

        assert!(register_scan(&state, id).is_err());
        drop(registration);
        assert!(register_scan(&state, id).is_ok());
    }

    #[test]
    fn cancellation_before_registration_cancels_the_later_scan() {
        let state = FilePropertiesState::default();
        let id = Uuid::new_v4();

        cancel_scan(&state, id);
        let (cancellation, _registration) = register_scan(&state, id).unwrap();

        assert!(cancellation.is_cancelled());
        assert!(state.scans.lock().unwrap().pending_cancellations.is_empty());
    }

    #[test]
    fn local_scan_does_not_follow_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let child = temp.path().join("child");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("file.txt"), b"hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&child, temp.path().join("link")).unwrap();
        #[cfg(windows)]
        junction::create(&child, temp.path().join("link")).unwrap();

        let summary = local_scan(temp.path(), &CancellationToken::new()).unwrap();
        assert_eq!(summary.directories, 1);
        assert_eq!(summary.files, 1);
        assert_eq!(summary.symlinks, 1);
        assert_eq!(summary.logical_size_bytes, 5);
    }

    #[test]
    fn cancelled_local_scan_stops_before_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            local_scan(temp.path(), &cancellation).unwrap_err(),
            "directory scan cancelled"
        );
    }

    #[test]
    fn wsl_stat_protocol_maps_posix_metadata() {
        let output = [
            b"TERAX_PROPERTIES_STAT_V1".as_slice(),
            b"41ed",
            b"10",
            b"-10",
            b"20",
            b"30",
            b"0",
            b"1000",
            b"1001",
            b"alice",
            b"staff",
            b"8",
            b"512",
        ]
        .join(&0);
        let snapshot = parse_wsl_snapshot("/work/demo", &output).unwrap();

        assert_eq!(snapshot.kind, PropertyKind::Directory);
        assert_eq!(snapshot.logical_size_bytes, 10);
        assert_eq!(snapshot.allocated_size_bytes, Some(4096));
        assert_eq!(snapshot.accessed_at, None);
        assert_eq!(snapshot.modified_at, Some(20_000));
        assert_eq!(
            snapshot.access,
            AccessProperties::Posix {
                mode: 0o755,
                uid: Some(1000),
                gid: Some(1001),
                owner_name: Some("alice".into()),
                group_name: Some("staff".into()),
            }
        );
    }
}
