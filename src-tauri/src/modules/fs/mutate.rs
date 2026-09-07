//! 本地、WSL 与 SSH Workspace 的文件系统变更命令。
//!
//! 路径由当前 Workspace 环境解析。跨环境后台传输不在这里执行，而由 transfers
//! 子系统统一管理任务、取消、进度和提交。

#[cfg(feature = "desktop")]
use crate::modules::remote;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};
use serde::Serialize;
#[cfg(windows)]
use std::process::Stdio;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
const WSL_DELETE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TrashResult {
    Trashed,
    Unavailable { reason: String },
}

/// Creates a new empty file. Fails if the file already exists.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_create_file(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "desktop")]
        {
            let profile_id = profile_id.to_string();
            let manager = remote::manager::global_manager()?;
            let workspace = manager.workspace(&profile_id).await?;
            return remote::sftp::create_file(&workspace, &path).await;
        }
    }
    let p = resolve_path(&path, &workspace);
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::write(&p, "").map_err(|e| {
        log::debug!("fs_create_file({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Creates a new directory. Fails if the directory already exists.
/// Parents are created as needed — matches the common "new folder" UX
/// where typing "a/b/c" creates the full chain.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_create_dir(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "desktop")]
        {
            let profile_id = profile_id.to_string();
            let manager = remote::manager::global_manager()?;
            let workspace = manager.workspace(&profile_id).await?;
            return remote::mutation_service::create_directory(&workspace, &path).await;
        }
    }
    let p = resolve_path(&path, &workspace);
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| {
        log::debug!("fs_create_dir({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Renames (or moves) a path. Refuses to overwrite an existing target.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_rename(
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "desktop")]
        {
            let profile_id = profile_id.to_string();
            let manager = remote::manager::global_manager()?;
            let workspace = manager.workspace(&profile_id).await?;
            return remote::sftp::rename(&workspace, &from, &to).await;
        }
    }
    let from_p = resolve_path(&from, &workspace);
    let to_p = resolve_path(&to, &workspace);
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    std::fs::rename(&from_p, &to_p).map_err(|e| {
        log::debug!(
            "fs_rename({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        e.to_string()
    })
}

/// 删除文件或目录，目录会在所属 Workspace 环境内递归删除。
///
/// 调用方必须先完成破坏性操作确认；本命令负责环境分流和底层错误报告。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_delete(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "desktop")]
        {
            let profile_id = profile_id.to_string();
            let manager = remote::manager::global_manager()?;
            let workspace = manager.workspace(&profile_id).await?;
            return remote::mutation_service::delete(&workspace, &path).await;
        }
    }
    if let WorkspaceEnv::Wsl { distro } = &workspace {
        // Windows 盘挂载已经由 resolve_path 映射为本机盘符，继续走原生文件系统更快，
        // 也保留回收站能力；只有 WSL 自有文件系统需要绕过 UNC 桥。
        if is_wsl_drvfs_path(&path) {
            return delete_local_path(&path, &workspace);
        }
        return delete_wsl_path(distro, &path).await;
    }
    delete_local_path(&path, &workspace)
}

