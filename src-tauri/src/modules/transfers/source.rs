//! 本地传输来源的身份校验与安全打开。
//!
//! Planner 记录稳定文件身份；执行器打开来源后同时复验路径和句柄，避免扫描后的
//! 符号链接替换或同名文件替换把传输范围扩展到原始 Manifest 之外。

use std::path::Path;
use std::time::SystemTime;

use super::manager::TransferRunError;

/// 当前平台可用于识别本地文件系统对象的身份信号。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LocalSourceIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(windows)]
    volume: Option<u32>,
    #[cfg(windows)]
    index: Option<u64>,
}

impl LocalSourceIdentity {
    /// 从扫描得到的元数据提取文件系统身份；平台不提供稳定标识时返回 `None`。
    pub(crate) fn from_metadata(metadata: &std::fs::Metadata) -> Option<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            Some(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;

            Some(Self {
                creation_time: metadata.creation_time(),
                volume: None,
                index: None,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = metadata;
            None
        }
    }

    /// 捕获扫描路径的身份，Windows 额外读取卷序列号和文件索引。
    pub(crate) async fn capture(path: &Path, metadata: &std::fs::Metadata) -> Option<Self> {
        let fallback = Self::from_metadata(metadata);
        #[cfg(windows)]
        {
            let path = path.to_path_buf();
            let captured = tokio::task::spawn_blocking(move || windows_identity(&path))
                .await
                .ok()
                .flatten();
            match (fallback, captured) {
                (Some(mut identity), Some((volume, index))) => {
                    identity.volume = Some(volume);
                    identity.index = Some(index);
                    Some(identity)
                }
                (fallback, _) => fallback,
            }
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            fallback
        }
    }

    /// 判断路径元数据是否仍指向扫描对象。
    pub(crate) fn matches_metadata(self, metadata: &std::fs::Metadata) -> bool {
        #[cfg(unix)]
        {
            Self::from_metadata(metadata) == Some(self)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;

            metadata.creation_time() == self.creation_time
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = metadata;
            true
        }
    }

    /// 判断异步打开的文件句柄是否仍是扫描对象。
    pub(crate) fn matches_tokio_file(
        self,
        file: &tokio::fs::File,
        metadata: &std::fs::Metadata,
    ) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;

            self.matches_windows_handle(file.as_raw_handle(), metadata)
        }
        #[cfg(not(windows))]
        {
            let _ = file;
            self.matches_metadata(metadata)
        }
    }

    /// 判断阻塞打开的文件句柄是否仍是扫描对象。
    pub(crate) fn matches_std_file(
        self,
        file: &std::fs::File,
        metadata: &std::fs::Metadata,
    ) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;

            self.matches_windows_handle(file.as_raw_handle(), metadata)
        }
        #[cfg(not(windows))]
        {
            let _ = file;
            self.matches_metadata(metadata)
        }
    }

    #[cfg(windows)]
    fn matches_windows_handle(
        self,
        handle: std::os::windows::io::RawHandle,
        metadata: &std::fs::Metadata,
    ) -> bool {
        if !self.matches_metadata(metadata) {
            return false;
        }
        match (self.volume, self.index, windows_handle_identity(handle)) {
            (Some(volume), Some(index), Some(actual)) => actual == (volume, index),
            (None, None, _) => true,
            _ => false,
        }
    }
}

/// 打开并复验异步文件来源，返回值始终绑定扫描时的文件系统对象。
pub(crate) async fn open_verified_file(
    path: &Path,
    expected_identity: Option<LocalSourceIdentity>,
    expected_size: u64,
    expected_modified: Option<SystemTime>,
) -> Result<tokio::fs::File, TransferRunError> {
    let before = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| message(format!("stat source {}: {error}", path.display())))?;
    verify_path_metadata(path, &before, expected_identity, true)?;

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| message(format!("open source {}: {error}", path.display())))?;
    let opened = file
        .metadata()
        .await
        .map_err(|error| message(format!("stat opened source {}: {error}", path.display())))?;
    let after = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| message(format!("restat source {}: {error}", path.display())))?;
    verify_path_metadata(path, &after, expected_identity, true)?;
    verify_opened_metadata(path, &opened, expected_size, expected_modified)?;
    if expected_identity.is_some_and(|expected| !expected.matches_tokio_file(&file, &opened)) {
        return Err(changed(path));
    }
    Ok(file)
}

/// 复验已打开文件在读取期间未改变身份、长度或修改时间。
pub(crate) async fn verify_opened_file(
    file: &tokio::fs::File,
    path: &Path,
    expected_identity: Option<LocalSourceIdentity>,
    expected_size: u64,
    expected_modified: Option<SystemTime>,
) -> Result<(), TransferRunError> {
    let metadata = file
        .metadata()
        .await
        .map_err(|error| message(format!("verify source {}: {error}", path.display())))?;
    verify_opened_metadata(path, &metadata, expected_size, expected_modified)?;
    if expected_identity.is_some_and(|expected| !expected.matches_tokio_file(file, &metadata)) {
        return Err(changed(path));
    }
    Ok(())
}

