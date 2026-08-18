//! 工作区文件的读取、原子写入与版本校验。
//!
//! 编辑器和 AI 文件工具以内容摘要作为磁盘版本，并通过条件写入避免静默覆盖外部修改。

use std::path::Path;
use std::time::UNIX_EPOCH;
use std::{fs, io::Read, io::Write};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tempfile::NamedTempFile;

use crate::modules::remote::{self, RemoteState};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// 显式强制打开的上限，与前端 `FORCE_READ_LIMIT` 保持一致。
const FORCE_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[cfg(windows)]
const WSL_ATOMIC_WRITE_SCRIPT: &str =
    "if [ -e \"$1\" ]; then chmod --reference=\"$1\" \"$2\" || exit 74; fi; \
    mv -f -- \"$2\" \"$1\"";
#[cfg(windows)]
const WSL_CHECKED_WRITE_SCRIPT: &str = "if [ ! -f \"$1\" ]; then printf missing; exit 0; fi; \
    actual=$(sha256sum -- \"$1\") || exit 73; actual=${actual%% *}; \
    if [ \"$actual\" = \"$3\" ]; then rm -f -- \"$4\" && printf converged; \
    elif [ \"$actual\" != \"$2\" ]; then printf conflict; \
    else chmod --reference=\"$1\" \"$4\" && mv -f -- \"$4\" \"$1\" && printf written; fi";
#[cfg(windows)]
const WSL_MISSING_WRITE_SCRIPT: &str =
    "if [ -e \"$1\" ] || [ -L \"$1\" ]; then rm -f -- \"$2\"; printf conflict; exit 0; fi; \
    if ln -- \"$2\" \"$1\" 2>/dev/null; then rm -f -- \"$2\"; printf written; \
    elif [ -e \"$1\" ] || [ -L \"$1\" ]; then rm -f -- \"$2\"; printf conflict; \
    else rm -f -- \"$2\"; exit 74; fi";

/// 将可能阻塞的本地磁盘访问和 WSL 进程调用移出异步执行器。
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

/// 文本读取结果携带原始字节内容对应的版本，元数据只用于展示和远程轮询。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        mtime: u64,
        revision: String,
    },
    Binary {
        size: u64,
        mtime: u64,
    },
    /// 文件超过当前读取上限，由前端决定是否允许强制打开。
    TooLarge {
        size: u64,
        limit: u64,
        mtime: u64,
    },
}

/// 编辑器已确认的磁盘内容版本。
#[derive(Deserialize, Serialize)]
pub struct FileVersion {
    pub revision: String,
    pub size: u64,
    pub mtime: u64,
}

/// 条件写入观察到的当前文件元数据。
#[derive(Serialize)]
pub struct ObservedMetadata {
    pub size: u64,
    pub mtime: u64,
}

/// 文件写入条件。覆盖和仅缺失时创建都必须由调用方显式声明。
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WriteCondition {
    Match { version: FileVersion },
    Missing,
    Overwrite,
}