/// 通过宿主机文件系统删除本地或映射到 Windows 盘符的路径。
fn delete_local_path(path: &str, workspace: &WorkspaceEnv) -> Result<(), String> {
    let p = resolve_path(path, workspace);
    let meta = std::fs::symlink_metadata(&p).map_err(|e| {
        log::debug!("fs_delete stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };

    result.map_err(|e| {
        log::warn!("fs_delete({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// 判断 WSL 路径是否位于 `/mnt/<drive>` Windows 盘挂载中。
fn is_wsl_drvfs_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let Some(rest) = normalized.strip_prefix("/mnt/") else {
        return false;
    };
    let mut parts = rest.split('/');
    let drive = parts.next().unwrap_or_default();
    drive.len() == 1 && drive.bytes().all(|byte| byte.is_ascii_alphabetic())
}

/// 在 WSL 发行版内部递归删除路径，避免逐项操作穿过 `\\wsl.localhost` 文件系统桥。
///
/// 参数直接交给 `wsl.exe --exec rm`，不经过 shell 解析。根路径及带有父级跳转的路径
/// 会在启动进程前被拒绝，符号链接由 `rm` 按链接本身处理。
#[cfg(windows)]
async fn delete_wsl_path(distro: &str, path: &str) -> Result<(), String> {
    validate_posix_destructive_path(path)?;
    crate::modules::workspace::validate_wsl_distro_name(distro)?;

    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("rm")
        .arg("-rf")
        .arg("--")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::modules::proc::hide_console(command.as_std_mut());

    let output = tokio::time::timeout(WSL_DELETE_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("WSL delete timed out: {path}"))?
        .map_err(|error| format!("start WSL delete: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = crate::modules::workspace::decode_command_output(&output.stderr);
    let detail = stderr.trim();
    if detail.is_empty() {
        Err(format!(
            "WSL delete failed with status {}: {path}",
            output.status
        ))
    } else {
        Err(format!("WSL delete failed: {detail}"))
    }
}

#[cfg(not(windows))]
async fn delete_wsl_path(_distro: &str, _path: &str) -> Result<(), String> {
    Err("WSL file deletion is only available on Windows".into())
}

/// 验证交给 WSL 原生命令的破坏性路径，禁止根目录和父级跳转。
#[cfg_attr(
    not(any(windows, test)),
    expect(dead_code, reason = "WSL 删除仅在 Windows 执行")
)]
fn validate_posix_destructive_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.contains(['\0', '\r', '\n'])
        || path.trim_end_matches('/').is_empty()
        || path
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return Err("refusing to delete WSL root or unsafe path".into());
    }
    Ok(())
}

/// 将可由宿主机处理的路径移动到操作系统回收站。
///
/// SSH 和 WSL 自有文件系统没有兼容的宿主机回收站，返回明确的不可用结果，
/// 由前端继续请求永久删除确认。WSL 的 Windows 盘挂载仍保留本机回收站能力。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_trash(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<TrashResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if workspace.ssh_profile_id().is_some() {
        return Ok(TrashResult::Unavailable {
            reason: "remote workspace has no local trash service".to_string(),
        });
    }
    if workspace.is_wsl() && !is_wsl_drvfs_path(&path) {
        return Ok(TrashResult::Unavailable {
            reason: "WSL workspace has no compatible Windows trash service".to_string(),
        });
    }

    let p = resolve_path(&path, &workspace);
    std::fs::symlink_metadata(&p).map_err(|e| {
        log::debug!("fs_trash stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    match trash::delete(&p) {
        Ok(()) => Ok(TrashResult::Trashed),
        Err(error) => {
            log::warn!("fs_trash({}) failed: {error}", p.display());
            Ok(TrashResult::Unavailable {
                reason: error.to_string(),
            })
        }
    }
}

fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

/// 将外部文件或目录递归复制到本地或 WSL 目标目录。
///
/// 来源是拖放提供的宿主机绝对路径，只有目标经过 Workspace 路径解析。SSH 跨环境
/// 复制必须进入 transfers 子系统，本命令拒绝覆盖已有目标。
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_copy(
    sources: Vec<String>,
    dest_dir: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if workspace.is_ssh() {
        return Err("fs_copy is only available for local and WSL paths".into());
    }
    let dest = resolve_path(&dest_dir, &workspace);
    for source in &sources {
        let src = std::path::PathBuf::from(source);
        let name = src
            .file_name()
            .ok_or_else(|| format!("invalid source: {source}"))?;
        let target = dest.join(name);
        if target.exists() {
            return Err(format!("already exists: {}", target.display()));
        }
        copy_recursive(&src, &target).map_err(|e| {
            log::warn!(
                "fs_copy({} -> {}) failed: {e}",
                src.display(),
                target.display()
            );
            e.to_string()
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: std::path::PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn create_file_makes_empty_and_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("new.txt");
        fs_create_file(s(f.clone()), None).await.expect("create");
        assert!(f.exists());
        assert_eq!(std::fs::read(&f).unwrap(), b"");

        // A second create must error, not truncate existing content.
        std::fs::write(&f, b"data").unwrap();
        let err = fs_create_file(s(f.clone()), None).await.unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&f).unwrap(), b"data");
    }

    #[tokio::test]
    async fn create_dir_builds_nested_chain_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        fs_create_dir(s(nested.clone()), None)
            .await
            .expect("create dir");
        assert!(nested.is_dir());
        let err = fs_create_dir(s(nested), None).await.unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[tokio::test]
    async fn rename_moves_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        std::fs::write(&from, b"payload").unwrap();

        fs_rename(s(from.clone()), s(to.clone()), None)
            .await
            .expect("rename");
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"payload");

        // Missing source is reported, not silently ignored.
        let err = fs_rename(s(from), s(dir.path().join("c.txt")), None)
            .await
            .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");

        // Refusing to overwrite an existing target is the data-loss guard.
        let occupied = dir.path().join("keep.txt");
        std::fs::write(&occupied, b"keep").unwrap();
        let err = fs_rename(s(to.clone()), s(occupied.clone()), None)
            .await
            .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"keep");
        assert!(to.exists());
    }

    #[tokio::test]
    async fn copy_brings_file_and_dir_in_and_refuses_clobber() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("a.txt"), b"payload").unwrap();
        std::fs::create_dir_all(src.path().join("d/inner")).unwrap();
        std::fs::write(src.path().join("d/inner/y.txt"), b"y").unwrap();

        fs_copy(
            vec![s(src.path().join("a.txt")), s(src.path().join("d"))],
            s(dest.path().to_path_buf()),
            None,
        )
        .await
        .expect("copy");

        assert_eq!(
            std::fs::read(dest.path().join("a.txt")).unwrap(),
            b"payload"
        );
        assert_eq!(
            std::fs::read(dest.path().join("d/inner/y.txt")).unwrap(),
            b"y"
        );
        // copy, not move: the source survives.
        assert!(src.path().join("a.txt").exists());

        let err = fs_copy(
            vec![s(src.path().join("a.txt"))],
            s(dest.path().to_path_buf()),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[tokio::test]
    async fn delete_removes_file_then_dir_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.txt");
        std::fs::write(&f, b"x").unwrap();
        fs_delete(s(f.clone()), None).await.expect("delete file");
        assert!(!f.exists());

        let sub = dir.path().join("sub");
        std::fs::create_dir_all(sub.join("inner")).unwrap();
        std::fs::write(sub.join("inner/y.txt"), b"y").unwrap();
        fs_delete(s(sub.clone()), None).await.expect("delete dir");
        assert!(!sub.exists());

        let err = fs_delete(s(dir.path().join("missing")), None)
            .await
            .unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn wsl_delete_path_rejects_root_and_parent_traversal() {
        assert!(validate_posix_destructive_path("/home/user/project").is_ok());
        assert!(validate_posix_destructive_path("/home/user/a b").is_ok());
        assert!(validate_posix_destructive_path("/").is_err());
        assert!(validate_posix_destructive_path("////").is_err());
        assert!(validate_posix_destructive_path("relative/path").is_err());
        assert!(validate_posix_destructive_path("/home/user/../other").is_err());
        assert!(validate_posix_destructive_path("/home/user/./project").is_err());
        assert!(validate_posix_destructive_path("/home/user/\nproject").is_err());
    }

    #[test]
    fn wsl_drvfs_detection_keeps_windows_mounts_on_the_host_backend() {
        assert!(is_wsl_drvfs_path("/mnt/c/project"));
        assert!(is_wsl_drvfs_path(r"\mnt\D\work"));
        assert!(is_wsl_drvfs_path("/mnt/z"));
        assert!(!is_wsl_drvfs_path("/mnt"));
        assert!(!is_wsl_drvfs_path("/mnt/data/project"));
        assert!(!is_wsl_drvfs_path("/home/user/project"));
    }

    // Deleting a symlink that points at a directory must remove only the link,
    // never recurse through it and wipe the target's contents.
    #[cfg(unix)]
    #[tokio::test]
    async fn delete_does_not_follow_symlink_into_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"keep").unwrap();

        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        fs_delete(s(link.clone()), None)
            .await
            .expect("delete symlink");
        assert!(!link.exists(), "symlink itself should be gone");
        assert!(real.is_dir(), "target dir must survive");
        assert_eq!(std::fs::read(real.join("keep.txt")).unwrap(), b"keep");
    }
}
