//! 清理调用方已确认所有权的私有临时树，不跟随符号链接或跨文件系统。

use std::path::Path;

/// 删除经过任务所有权校验的本地临时树。
///
/// 遍历使用显式目录列表，避免超深目录耗尽线程栈；只修复任务私有
/// 目录和普通文件的所需权限，符号链接始终作为链接本身删除。
pub fn remove_owned_path(path: &Path) -> std::io::Result<()> {
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
    make_directory_writable(path, &metadata.permissions())?;
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
                    make_directory_writable(&child, &metadata.permissions())?;
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
            "cleanup root has no parent",
        )
    })?;
    let device = metadata.dev();
    if std::fs::symlink_metadata(parent)?.dev() != device {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "refused to clean a owned path mounted on another filesystem",
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
            "cleanup entry changed to a directory",
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

/// 为任务私有目录补足遍历和删除所需的所有者权限。
#[cfg(unix)]
pub fn make_directory_writable(
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

/// 为任务私有目录清除只读属性，不改变 ACL。
#[cfg(not(unix))]
#[allow(clippy::permissions_set_readonly_false)]
pub fn make_directory_writable(
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn local_cleanup_refuses_a_mounted_root() {
        let metadata = std::fs::symlink_metadata("/proc").unwrap();

        assert!(local_cleanup_device(Path::new("/proc"), &metadata).is_err());
    }
}