/// 编辑器条件写入的结果。
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CheckedWriteResult {
    Written {
        revision: String,
        size: u64,
        mtime: u64,
    },
    Conflict {
        current: Option<ObservedMetadata>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
}

#[derive(Serialize)]
pub struct BinaryReadResult {
    pub bytes: Vec<u8>,
    pub size: u64,
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 计算文件原始字节的稳定版本，避免把仅更新时间戳的写回误判为内容变化。
fn content_revision(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn observed_metadata(meta: &fs::Metadata) -> ObservedMetadata {
    ObservedMetadata {
        size: meta.len(),
        mtime: mtime_millis(meta),
    }
}

struct LocalObservation {
    revision: Option<String>,
    metadata: ObservedMetadata,
}

/// 有界地计算本地文件摘要，并拒绝读取期间发生变化的快照。
fn observe_local_file(target: &Path) -> Result<Option<LocalObservation>, String> {
    let mut file = match fs::File::open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let before = file.metadata().map_err(|error| error.to_string())?;
    if before.len() > FORCE_MAX_READ_BYTES {
        return Ok(Some(LocalObservation {
            revision: None,
            metadata: observed_metadata(&before),
        }));
    }

    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        size = size.saturating_add(read as u64);
        if size > FORCE_MAX_READ_BYTES {
            let metadata = fs::metadata(target).unwrap_or(before);
            return Ok(Some(LocalObservation {
                revision: None,
                metadata: observed_metadata(&metadata),
            }));
        }
        hasher.update(&buffer[..read]);
    }

    let after = match fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if size != after.len() || mtime_millis(&before) != mtime_millis(&after) {
        return Ok(Some(LocalObservation {
            revision: None,
            metadata: observed_metadata(&after),
        }));
    }
    Ok(Some(LocalObservation {
        revision: Some(format!("{:x}", hasher.finalize())),
        metadata: ObservedMetadata {
            size,
            mtime: mtime_millis(&after),
        },
    }))
}

fn is_sha256(revision: &str) -> bool {
    revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_version(version: &FileVersion) -> Result<(), String> {
    if is_sha256(&version.revision) && version.size <= FORCE_MAX_READ_BYTES {
        Ok(())
    } else {
        Err("invalid file version".into())
    }
}

/// 读取文件并为文本内容返回基于原始字节的稳定版本。
#[tauri::command]
pub async fn fs_read_file(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let workspace = remote.manager.workspace(profile_id).await?;
        let limit = if force.unwrap_or(false) {
            FORCE_MAX_READ_BYTES
        } else {
            MAX_READ_BYTES
        };
        return match remote::file_service::read_snapshot(&workspace, &path, limit).await? {
            remote::file_service::RemoteFileRead::TooLarge { size, mtime } => {
                Ok(ReadResult::TooLarge { size, limit, mtime })
            }
            remote::file_service::RemoteFileRead::Content { bytes, mtime, .. } => {
                classify_bytes(bytes, mtime)
            }
        };
    }
    read_file_sync(&resolve_path(&path, &workspace), force.unwrap_or(false))
}

#[tauri::command]
pub async fn fs_read_binary(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<BinaryReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let workspace = remote.manager.workspace(profile_id).await?;
        return match remote::file_service::read_snapshot(&workspace, &path, MAX_READ_BYTES).await? {
            remote::file_service::RemoteFileRead::TooLarge { size, .. } => {
                Err(format!("file is too large: {size} bytes"))
            }
            remote::file_service::RemoteFileRead::Content { bytes, size, .. } => {
                Ok(BinaryReadResult { size, bytes })
            }
        };
    }

    read_binary_sync(&resolve_path(&path, &workspace))
}

/// 在数据源端计算当前文件版本，不传输文件正文。
#[tauri::command]
pub async fn fs_file_version(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Option<FileVersion>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let workspace = remote.manager.workspace(profile_id).await?;
        return remote::file_service::read_version(&workspace, &path, FORCE_MAX_READ_BYTES)
            .await
            .map(|version| {
                version.map(|value| FileVersion {
                    revision: value.revision,
                    size: value.size,
                    mtime: value.mtime,
                })
            });
    }

    run_blocking(move || file_version_sync(&path, &workspace)).await
}

/// 在本地或 WSL 数据源计算稳定文件版本。
fn file_version_sync(path: &str, workspace: &WorkspaceEnv) -> Result<Option<FileVersion>, String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        let target = resolve_path(path, workspace);
        let before = match fs::metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if before.len() > FORCE_MAX_READ_BYTES {
            return Err(format!(
                "WSL file exceeds version limit: {FORCE_MAX_READ_BYTES}"
            ));
        }
        let revision = wsl_sha256(distro, path)?;
        let after = fs::metadata(&target).map_err(|error| error.to_string())?;
        if before.len() != after.len() || mtime_millis(&before) != mtime_millis(&after) {
            return Err("WSL file changed while computing its revision".into());
        }
        return Ok(Some(FileVersion {
            revision,
            size: after.len(),
            mtime: mtime_millis(&after),
        }));
    }

    let observed = observe_local_file(&resolve_path(path, workspace))?;
    observed
        .map(|value| {
            let revision = value
                .revision
                .ok_or_else(|| "file changed while computing its revision".to_string())?;
            Ok(FileVersion {
                revision,
                size: value.metadata.size,
                mtime: value.metadata.mtime,
            })
        })
        .transpose()
}

