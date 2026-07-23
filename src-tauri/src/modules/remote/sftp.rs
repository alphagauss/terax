//! 基于 SFTP 的远程文件系统实现。
//!
//! 普通 Explorer 操作复用缓存会话。后台传输的独占会话和数据流由 transfers 子系统
//! 持有，避免目录读取被大文件复制阻塞。本模块的破坏性操作拒绝符号链接和危险根路径。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::session::{join_remote, validate_remote_path, RemoteWorkspace};

#[derive(Clone, Debug)]
pub struct RemoteDirEntry {
    pub name: String,
    pub kind: RemoteEntryKind,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteEntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Clone, Debug)]
pub struct RemoteStat {
    pub kind: RemoteEntryKind,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Clone, Debug)]
pub struct RemoteWalkEntry {
    pub path: String,
    pub rel: String,
    pub name: String,
    pub kind: RemoteEntryKind,
    pub size: u64,
}

pub async fn walk(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    show_hidden: bool,
    max_depth: usize,
    max_entries: usize,
) -> Result<(Vec<RemoteWalkEntry>, bool), String> {
    const PRUNE: &[&str] = &[
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        ".venv",
        "__pycache__",
    ];
    let root = canonicalize(workspace, root).await?;
    let mut pending = vec![(root.clone(), String::new(), 0usize)];
    let mut output = Vec::new();
    let mut truncated = false;
    while let Some((directory, relative, depth)) = pending.pop() {
        if depth >= max_depth {
            continue;
        }
        for entry in read_dir(workspace, &directory, show_hidden).await? {
            if output.len() >= max_entries {
                truncated = true;
                break;
            }
            let rel = if relative.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative}/{}", entry.name)
            };
            let path = join_remote(&directory, &entry.name);
            if entry.kind == RemoteEntryKind::Dir && !PRUNE.contains(&entry.name.as_str()) {
                pending.push((path.clone(), rel.clone(), depth + 1));
            }
            output.push(RemoteWalkEntry {
                path,
                rel,
                name: entry.name,
                kind: entry.kind,
                size: entry.size,
            });
        }
        if truncated {
            break;
        }
    }
    Ok((output, truncated))
}

/// 返回文件浏览和普通文件操作共享的缓存 SFTP 会话。
pub async fn session(
    workspace: &Arc<RemoteWorkspace>,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let mut cached = workspace.sftp.lock().await;
    if let Some(session) = cached.as_ref() {
        return Ok(session.clone());
    }
    let session = open_cached_session(workspace).await?;
    *cached = Some(session.clone());
    Ok(session)
}

/// 创建仅供 Explorer 和普通文件操作复用的缓存 SFTP 会话。
async fn open_cached_session(
    workspace: &Arc<RemoteWorkspace>,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let channel = {
        let handle = workspace.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|error| format!("open SFTP channel: {error}"))?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("request SFTP subsystem: {error}"))?;
    let session = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("initialize SFTP: {error}"))?;
    session.set_timeout(30);
    Ok(Arc::new(session))
}

async fn invalidate_session(
    workspace: &Arc<RemoteWorkspace>,
    failed: &Arc<russh_sftp::client::SftpSession>,
) {
    let mut cached = workspace.sftp.lock().await;
    if cached
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, failed))
    {
        *cached = None;
    }
}

async fn sftp_result<T>(
    workspace: &Arc<RemoteWorkspace>,
    session: &Arc<russh_sftp::client::SftpSession>,
    context: String,
    result: Result<T, russh_sftp::client::error::Error>,
) -> Result<T, String> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            if should_invalidate_session(&error) {
                invalidate_session(workspace, session).await;
            }
            Err(format!("{context}: {error}"))
        }
    }
}

