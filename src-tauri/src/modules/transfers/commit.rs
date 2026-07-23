//! 文件传输 staging、无覆盖提交与任务所有权清理。
//!
//! 每个顶层来源写入最终目标同级的固定长度 staging 路径。本地提交使用平台原生
//! no-replace rename；失败只清理任务命名的 staging，不删除已经公开的最终目标。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;

use crate::modules::remote::session::join_remote;

use super::manager::TransferRunError;

/// 本地顶层来源的 staging 与最终目标。
pub(crate) struct LocalRoot {
    pub(crate) stage: PathBuf,
    pub(crate) final_path: PathBuf,
}

/// SSH 顶层来源的 staging 与最终目标。
pub(crate) struct RemoteRoot {
    pub(crate) stage: String,
    pub(crate) final_path: String,
}

/// 确认本地目标尚不存在，未知元数据错误不得被当作空闲目标。
pub(crate) async fn ensure_local_target_available(path: &Path) -> RunResult<()> {
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

/// 确认 SSH 目标尚不存在。
pub(crate) async fn ensure_remote_target_available(
    session: &Arc<SftpSession>,
    path: &str,
) -> RunResult<()> {
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

/// 使用平台原生 no-replace 操作公开本地 staging，提交时绝不覆盖已有目标。
pub(crate) async fn commit_local_root(root: &LocalRoot) -> RunResult<()> {
    ensure_local_target_available(&root.final_path).await?;
    let stage = root.stage.clone();
    let final_path = root.final_path.clone();
    tokio::task::spawn_blocking(move || rename_no_replace(&stage, &final_path))
        .await
        .map_err(|error| message(format!("join local commit task: {error}")))?
        .map_err(|error| {
            message(format!(
                "commit transfer {}: {error}",
                root.final_path.display()
            ))
        })
}

/// 使用 SFTP v3 no-replace rename 公开 SSH staging。
pub(crate) async fn commit_remote_root(
    session: &Arc<SftpSession>,
    root: &RemoteRoot,
) -> RunResult<()> {
    ensure_remote_target_available(session, &root.final_path).await?;
    session
        .rename(root.stage.clone(), root.final_path.clone())
        .await
        .map_err(|error| {
            message(format!(
                "commit remote transfer {}: {error}",
                root.final_path
            ))
        })
}

/// 失败或取消后只清理任务私有 staging，不删除已经提交的最终目标。
pub(crate) async fn cleanup_local_staging(roots: &[LocalRoot]) {
    for root in roots {
        remove_local_path(&root.stage).await;
    }
}

/// 使用任务独占会话清理 SSH staging，避免占用 Explorer 的缓存会话。
pub(crate) async fn cleanup_remote_staging(session: &Arc<SftpSession>, roots: &[RemoteRoot]) {
    for root in roots {
        if let Err(error) = remove_remote_path(session, &root.stage).await {
            log::warn!(
                "failed to clean remote transfer path {}: {error:?}",
                root.stage
            );
        }
    }
}

async fn remove_local_path(path: &Path) {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!("failed to stat transfer path {}: {error}", path.display());
            return;
        }
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

async fn remove_remote_path(session: &Arc<SftpSession>, root: &str) -> RunResult<()> {
    let metadata = match session.symlink_metadata(root.to_string()).await {
        Ok(metadata) => metadata,
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
            return Ok(())
        }
        Err(error) => return Err(message(format!("stat remote staging path {root}: {error}"))),
    };
    if !metadata.file_type().is_dir() {
        return session
            .remove_file(root.to_string())
            .await
            .map_err(|error| message(format!("remove remote staging file {root}: {error}")));
    }

    let mut directories = vec![root.trim_end_matches('/').to_string()];
    let mut index = 0;
    while index < directories.len() {
        let directory = directories[index].clone();
        index += 1;
        let entries = session.read_dir(directory.clone()).await.map_err(|error| {
            message(format!(
                "read remote staging directory {directory}: {error}"
            ))
        })?;
        for entry in entries {
            let child = entry.path();
            if entry.file_type().is_dir() {
                directories.push(child);
            } else {
                session.remove_file(child.clone()).await.map_err(|error| {
                    message(format!("remove remote staging file {child}: {error}"))
                })?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        session
            .remove_dir(directory.clone())
            .await
            .map_err(|error| {
                message(format!(
                    "remove remote staging directory {directory}: {error}"
                ))
            })?;
    }
    Ok(())
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

    #[tokio::test]
    async fn local_commit_never_replaces_an_existing_target() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::write(&stage, b"new").await.unwrap();
        tokio::fs::write(&final_path, b"original").await.unwrap();
        let root = LocalRoot { stage, final_path };

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
        let stage = directory.path().join("stage");
        let final_path = directory.path().join("final");
        tokio::fs::write(&stage, b"partial").await.unwrap();
        tokio::fs::write(&final_path, b"committed").await.unwrap();
        let root = LocalRoot { stage, final_path };

        cleanup_local_staging(std::slice::from_ref(&root)).await;

        assert!(!root.stage.exists());
        assert_eq!(
            tokio::fs::read(&root.final_path).await.unwrap(),
            b"committed"
        );
    }
}