/// 将受大小限制保护的字节分类为文本或二进制读取结果。
fn classify_bytes(bytes: Vec<u8>, mtime: u64) -> Result<ReadResult, String> {
    let size = bytes.len() as u64;
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size, mtime });
    }
    match String::from_utf8(bytes) {
        Ok(content) => {
            let revision = content_revision(content.as_bytes());
            Ok(ReadResult::Text {
                content,
                size,
                mtime,
                revision,
            })
        }
        Err(_) => Ok(ReadResult::Binary { size, mtime }),
    }
}

/// 最多读取上限后的一个额外字节，避免文件在元数据检查后增长导致无界分配。
fn read_local_bounded(path: &Path, limit: u64, size_hint: u64) -> std::io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let capacity = size_hint.min(limit).min(1024 * 1024) as usize;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// 读取本地文件，并在读取期间文件增长时再次执行大小上限检查。
fn read_file_sync(p: &Path, force: bool) -> Result<ReadResult, String> {
    let meta = std::fs::metadata(p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    let limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    if size > limit {
        return Ok(ReadResult::TooLarge {
            size,
            limit,
            mtime: mtime_millis(&meta),
        });
    }

    let bytes = read_local_bounded(p, limit, size).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    if bytes.len() as u64 > limit {
        let metadata = fs::metadata(p).unwrap_or(meta);
        return Ok(ReadResult::TooLarge {
            size: metadata.len().max(bytes.len() as u64),
            limit,
            mtime: mtime_millis(&metadata),
        });
    }
    let mtime = fs::metadata(p)
        .map(|metadata| mtime_millis(&metadata))
        .unwrap_or_else(|_| mtime_millis(&meta));
    classify_bytes(bytes, mtime)
}

fn read_binary_sync(p: &Path) -> Result<BinaryReadResult, String> {
    let meta = std::fs::metadata(p).map_err(|e| {
        log::debug!("fs_read_binary stat({}) failed: {e}", p.display());
        e.to_string()
    })?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("file is too large: {} bytes", meta.len()));
    }
    let bytes = read_local_bounded(p, MAX_READ_BYTES, meta.len()).map_err(|e| {
        log::debug!("fs_read_binary read({}) failed: {e}", p.display());
        e.to_string()
    })?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(format!("file is too large: at least {} bytes", bytes.len()));
    }
    Ok(BinaryReadResult {
        size: bytes.len() as u64,
        bytes,
    })
}

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// 在目标目录创建并同步排他临时文件，随机文件名阻止预置符号链接攻击。
fn stage_local_write(target: &Path, content: &[u8]) -> std::io::Result<NamedTempFile> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    if let Ok(metadata) = fs::metadata(target) {
        fs::set_permissions(tmp.path(), metadata.permissions())?;
    }
    Ok(tmp)
}

/// 将已同步的临时文件原子替换到目标路径。
fn commit_local_write(staged: NamedTempFile, target: &Path) -> std::io::Result<u64> {
    staged.persist(target).map_err(|error| error.error)?;
    Ok(fs::metadata(target)
        .map(|metadata| mtime_millis(&metadata))
        .unwrap_or(0))
}

fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<u64> {
    commit_local_write(stage_local_write(target, content)?, target)
}

/// 在保留已有权限的同时原子替换本地文件，并返回新的修改时间。
fn write_local(target: &Path, content: &[u8]) -> Result<u64, String> {
    write_atomic(target, content).map_err(|error| {
        log::warn!("fs write({}) failed: {error}", target.display());
        error.to_string()
    })
}

/// 不校验旧版本地写入，并返回供编辑器建立新基线的版本。
fn overwrite_local(target: &Path, content: &[u8]) -> Result<CheckedWriteResult, String> {
    let mtime = write_local(target, content)?;
    Ok(CheckedWriteResult::Written {
        revision: content_revision(content),
        size: content.len() as u64,
        mtime,
    })
}

