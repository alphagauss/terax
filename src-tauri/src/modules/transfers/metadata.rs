//! 跨 Host、WSL 与 SSH 的基础文件元数据转换和应用。
//!
//! 传输只保留权限、只读状态、访问时间和修改时间，不复制 uid、gid、ACL、扩展属性
//! 或平台专有标志，避免在不同安全域间继承所有权。

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;

use super::manager::TransferRunError;

/// 可安全跨环境复制的基础元数据快照。
#[derive(Clone, Debug)]
pub(crate) struct EntryMetadata {
    mode: Option<u32>,
    readonly: bool,
    accessed: Option<SystemTime>,
    modified: Option<SystemTime>,
    is_dir: bool,
}

impl EntryMetadata {
    /// 从宿主文件系统元数据提取权限和时间，不携带所有权。
    pub(crate) fn from_local(metadata: &std::fs::Metadata) -> Self {
        Self {
            mode: local_mode(metadata),
            readonly: metadata.permissions().readonly(),
            accessed: metadata.accessed().ok(),
            modified: metadata.modified().ok(),
            is_dir: metadata.is_dir(),
        }
    }

    /// 从 SFTP v3 属性提取基础元数据。
    pub(crate) fn from_remote(metadata: &FileAttributes) -> Self {
        let mode = metadata.permissions.map(|value| value & 0o777);
        Self {
            mode,
            readonly: mode.is_some_and(|value| value & 0o222 == 0),
            accessed: metadata
                .atime
                .map(|value| UNIX_EPOCH + Duration::from_secs(value.into())),
            modified: metadata
                .mtime
                .map(|value| UNIX_EPOCH + Duration::from_secs(value.into())),
            is_dir: metadata.file_type().is_dir(),
        }
    }

    /// 返回扫描时记录的修改时间，用于检测来源在传输期间是否变化。
    pub(crate) fn modified(&self) -> Option<SystemTime> {
        self.modified
    }

    /// 将元数据应用到本地或 WSL staging 路径。
    pub(crate) async fn apply_local(&self, path: &Path) -> Result<(), TransferRunError> {
        let path = path.to_path_buf();
        let display = path.display().to_string();
        let metadata = self.clone();
        tokio::task::spawn_blocking(move || apply_local_blocking(&path, &metadata))
            .await
            .map_err(|error| message(format!("join metadata task for {display}: {error}")))?
            .map_err(|error| message(format!("set metadata for {display}: {error}")))
    }

    /// 将元数据应用到 SSH staging 路径。
    pub(crate) async fn apply_remote(
        &self,
        session: &Arc<SftpSession>,
        path: &str,
    ) -> Result<(), TransferRunError> {
        session
            .set_metadata(path.to_string(), self.remote_attributes())
            .await
            .map_err(|error| message(format!("set remote metadata for {path}: {error}")))
    }

    fn remote_attributes(&self) -> FileAttributes {
        let fallback_mode = match (self.is_dir, self.readonly) {
            (true, true) => 0o555,
            (true, false) => 0o755,
            (false, true) => 0o444,
            (false, false) => 0o644,
        };
        let permissions = Some(self.mode.unwrap_or(fallback_mode));
        let (atime, mtime) = match (self.accessed, self.modified) {
            (Some(accessed), Some(modified)) => {
                (Some(sftp_time(accessed)), Some(sftp_time(modified)))
            }
            _ => (None, None),
        };
        FileAttributes {
            size: None,
            uid: None,
            user: None,
            gid: None,
            group: None,
            permissions,
            atime,
            mtime,
        }
    }
}

fn apply_local_blocking(path: &Path, metadata: &EntryMetadata) -> std::io::Result<()> {
    clear_local_readonly(path)?;
    match (metadata.accessed, metadata.modified) {
        (Some(accessed), Some(modified)) => filetime::set_file_times(
            path,
            filetime::FileTime::from_system_time(accessed),
            filetime::FileTime::from_system_time(modified),
        ),
        (Some(accessed), None) => {
            filetime::set_file_atime(path, filetime::FileTime::from_system_time(accessed))
        }
        (None, Some(modified)) => {
            filetime::set_file_mtime(path, filetime::FileTime::from_system_time(modified))
        }
        (None, None) => Ok(()),
    }?;
    // Windows 上只读文件不允许再设置时间，因此权限必须最后应用。
    set_local_permissions(path, metadata)
}

#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
fn clear_local_readonly(path: &Path) -> std::io::Result<()> {
    let mut permissions = std::fs::metadata(path)?.permissions();
    if permissions.readonly() {
        // Windows 不允许修改只读文件的时间戳，应用新元数据前需要暂时恢复可写。
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn clear_local_readonly(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn local_mode(metadata: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;

    Some(metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn local_mode(_metadata: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_local_permissions(path: &Path, metadata: &EntryMetadata) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(mode) = metadata.mode {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_local_permissions(path: &Path, metadata: &EntryMetadata) -> std::io::Result<()> {
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_readonly(metadata.readonly);
    std::fs::set_permissions(path, permissions)
}

fn sftp_time(value: SystemTime) -> u32 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(u32::MAX.into()) as u32
}

fn message(value: String) -> TransferRunError {
    TransferRunError::Message(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_attributes_never_copy_size_or_ownership() {
        let metadata = EntryMetadata {
            mode: Some(0o754),
            readonly: false,
            accessed: Some(UNIX_EPOCH + Duration::from_secs(10)),
            modified: Some(UNIX_EPOCH + Duration::from_secs(20)),
            is_dir: false,
        };

        let attributes = metadata.remote_attributes();
        assert_eq!(attributes.permissions, Some(0o754));
        assert_eq!(attributes.atime, Some(10));
        assert_eq!(attributes.mtime, Some(20));
        assert_eq!(attributes.size, None);
        assert_eq!(attributes.uid, None);
        assert_eq!(attributes.gid, None);
    }

    #[tokio::test]
    async fn applies_local_readonly_and_modified_time() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file");
        tokio::fs::write(&path, b"content").await.unwrap();
        let modified = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let metadata = EntryMetadata {
            mode: if cfg!(unix) { Some(0o444) } else { None },
            readonly: true,
            accessed: Some(modified),
            modified: Some(modified),
            is_dir: false,
        };

        metadata.apply_local(&path).await.unwrap();

        let actual = std::fs::metadata(&path).unwrap();
        assert!(actual.permissions().readonly());
        let drift = actual
            .modified()
            .unwrap()
            .duration_since(modified)
            .unwrap_or_else(|error| error.duration());
        assert!(drift <= Duration::from_secs(2));

        let writable = EntryMetadata {
            readonly: false,
            ..metadata
        };
        writable.apply_local(&path).await.unwrap();
    }
}