/// 在阻塞归档线程中打开并复验来源文件。
pub(crate) fn open_verified_file_blocking(
    path: &Path,
    expected_identity: Option<LocalSourceIdentity>,
    expected_size: u64,
    expected_modified: Option<SystemTime>,
) -> std::io::Result<std::fs::File> {
    let before = std::fs::symlink_metadata(path)?;
    verify_path_metadata_io(path, &before, expected_identity, true)?;
    let file = std::fs::File::open(path)?;
    let opened = file.metadata()?;
    let after = std::fs::symlink_metadata(path)?;
    verify_path_metadata_io(path, &after, expected_identity, true)?;
    if !metadata_matches(&opened, expected_size, expected_modified)
        || expected_identity.is_some_and(|expected| !expected.matches_std_file(&file, &opened))
    {
        return Err(changed_io(path));
    }
    Ok(file)
}

/// 打开目录迭代器后复验路径身份，避免 Planner 沿扫描后替换的链接继续遍历。
pub(crate) async fn read_verified_directory(
    path: &Path,
    expected_identity: Option<LocalSourceIdentity>,
) -> Result<tokio::fs::ReadDir, TransferRunError> {
    let before = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| message(format!("stat directory {}: {error}", path.display())))?;
    verify_path_metadata(path, &before, expected_identity, false)?;
    let entries = tokio::fs::read_dir(path)
        .await
        .map_err(|error| message(format!("read directory {}: {error}", path.display())))?;
    let after = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| message(format!("restat directory {}: {error}", path.display())))?;
    verify_path_metadata(path, &after, expected_identity, false)?;
    if let Some(expected) = expected_identity {
        if LocalSourceIdentity::capture(path, &after).await != Some(expected) {
            return Err(changed(path));
        }
    }
    Ok(entries)
}

fn verify_path_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
    expected_identity: Option<LocalSourceIdentity>,
    expect_file: bool,
) -> Result<(), TransferRunError> {
    verify_path_metadata_io(path, metadata, expected_identity, expect_file)
        .map_err(|_| changed(path))
}

fn verify_path_metadata_io(
    path: &Path,
    metadata: &std::fs::Metadata,
    expected_identity: Option<LocalSourceIdentity>,
    expect_file: bool,
) -> std::io::Result<()> {
    let expected_kind = if expect_file {
        metadata.is_file()
    } else {
        metadata.is_dir()
    };
    if metadata.file_type().is_symlink()
        || !expected_kind
        || expected_identity.is_some_and(|expected| !expected.matches_metadata(metadata))
    {
        return Err(changed_io(path));
    }
    Ok(())
}

fn verify_opened_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
    expected_size: u64,
    expected_modified: Option<SystemTime>,
) -> Result<(), TransferRunError> {
    if metadata_matches(metadata, expected_size, expected_modified) {
        Ok(())
    } else {
        Err(changed(path))
    }
}

fn metadata_matches(
    metadata: &std::fs::Metadata,
    expected_size: u64,
    expected_modified: Option<SystemTime>,
) -> bool {
    metadata.is_file()
        && metadata.len() == expected_size
        && expected_modified.is_none_or(|expected| metadata.modified().ok() == Some(expected))
}

#[cfg(windows)]
fn windows_identity(path: &Path) -> Option<(u32, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // 只请求属性并允许并发读写删除，避免身份采集改变来源的正常共享语义。
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let identity = windows_handle_identity(handle);
    unsafe {
        CloseHandle(handle);
    }
    identity
}

#[cfg(windows)]
fn windows_handle_identity(handle: std::os::windows::io::RawHandle) -> Option<(u32, u64)> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // 句柄在调用期间由 File 或本函数持有，输出缓冲区与 Win32 结构大小一致。
    let succeeded =
        unsafe { GetFileInformationByHandle(handle, std::ptr::addr_of_mut!(information)) };
    if succeeded == 0 {
        return None;
    }
    let index = u64::from(information.nFileIndexHigh) << 32 | u64::from(information.nFileIndexLow);
    Some((information.dwVolumeSerialNumber, index))
}

fn changed(path: &Path) -> TransferRunError {
    message(format!(
        "source changed after transfer planning: {}",
        path.display()
    ))
}

fn changed_io(path: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("source changed after transfer planning: {}", path.display()),
    )
}

fn message(value: String) -> TransferRunError {
    TransferRunError::Message(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opened_source_must_keep_the_planned_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        tokio::fs::write(&path, b"first").await.unwrap();
        let metadata = tokio::fs::symlink_metadata(&path).await.unwrap();
        let identity = LocalSourceIdentity::capture(&path, &metadata).await;
        let modified = metadata.modified().ok();
        #[cfg(windows)]
        assert!(identity.is_some_and(|value| value.volume.is_some() && value.index.is_some()));

        tokio::fs::remove_file(&path).await.unwrap();
        tokio::fs::write(&path, b"other").await.unwrap();
        if let Some(modified) = modified {
            filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(modified))
                .unwrap();
        }

        assert!(
            open_verified_file(&path, identity, metadata.len(), modified)
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opened_source_rejects_a_symlink_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let replacement = directory.path().join("replacement");
        tokio::fs::write(&original, b"secret").await.unwrap();
        tokio::fs::write(&replacement, b"public").await.unwrap();
        let metadata = tokio::fs::symlink_metadata(&replacement).await.unwrap();
        let identity = LocalSourceIdentity::capture(&replacement, &metadata).await;

        tokio::fs::remove_file(&replacement).await.unwrap();
        std::os::unix::fs::symlink(&original, &replacement).unwrap();

        assert!(open_verified_file(
            &replacement,
            identity,
            metadata.len(),
            metadata.modified().ok(),
        )
        .await
        .is_err());
    }
}