/// 仅在本地目标仍不存在时发布已同步的临时文件。
fn missing_write_sync(target: &Path, content: &[u8]) -> Result<CheckedWriteResult, String> {
    let revision = content_revision(content);
    let staged = stage_local_write(target, content).map_err(|error| error.to_string())?;
    let persisted = match staged.persist_noclobber(target) {
        Ok(file) => file,
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Ok(CheckedWriteResult::Conflict {
                current: fs::metadata(target)
                    .ok()
                    .map(|metadata| observed_metadata(&metadata)),
            });
        }
        Err(error) => return Err(error.error.to_string()),
    };
    drop(persisted);
    let metadata = fs::metadata(target).map_err(|error| error.to_string())?;
    Ok(CheckedWriteResult::Written {
        revision,
        size: metadata.len(),
        mtime: mtime_millis(&metadata),
    })
}

/// 校验本地文件的内容版本后原子写入。
fn checked_write_sync(
    target: &Path,
    content: &[u8],
    expected: &FileVersion,
) -> Result<CheckedWriteResult, String> {
    let new_revision = content_revision(content);

    let metadata = match fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CheckedWriteResult::Conflict { current: None });
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() != expected.size {
        return Ok(CheckedWriteResult::Conflict {
            current: Some(observed_metadata(&metadata)),
        });
    }
    if mtime_millis(&metadata) != expected.mtime {
        let current = observe_local_file(target)?;
        if current.as_ref().and_then(|value| value.revision.as_deref())
            == Some(new_revision.as_str())
        {
            if let Some(current) = current {
                return Ok(CheckedWriteResult::Written {
                    revision: new_revision,
                    size: current.metadata.size,
                    mtime: current.metadata.mtime,
                });
            }
        }
        if current.as_ref().and_then(|value| value.revision.as_deref())
            != Some(expected.revision.as_str())
        {
            return Ok(CheckedWriteResult::Conflict {
                current: current.map(|value| value.metadata),
            });
        }
    }

    let staged = stage_local_write(target, content).map_err(|error| error.to_string())?;
    let current = observe_local_file(target)?;
    if current.as_ref().and_then(|value| value.revision.as_deref()) == Some(new_revision.as_str()) {
        if let Some(current) = current {
            return Ok(CheckedWriteResult::Written {
                revision: new_revision,
                size: current.metadata.size,
                mtime: current.metadata.mtime,
            });
        }
    }
    if current.as_ref().and_then(|value| value.revision.as_deref())
        != Some(expected.revision.as_str())
    {
        return Ok(CheckedWriteResult::Conflict {
            current: current.map(|value| value.metadata),
        });
    }

    let mtime = commit_local_write(staged, target).map_err(|error| error.to_string())?;
    Ok(CheckedWriteResult::Written {
        revision: new_revision,
        size: content.len() as u64,
        mtime,
    })
}

#[cfg(windows)]
fn parse_sha256_text(output: &str) -> Result<String, String> {
    let revision = output
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "WSL SHA-256 output is invalid".to_string())?;
    Ok(revision.to_ascii_lowercase())
}

#[cfg(windows)]
fn wsl_sha256(distro: &str, path: &str) -> Result<String, String> {
    let output = crate::modules::workspace::wsl_exec_capture(distro, "sha256sum", &["--", path])?;
    parse_sha256_text(&output)
}

#[cfg(windows)]
fn wsl_temporary_path(path: &str, staged: &NamedTempFile) -> Result<String, String> {
    let name = staged
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "WSL temporary filename is invalid".to_string())?;
    let path = path.replace('\\', "/");
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(".");
    Ok(if parent.is_empty() {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    })
}

/// 在 WSL 内复制原文件权限并原子替换临时文件。
#[cfg(windows)]
fn write_wsl_atomic(
    distro: &str,
    path: &str,
    target: &Path,
    content: &[u8],
) -> Result<u64, String> {
    let staged = stage_local_write(target, content).map_err(|error| error.to_string())?;
    let temporary = wsl_temporary_path(path, &staged)?;
    let temporary_guard = staged.into_temp_path();
    let output = crate::modules::workspace::wsl_exec_capture(
        distro,
        "sh",
        &["-c", WSL_ATOMIC_WRITE_SCRIPT, "terax", path, &temporary],
    );
    drop(temporary_guard);
    output?;
    let metadata = fs::metadata(target).map_err(|error| error.to_string())?;
    Ok(mtime_millis(&metadata))
}