async fn retry_sftp_read<T, F>(
    workspace: &Arc<RemoteWorkspace>,
    context: String,
    mut operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnMut(
        Arc<russh_sftp::client::SftpSession>,
    ) -> Pin<
        Box<dyn Future<Output = Result<T, russh_sftp::client::error::Error>> + Send + 'static>,
    >,
{
    for attempt in 0..2 {
        let current = session(workspace).await?;
        match operation(current.clone()).await {
            Ok(value) => return Ok(value),
            Err(error) if should_invalidate_session(&error) => {
                invalidate_session(workspace, &current).await;
                if attempt == 1 {
                    return Err(format!("{context}: {error}"));
                }
            }
            Err(error) => return Err(format!("{context}: {error}")),
        }
    }
    unreachable!("SFTP read retry loop always returns")
}

fn should_invalidate_session(error: &russh_sftp::client::error::Error) -> bool {
    match error {
        russh_sftp::client::error::Error::Status(status) => matches!(
            status.status_code,
            StatusCode::BadMessage | StatusCode::NoConnection | StatusCode::ConnectionLost
        ),
        russh_sftp::client::error::Error::Limited(_) => false,
        _ => true,
    }
}

pub async fn read_dir(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    show_hidden: bool,
) -> Result<Vec<RemoteDirEntry>, String> {
    validate_remote_path(path)?;
    let remote_path = path.to_string();
    let read = retry_sftp_read(
        workspace,
        format!("read remote directory {path}"),
        move |sftp| {
            let path = remote_path.clone();
            Box::pin(async move { sftp.read_dir(path).await })
        },
    )
    .await?;
    let mut entries = Vec::new();
    for entry in read {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let metadata = entry.metadata();
        entries.push(RemoteDirEntry {
            name,
            kind: entry_kind(metadata.file_type()),
            size: metadata.len(),
            mtime: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| {
        let rank = |entry: &RemoteDirEntry| match entry.kind {
            RemoteEntryKind::Dir => 0,
            RemoteEntryKind::Symlink => 1,
            RemoteEntryKind::File => 2,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn stat(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<RemoteStat, String> {
    validate_remote_path(path)?;
    let remote_path = path.to_string();
    let (link_metadata, target_metadata) =
        retry_sftp_read(workspace, format!("stat remote path {path}"), move |sftp| {
            let path = remote_path.clone();
            Box::pin(async move {
                let link = sftp.symlink_metadata(&path).await?;
                let target = if link.file_type() == FileType::Symlink {
                    match sftp.metadata(&path).await {
                        Ok(metadata) => Some(metadata),
                        Err(russh_sftp::client::error::Error::Status(status))
                            if status.status_code == StatusCode::NoSuchFile =>
                        {
                            None
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    None
                };
                Ok((link, target))
            })
        })
        .await?;
    // Match the local backend: preserve the symlink kind while reporting the
    // target's size and mtime. This keeps editor size/conflict checks correct
    // for files opened through a symlink.
    let metadata = target_metadata.as_ref().unwrap_or(&link_metadata);
    Ok(RemoteStat {
        kind: entry_kind(link_metadata.file_type()),
        size: metadata.len(),
        mtime: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    })
}

pub async fn canonicalize(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<String, String> {
    validate_remote_path(path)?;
    let remote_path = path.to_string();
    retry_sftp_read(
        workspace,
        format!("canonicalize remote path {path}"),
        move |sftp| {
            let path = remote_path.clone();
            Box::pin(async move { sftp.canonicalize(path).await })
        },
    )
    .await
}

pub async fn read_file(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let metadata = stat(workspace, path).await?;
    if metadata.size > limit {
        return Err(format!("REMOTE_FILE_TOO_LARGE:{}:{limit}", metadata.size));
    }
    let remote_path = path.to_string();
    let capacity = metadata.size.min(limit).min(1024 * 1024) as usize;
    let output = retry_sftp_read(workspace, format!("read remote file {path}"), move |sftp| {
        let path = remote_path.clone();
        Box::pin(async move {
            let file = sftp.open(path).await?;
            let mut output = Vec::with_capacity(capacity);
            let mut bounded = file.take(limit.saturating_add(1));
            bounded.read_to_end(&mut output).await?;
            Ok(output)
        })
    })
    .await?;
    if output.len() as u64 > limit {
        return Err(format!("REMOTE_FILE_TOO_LARGE:{}:{limit}", output.len()));
    }
    Ok(output)
}

/// 原子写入远程文件并保留已有文件的权限。
///
/// 临时文件只能显式设置权限。`FileAttributes::default()` 会携带大小、属主和时间戳，
/// 在 SFTP `setstat` 中可能清空内容或因无权修改属主而导致保存失败。
pub async fn write_file(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
) -> Result<u64, String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    let exists = sftp_result(
        workspace,
        &sftp,
        format!("stat remote file {path}"),
        sftp.try_exists(path).await,
    )
    .await?;
    let target = if exists {
        sftp_result(
            workspace,
            &sftp,
            format!("canonicalize remote file {path}"),
            sftp.canonicalize(path).await,
        )
        .await?
    } else {
        canonical_target_for_new_file(workspace, &sftp, path).await?
    };
    let permissions = if exists {
        sftp_result(
            workspace,
            &sftp,
            format!("read remote file metadata {target}"),
            sftp.metadata(&target).await,
        )
        .await?
        .permissions
    } else {
        None
    };
    let temporary = temporary_sibling(&target)?;
    let mut file = sftp_result(
        workspace,
        &sftp,
        format!("create temporary remote file {temporary}"),
        sftp.open_with_flags(
            &temporary,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await,
    )
    .await?;
    if let Err(error) = file.write_all(content).await {
        invalidate_session(workspace, &sftp).await;
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!("write temporary remote file {temporary}: {error}"));
    }
    if let Err(error) = file.flush().await {
        invalidate_session(workspace, &sftp).await;
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!("flush temporary remote file {temporary}: {error}"));
    }
    if let Err(error) = file.sync_all().await {
        invalidate_session(workspace, &sftp).await;
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!("sync temporary remote file {temporary}: {error}"));
    }
    if let Err(error) = file.shutdown().await {
        invalidate_session(workspace, &sftp).await;
        let _ = sftp.remove_file(&temporary).await;
        return Err(format!("close temporary remote file {temporary}: {error}"));
    }
    if let Some(permissions) = permissions {
        let attributes = permission_attributes(permissions);
        if let Err(error) = sftp.set_metadata(&temporary, attributes).await {
            if should_invalidate_session(&error) {
                invalidate_session(workspace, &sftp).await;
            }
            let _ = sftp.remove_file(&temporary).await;
            return Err(format!(
                "preserve permissions on temporary remote file {temporary}: {error}"
            ));
        }
    }
    let command = format!(
        "mv -f -- {} {}",
        super::session::shell_quote(&temporary),
        super::session::shell_quote(&target)
    );
    let moved = workspace
        .exec(&command, None, std::time::Duration::from_secs(15))
        .await?;
    if moved.timed_out || moved.exit_code != Some(0) {
        let _ = sftp.remove_file(&temporary).await;
        let detail = String::from_utf8_lossy(&moved.stderr).trim().to_string();
        return Err(if moved.timed_out {
            format!("timed out replacing remote file {target}")
        } else if detail.is_empty() {
            format!("replace remote file {target} failed")
        } else {
            format!("replace remote file {target} failed: {detail}")
        });
    }
    Ok(stat(workspace, &target).await?.mtime)
}

/// 构造仅包含权限位的 SFTP 属性。
///
/// 必须从空属性开始，避免 `setstat` 隐式修改临时文件的大小、属主或时间戳。
fn permission_attributes(permissions: u32) -> FileAttributes {
    FileAttributes {
        permissions: Some(permissions),
        ..FileAttributes::empty()
    }
}

pub async fn create_file(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    let mut file = sftp_result(
        workspace,
        &sftp,
        format!("create remote file {path}"),
        sftp.open_with_flags(
            path,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await,
    )
    .await?;
    if let Err(error) = file.shutdown().await {
        invalidate_session(workspace, &sftp).await;
        return Err(format!("close remote file {path}: {error}"));
    }
    Ok(())
}

pub async fn create_dir(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    if sftp_result(
        workspace,
        &sftp,
        format!("stat remote path {path}"),
        sftp.try_exists(path).await,
    )
    .await?
    {
        return Err(format!("already exists: {path}"));
    }
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        "/".to_string()
    } else {
        String::new()
    };
    let components: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    for (index, component) in components.iter().enumerate() {
        current = join_remote(&current, component);
        if index + 1 == components.len() {
            sftp_result(
                workspace,
                &sftp,
                format!("create remote directory {current}"),
                sftp.create_dir(&current).await,
            )
            .await?;
            continue;
        }
        let exists = sftp_result(
            workspace,
            &sftp,
            format!("stat remote path {current}"),
            sftp.try_exists(&current).await,
        )
        .await?;
        if !exists {
            sftp_result(
                workspace,
                &sftp,
                format!("create remote directory {current}"),
                sftp.create_dir(&current).await,
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn rename(workspace: &Arc<RemoteWorkspace>, from: &str, to: &str) -> Result<(), String> {
    validate_remote_path(from)?;
    validate_remote_path(to)?;
    let sftp = session(workspace).await?;
    if !sftp_result(
        workspace,
        &sftp,
        format!("stat remote path {from}"),
        sftp.try_exists(from).await,
    )
    .await?
    {
        return Err(format!("not found: {from}"));
    }
    if sftp_result(
        workspace,
        &sftp,
        format!("stat remote path {to}"),
        sftp.try_exists(to).await,
    )
    .await?
    {
        return Err(format!("already exists: {to}"));
    }
    sftp_result(
        workspace,
        &sftp,
        format!("rename remote path {from} to {to}"),
        sftp.rename(from, to).await,
    )
    .await
}

pub async fn delete(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_destructive_path(path)?;
    let metadata = stat(workspace, path).await?;
    let sftp = session(workspace).await?;
    if metadata.kind != RemoteEntryKind::Dir {
        return sftp_result(
            workspace,
            &sftp,
            format!("remove remote file {path}"),
            sftp.remove_file(path).await,
        )
        .await;
    }
    let mut directories = vec![path.trim_end_matches('/').to_string()];
    let mut index = 0;
    while index < directories.len() {
        let directory = directories[index].clone();
        index += 1;
        for entry in read_dir(workspace, &directory, true).await? {
            let child = join_remote(&directory, &entry.name);
            if entry.kind == RemoteEntryKind::Dir {
                directories.push(child);
            } else {
                sftp_result(
                    workspace,
                    &sftp,
                    format!("remove remote file {child}"),
                    sftp.remove_file(&child).await,
                )
                .await?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        sftp_result(
            workspace,
            &sftp,
            format!("remove remote directory {directory}"),
            sftp.remove_dir(&directory).await,
        )
        .await?;
    }
    Ok(())
}

async fn canonical_target_for_new_file(
    workspace: &Arc<RemoteWorkspace>,
    sftp: &Arc<russh_sftp::client::SftpSession>,
    path: &str,
) -> Result<String, String> {
    let (parent, name) = remote_parent_name(path)?;
    let canonical_parent = sftp_result(
        workspace,
        sftp,
        format!("canonicalize remote directory {parent}"),
        sftp.canonicalize(parent).await,
    )
    .await?;
    Ok(join_remote(&canonical_parent, name))
}

fn temporary_sibling(path: &str) -> Result<String, String> {
    let (parent, name) = remote_parent_name(path)?;
    Ok(join_remote(
        parent,
        &format!(".{name}.terax-{}.tmp", uuid::Uuid::new_v4()),
    ))
}

fn remote_parent_name(path: &str) -> Result<(&str, &str), String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return Err("remote file path is empty or root".into());
    }
    let (parent, name) = match path.rsplit_once('/') {
        Some(("", name)) => ("/", name),
        Some((parent, name)) => (parent, name),
        None => (".", path),
    };
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(format!("invalid remote file path: {path}"));
    }
    Ok((parent, name))
}

fn entry_kind(kind: FileType) -> RemoteEntryKind {
    match kind {
        FileType::Dir => RemoteEntryKind::Dir,
        FileType::Symlink => RemoteEntryKind::Symlink,
        _ => RemoteEntryKind::File,
    }
}

fn validate_destructive_path(path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    let normalized = path.trim_matches('/');
    if normalized.is_empty()
        || path
            .split('/')
            .any(|component| component == "." || component == "..")
    {
        return Err("refusing to delete remote root or empty path".into());
    }
    Ok(())
}

/// 将远端文件名转换为 Windows、macOS 和 Linux 均可创建的本地名称。
pub(crate) fn sanitize_local_name(name: &str) -> String {
    let mut value: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            value if value.is_control() => '_',
            value => value,
        })
        .collect();
    while value.ends_with([' ', '.']) {
        value.pop();
    }
    if value.is_empty() || value == "." || value == ".." {
        return "download".into();
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
    {
        value.insert(0, '_');
    }
    value
}

#[cfg(test)]
mod tests {
    use super::{
        permission_attributes, remote_parent_name, sanitize_local_name, should_invalidate_session,
        validate_destructive_path,
    };

    #[test]
    fn destructive_paths_reject_root_and_parent_traversal() {
        for path in ["/", "//", ".", "..", "/tmp/..", "a/../b", "a/./b"] {
            assert!(validate_destructive_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_destructive_path("/home/me/project/file.txt").is_ok());
        assert!(validate_destructive_path("relative/file.txt").is_ok());
    }

    #[test]
    fn splits_remote_file_paths_safely() {
        assert_eq!(
            remote_parent_name("/home/me/a.txt").unwrap(),
            ("/home/me", "a.txt")
        );
        assert_eq!(remote_parent_name("a.txt").unwrap(), (".", "a.txt"));
        assert!(remote_parent_name("/").is_err());
    }

    #[test]
    fn sanitizes_windows_reserved_download_names() {
        assert_eq!(sanitize_local_name("a:b.txt"), "a_b.txt");
        assert_eq!(sanitize_local_name("CON"), "_CON");
        assert_eq!(sanitize_local_name("lpt1.txt"), "_lpt1.txt");
        assert_eq!(sanitize_local_name("name. "), "name");
    }

    #[test]
    fn invalidates_transport_failures_but_not_server_rejections() {
        assert!(should_invalidate_session(
            &russh_sftp::client::error::Error::Timeout
        ));
        assert!(!should_invalidate_session(
            &russh_sftp::client::error::Error::Limited("too large".into())
        ));
        let status_error = |status_code| {
            russh_sftp::client::error::Error::Status(russh_sftp::protocol::Status {
                id: 1,
                status_code,
                error_message: String::new(),
                language_tag: String::new(),
            })
        };
        assert!(should_invalidate_session(&status_error(
            russh_sftp::protocol::StatusCode::ConnectionLost
        )));
        assert!(!should_invalidate_session(&status_error(
            russh_sftp::protocol::StatusCode::PermissionDenied
        )));
    }

    #[test]
    fn preserved_permissions_do_not_overwrite_remote_metadata() {
        let attributes = permission_attributes(0o100644);

        assert_eq!(attributes.permissions, Some(0o100644));
        assert_eq!(attributes.size, None);
        assert_eq!(attributes.uid, None);
        assert_eq!(attributes.gid, None);
        assert_eq!(attributes.atime, None);
        assert_eq!(attributes.mtime, None);
    }
}