/// 显式覆盖 WSL 文件，并返回新的内容版本。
#[cfg(windows)]
fn overwrite_wsl(
    distro: &str,
    path: &str,
    target: &Path,
    content: &[u8],
) -> Result<CheckedWriteResult, String> {
    let mtime = write_wsl_atomic(distro, path, target, content)?;
    Ok(CheckedWriteResult::Written {
        revision: content_revision(content),
        size: content.len() as u64,
        mtime,
    })
}

/// 仅在 WSL 目标仍不存在时使用同目录硬链接原子发布临时文件。
#[cfg(windows)]
fn missing_write_wsl_sync(
    distro: &str,
    path: &str,
    target: &Path,
    content: &[u8],
) -> Result<CheckedWriteResult, String> {
    let staged = stage_local_write(target, content).map_err(|error| error.to_string())?;
    let temporary = wsl_temporary_path(path, &staged)?;
    let temporary_guard = staged.into_temp_path();
    let output = crate::modules::workspace::wsl_exec_capture(
        distro,
        "sh",
        &["-c", WSL_MISSING_WRITE_SCRIPT, "terax", path, &temporary],
    );
    drop(temporary_guard);
    match output?.trim() {
        "written" => {
            let metadata = fs::metadata(target).map_err(|error| error.to_string())?;
            Ok(CheckedWriteResult::Written {
                revision: content_revision(content),
                size: metadata.len(),
                mtime: mtime_millis(&metadata),
            })
        }
        "conflict" => Ok(CheckedWriteResult::Conflict {
            current: fs::metadata(target)
                .ok()
                .map(|metadata| observed_metadata(&metadata)),
        }),
        _ => Err("WSL missing-only write returned an invalid status".into()),
    }
}

/// 在 WSL 发行版内完成最终摘要比较和替换，避免把旧文件读回 Windows。
#[cfg(windows)]
fn checked_write_wsl_sync(
    distro: &str,
    path: &str,
    target: &Path,
    content: &[u8],
    expected: &FileVersion,
) -> Result<CheckedWriteResult, String> {
    let replacement_revision = content_revision(content);
    let metadata = match fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CheckedWriteResult::Conflict { current: None });
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() != expected.size {
        return Ok(CheckedWriteResult::Conflict {
            current: Some(observed_metadata(&metadata)),
        });
    }
    if mtime_millis(&metadata) != expected.mtime {
        let revision = wsl_sha256(distro, path)?;
        let current = match fs::metadata(target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CheckedWriteResult::Conflict { current: None });
            }
            Err(error) => return Err(error.to_string()),
        };
        if metadata.len() != current.len() || mtime_millis(&metadata) != mtime_millis(&current) {
            return Ok(CheckedWriteResult::Conflict {
                current: Some(observed_metadata(&current)),
            });
        }
        if revision == replacement_revision {
            return Ok(CheckedWriteResult::Written {
                revision,
                size: current.len(),
                mtime: mtime_millis(&current),
            });
        }
        if revision != expected.revision {
            return Ok(CheckedWriteResult::Conflict {
                current: Some(observed_metadata(&current)),
            });
        }
    }

    let staged = stage_local_write(target, content).map_err(|error| error.to_string())?;
    let temporary = wsl_temporary_path(path, &staged)?;
    let temporary_guard = staged.into_temp_path();
    let output = crate::modules::workspace::wsl_exec_capture(
        distro,
        "sh",
        &[
            "-c",
            WSL_CHECKED_WRITE_SCRIPT,
            "terax",
            path,
            &expected.revision,
            &replacement_revision,
            &temporary,
        ],
    );
    drop(temporary_guard);
    let output = output?;
    match output.trim() {
        "written" | "converged" => {
            let metadata = fs::metadata(target).map_err(|error| error.to_string())?;
            Ok(CheckedWriteResult::Written {
                revision: replacement_revision,
                size: metadata.len(),
                mtime: mtime_millis(&metadata),
            })
        }
        "missing" => Ok(CheckedWriteResult::Conflict { current: None }),
        "conflict" => {
            let current = fs::metadata(target).ok().map(|metadata| ObservedMetadata {
                size: metadata.len(),
                mtime: mtime_millis(&metadata),
            });
            Ok(CheckedWriteResult::Conflict { current })
        }
        _ => Err("WSL checked replace returned an invalid status".into()),
    }
}

fn emit_file_written(app: &tauri::AppHandle, path: &str, source: Option<String>) {
    let _ = app.emit(
        "fs:file-written",
        FileWrittenEvent {
            path: path.to_string(),
            source,
        },
    );
}

/// 无条件原子写入文件，供创建文件、主题和已审批的工具操作使用。
#[tauri::command]
pub async fn fs_write_file(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let workspace = remote.manager.workspace(profile_id).await?;
        let bytes = content.as_bytes();
        let replacement_revision = content_revision(bytes);
        let mtime =
            remote::file_service::write_overwrite(&workspace, &path, bytes, &replacement_revision)
                .await?;
        emit_file_written(&app, &path, source);
        return Ok(mtime);
    }
    let write_path = path.clone();
    let mtime = run_blocking(move || {
        let target = resolve_path(&write_path, &workspace);
        #[cfg(windows)]
        if let WorkspaceEnv::Wsl { distro } = &workspace {
            return write_wsl_atomic(distro, &write_path, &target, content.as_bytes());
        }
        write_local(&target, content.as_bytes())
    })
    .await?;
    emit_file_written(&app, &path, source);

    Ok(mtime)
}

/// 按内容版本或缺失条件写入编辑器与 AI 工具文件。
///
/// 普通保存必须显式匹配最近读取或成功写入的版本；新文件和覆盖也必须显式声明。
#[tauri::command]
pub async fn fs_write_file_checked(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    content: String,
    condition: WriteCondition,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<CheckedWriteResult, String> {
    if let WriteCondition::Match { version } = &condition {
        validate_version(version)?;
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    let result = if let Some(profile_id) = workspace.ssh_profile_id() {
        let bytes = content.as_bytes();
        let replacement_revision = content_revision(bytes);
        let workspace = remote.manager.workspace(profile_id).await?;
        match &condition {
            WriteCondition::Match { version } => {
                let expected = remote::file_service::RemoteVersion {
                    revision: version.revision.clone(),
                    size: version.size,
                    mtime: version.mtime,
                };
                match remote::file_service::write_checked(
                    &workspace,
                    &path,
                    bytes,
                    &expected,
                    &replacement_revision,
                )
                .await?
                {
                    remote::file_service::RemoteCheckedWrite::Written { mtime } => {
                        CheckedWriteResult::Written {
                            revision: replacement_revision,
                            size: bytes.len() as u64,
                            mtime,
                        }
                    }
                    remote::file_service::RemoteCheckedWrite::Conflict { current } => {
                        CheckedWriteResult::Conflict {
                            current: current.map(|value| ObservedMetadata {
                                size: value.size,
                                mtime: value.mtime,
                            }),
                        }
                    }
                }
            }
            WriteCondition::Missing => {
                match remote::file_service::write_missing(
                    &workspace,
                    &path,
                    bytes,
                    &replacement_revision,
                )
                .await?
                {
                    remote::file_service::RemoteCheckedWrite::Written { mtime } => {
                        CheckedWriteResult::Written {
                            revision: replacement_revision,
                            size: bytes.len() as u64,
                            mtime,
                        }
                    }
                    remote::file_service::RemoteCheckedWrite::Conflict { current } => {
                        CheckedWriteResult::Conflict {
                            current: current.map(|value| ObservedMetadata {
                                size: value.size,
                                mtime: value.mtime,
                            }),
                        }
                    }
                }
            }
            WriteCondition::Overwrite => {
                let mtime = remote::file_service::write_overwrite(
                    &workspace,
                    &path,
                    bytes,
                    &replacement_revision,
                )
                .await?;
                CheckedWriteResult::Written {
                    revision: replacement_revision,
                    size: bytes.len() as u64,
                    mtime,
                }
            }
        }
    } else {
        let write_path = path.clone();
        run_blocking(move || {
            let bytes = content.as_bytes();
            let target = resolve_path(&write_path, &workspace);
            #[cfg(windows)]
            {
                match (&workspace, &condition) {
                    (WorkspaceEnv::Wsl { distro }, WriteCondition::Match { version }) => {
                        checked_write_wsl_sync(distro, &write_path, &target, bytes, version)
                    }
                    (WorkspaceEnv::Wsl { distro }, WriteCondition::Missing) => {
                        missing_write_wsl_sync(distro, &write_path, &target, bytes)
                    }
                    (WorkspaceEnv::Wsl { distro }, WriteCondition::Overwrite) => {
                        overwrite_wsl(distro, &write_path, &target, bytes)
                    }
                    (_, WriteCondition::Match { version }) => {
                        checked_write_sync(&target, bytes, version)
                    }
                    (_, WriteCondition::Missing) => missing_write_sync(&target, bytes),
                    (_, WriteCondition::Overwrite) => overwrite_local(&target, bytes),
                }
            }
            #[cfg(not(windows))]
            {
                match &condition {
                    WriteCondition::Match { version } => {
                        checked_write_sync(&target, bytes, version)
                    }
                    WriteCondition::Missing => missing_write_sync(&target, bytes),
                    WriteCondition::Overwrite => overwrite_local(&target, bytes),
                }
            }
        })
        .await?
    };

    if matches!(&result, CheckedWriteResult::Written { .. }) {
        emit_file_written(&app, &path, source);
    }
    Ok(result)
}

#[tauri::command]
pub async fn fs_canonicalize(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let workspace = remote.manager.workspace(profile_id).await?;
        return remote::sftp::canonicalize(&workspace, &path).await;
    }
    let p = resolve_path(&path, &workspace);
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    Ok(super::to_canon(&canon))
}

#[tauri::command]
pub async fn fs_stat(
    remote: tauri::State<'_, RemoteState>,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<FileStat, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let workspace = remote.manager.workspace(profile_id).await?;
        let meta = remote::sftp::stat(&workspace, &path).await?;
        let kind = match meta.kind {
            remote::sftp::RemoteEntryKind::File => StatKind::File,
            remote::sftp::RemoteEntryKind::Dir => StatKind::Dir,
            remote::sftp::RemoteEntryKind::Symlink => StatKind::Symlink,
        };
        return Ok(FileStat {
            size: meta.size,
            mtime: meta.mtime,
            kind,
        });
    }
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    // fs::metadata follows symlinks, so the link check needs symlink_metadata.
    let kind = if std::fs::symlink_metadata(&p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        StatKind::Symlink
    } else if meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    Ok(FileStat {
        size: meta.len(),
        mtime: mtime_millis(&meta),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(path: &Path, content: &[u8]) -> FileVersion {
        let metadata = fs::metadata(path).unwrap();
        FileVersion {
            revision: content_revision(content),
            size: content.len() as u64,
            mtime: mtime_millis(&metadata),
        }
    }

    #[test]
    fn read_file_classifies_utf8_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"hello world").unwrap();
        match read_file_sync(&f, false).unwrap() {
            ReadResult::Text {
                content,
                size,
                mtime,
                revision,
            } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0);
                assert_eq!(revision, content_revision(b"hello world"));
            }
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn read_file_detects_binary_via_null_byte() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"PNG\0\x89image").unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_file_detects_binary_via_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        // Invalid UTF-8 with no null byte: must still classify as binary.
        std::fs::write(&f, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_binary_returns_exact_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.png");
        let expected = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
        std::fs::write(&f, expected).unwrap();

        let result = read_binary_sync(&f).unwrap();
        assert_eq!(result.bytes, expected);
        assert_eq!(result.size, expected.len() as u64);
    }

    #[test]
    fn force_lifts_the_default_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.txt");
        std::fs::write(&f, vec![b'a'; (MAX_READ_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false).unwrap(),
            ReadResult::TooLarge { .. }
        ));
        assert!(matches!(
            read_file_sync(&f, true).unwrap(),
            ReadResult::Text { .. }
        ));
    }

    #[test]
    fn bounded_local_read_stops_after_the_limit_marker() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("growing.txt");
        std::fs::write(&target, b"0123456789").unwrap();

        let bytes = read_local_bounded(&target, 4, 10).unwrap();

        assert_eq!(bytes, b"01234");
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn checked_write_accepts_identical_disk_content_after_external_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"base").unwrap();
        let expected = version(&target, b"base");
        std::fs::write(&target, b"base").unwrap();

        let result = checked_write_sync(&target, b"local", &expected).unwrap();

        assert!(matches!(result, CheckedWriteResult::Written { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"local");
    }

    #[test]
    fn checked_write_returns_current_version_without_overwriting_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"base").unwrap();
        let expected = version(&target, b"base");
        std::fs::write(&target, b"evil").unwrap();

        let result = checked_write_sync(&target, b"local", &expected).unwrap();

        match result {
            CheckedWriteResult::Conflict {
                current: Some(current),
            } => {
                assert_eq!(current.size, 4);
            }
            _ => panic!("expected conflict"),
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"evil");
    }

    #[test]
    fn checked_write_rejects_size_change_without_hashing_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"base").unwrap();
        let expected = version(&target, b"base");
        std::fs::write(&target, b"external").unwrap();

        let result = checked_write_sync(&target, b"local", &expected).unwrap();

        match result {
            CheckedWriteResult::Conflict {
                current: Some(current),
            } => {
                assert_eq!(current.size, 8);
            }
            _ => panic!("expected metadata conflict"),
        }
    }

    #[test]
    fn local_observation_does_not_read_files_above_the_editor_limit() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("large.txt");
        std::fs::File::create(&target)
            .unwrap()
            .set_len(FORCE_MAX_READ_BYTES + 1)
            .unwrap();

        let observed = observe_local_file(&target).unwrap().unwrap();

        assert_eq!(observed.metadata.size, FORCE_MAX_READ_BYTES + 1);
        assert_eq!(observed.revision, None);
    }

    #[test]
    fn explicit_unchecked_write_overwrites_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"external").unwrap();

        let mtime = write_local(&target, b"local").unwrap();

        assert!(mtime > 0);
        assert_eq!(std::fs::read(&target).unwrap(), b"local");
    }

    #[test]
    fn missing_write_creates_once_without_overwriting_a_new_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");

        let created = missing_write_sync(&target, b"approved").unwrap();
        assert!(matches!(created, CheckedWriteResult::Written { .. }));

        let conflict = missing_write_sync(&target, b"overwrite").unwrap();
        assert!(matches!(conflict, CheckedWriteResult::Conflict { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"approved");
    }

    #[test]
    fn rejects_invalid_file_revisions() {
        let invalid = FileVersion {
            revision: "not-a-digest".into(),
            size: 1,
            mtime: 1,
        };

        assert!(validate_version(&invalid).is_err());
    }

    #[test]
    fn rejects_versions_above_the_bounded_read_limit() {
        let invalid = FileVersion {
            revision: "a".repeat(64),
            size: FORCE_MAX_READ_BYTES + 1,
            mtime: 1,
        };

        assert!(validate_version(&invalid).is_err());
    }

    #[test]
    fn write_condition_must_explicitly_match_create_or_overwrite() {
        assert!(serde_json::from_value::<WriteCondition>(serde_json::json!({})).is_err());
        assert!(matches!(
            serde_json::from_value::<WriteCondition>(serde_json::json!({
                "type": "missing"
            }))
            .unwrap(),
            WriteCondition::Missing
        ));
        assert!(matches!(
            serde_json::from_value::<WriteCondition>(serde_json::json!({
                "type": "overwrite"
            }))
            .unwrap(),
            WriteCondition::Overwrite
        ));
    }

    #[cfg(windows)]
    #[test]
    fn wsl_replacements_preserve_target_permissions() {
        assert!(WSL_ATOMIC_WRITE_SCRIPT.contains("chmod --reference=\"$1\" \"$2\""));
        assert!(WSL_CHECKED_WRITE_SCRIPT.contains("chmod --reference=\"$1\" \"$4\""));
        assert!(WSL_CHECKED_WRITE_SCRIPT.contains("&& mv -f -- \"$4\" \"$1\""));
        assert!(WSL_MISSING_WRITE_SCRIPT.contains("ln -- \"$2\" \"$1\""));
        assert!(WSL_MISSING_WRITE_SCRIPT.contains("[ -L \"$1\" ]"));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_legacy_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();

        let target = dir.path().join("note.txt");
        // Pre-stage a symlink at the legacy deterministic staging path.
        let legacy = dir.path().join(".note.txt.terax.tmp");
        symlink(&outside, &legacy).unwrap();

        write_atomic(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        // The pre-staged symlink target must not have been written through.
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }
}
