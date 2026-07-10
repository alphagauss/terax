//! SFTP-backed remote filesystem.
//!
//! The public operations follow CrabPort's SFTP API boundaries. Recursive
//! transfer and deletion behavior is adapted from meatshell's `sftp.rs`, while
//! the implementation uses russh-sftp's current high-level async API.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use russh_sftp::protocol::FileType;
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

pub async fn session(
    workspace: &Arc<RemoteWorkspace>,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let mut cached = workspace.sftp.lock().await;
    if let Some(session) = cached.as_ref() {
        return Ok(session.clone());
    }
    let channel = {
        let handle = workspace.handle.lock().await;
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("open SFTP channel: {e}"))?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("request SFTP subsystem: {e}"))?;
    let session = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("initialize SFTP: {e}"))?;
    session.set_timeout(30);
    let session = Arc::new(session);
    *cached = Some(session.clone());
    Ok(session)
}

pub async fn read_dir(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    show_hidden: bool,
) -> Result<Vec<RemoteDirEntry>, String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    let read = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("read remote directory {path}: {e}"))?;
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
    let sftp = session(workspace).await?;
    let link_metadata = sftp
        .symlink_metadata(path)
        .await
        .map_err(|e| format!("stat remote path {path}: {e}"))?;
    // Match the local backend: preserve the symlink kind while reporting the
    // target's size and mtime. This keeps editor size/conflict checks correct
    // for files opened through a symlink.
    let target_metadata = sftp.metadata(path).await.ok();
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
    session(workspace)
        .await?
        .canonicalize(path)
        .await
        .map_err(|e| format!("canonicalize remote path {path}: {e}"))
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
    let file = session(workspace)
        .await?
        .open(path)
        .await
        .map_err(|e| format!("open remote file {path}: {e}"))?;
    let mut output = Vec::with_capacity(metadata.size.min(limit).min(1024 * 1024) as usize);
    let mut bounded = file.take(limit.saturating_add(1));
    bounded
        .read_to_end(&mut output)
        .await
        .map_err(|e| format!("read remote file {path}: {e}"))?;
    if output.len() as u64 > limit {
        return Err(format!("REMOTE_FILE_TOO_LARGE:{}:{limit}", output.len()));
    }
    Ok(output)
}

pub async fn write_file(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
) -> Result<u64, String> {
    validate_remote_path(path)?;
    let mut file = session(workspace)
        .await?
        .create(path)
        .await
        .map_err(|e| format!("create remote file {path}: {e}"))?;
    file.write_all(content)
        .await
        .map_err(|e| format!("write remote file {path}: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("close remote file {path}: {e}"))?;
    Ok(stat(workspace, path)
        .await
        .map(|value| value.mtime)
        .unwrap_or(0))
}

pub async fn create_file(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    if sftp.try_exists(path).await.map_err(|e| e.to_string())? {
        return Err(format!("already exists: {path}"));
    }
    sftp.create(path)
        .await
        .map_err(|e| format!("create remote file {path}: {e}"))?
        .shutdown()
        .await
        .map_err(|e| e.to_string())
}

pub async fn create_dir(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    if sftp.try_exists(path).await.map_err(|e| e.to_string())? {
        return Err(format!("already exists: {path}"));
    }
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        "/".to_string()
    } else {
        String::new()
    };
    for component in path.split('/').filter(|part| !part.is_empty()) {
        current = join_remote(&current, component);
        if !sftp.try_exists(&current).await.map_err(|e| e.to_string())? {
            sftp.create_dir(&current)
                .await
                .map_err(|e| format!("create remote directory {current}: {e}"))?;
        }
    }
    Ok(())
}

pub async fn rename(workspace: &Arc<RemoteWorkspace>, from: &str, to: &str) -> Result<(), String> {
    validate_remote_path(from)?;
    validate_remote_path(to)?;
    let sftp = session(workspace).await?;
    if !sftp.try_exists(from).await.map_err(|e| e.to_string())? {
        return Err(format!("not found: {from}"));
    }
    if sftp.try_exists(to).await.map_err(|e| e.to_string())? {
        return Err(format!("already exists: {to}"));
    }
    sftp.rename(from, to)
        .await
        .map_err(|e| format!("rename remote path {from} to {to}: {e}"))
}

pub async fn delete(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_destructive_path(path)?;
    let metadata = stat(workspace, path).await?;
    let sftp = session(workspace).await?;
    if metadata.kind != RemoteEntryKind::Dir {
        return sftp
            .remove_file(path)
            .await
            .map_err(|e| format!("remove remote file {path}: {e}"));
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
                sftp.remove_file(&child)
                    .await
                    .map_err(|e| format!("remove remote file {child}: {e}"))?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        sftp.remove_dir(&directory)
            .await
            .map_err(|e| format!("remove remote directory {directory}: {e}"))?;
    }
    Ok(())
}

pub async fn upload_sources(
    workspace: &Arc<RemoteWorkspace>,
    sources: &[String],
    remote_dir: &str,
) -> Result<(), String> {
    for source in sources {
        upload_path(workspace, Path::new(source), remote_dir).await?;
    }
    Ok(())
}

pub async fn upload_path(
    workspace: &Arc<RemoteWorkspace>,
    local_path: &Path,
    remote_parent: &str,
) -> Result<(), String> {
    let name = local_name(local_path)?;
    let remote_root = join_remote(remote_parent, &name);
    if local_path.is_file() {
        let data = tokio::fs::read(local_path)
            .await
            .map_err(|e| format!("read local file {}: {e}", local_path.display()))?;
        return write_file(workspace, &remote_root, &data).await.map(|_| ());
    }
    if !local_path.is_dir() {
        return Err(format!("unsupported local path: {}", local_path.display()));
    }
    let sftp = session(workspace).await?;
    let mut pending = vec![(local_path.to_path_buf(), remote_root)];
    while let Some((local_dir, remote_dir)) = pending.pop() {
        if !sftp
            .try_exists(&remote_dir)
            .await
            .map_err(|e| e.to_string())?
        {
            sftp.create_dir(&remote_dir)
                .await
                .map_err(|e| e.to_string())?;
        }
        let mut entries = tokio::fs::read_dir(&local_dir)
            .await
            .map_err(|e| format!("read local directory {}: {e}", local_dir.display()))?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
            let name = local_name(&entry.path())?;
            let remote = join_remote(&remote_dir, &name);
            if file_type.is_dir() {
                pending.push((entry.path(), remote));
            } else if file_type.is_file() {
                let data = tokio::fs::read(entry.path())
                    .await
                    .map_err(|e| e.to_string())?;
                write_file(workspace, &remote, &data).await?;
            }
        }
    }
    Ok(())
}

pub async fn download_path(
    workspace: &Arc<RemoteWorkspace>,
    remote_path: &str,
    local_parent: &Path,
) -> Result<PathBuf, String> {
    let metadata = stat(workspace, remote_path).await?;
    let name = remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "cannot download remote root".to_string())?;
    let local_root = local_parent.join(sanitize_local_name(name));
    if metadata.kind != RemoteEntryKind::Dir {
        let data = read_file(workspace, remote_path, u64::MAX).await?;
        tokio::fs::write(&local_root, data)
            .await
            .map_err(|e| format!("write local file {}: {e}", local_root.display()))?;
        return Ok(local_root);
    }
    let mut pending = vec![(remote_path.to_string(), local_root.clone())];
    while let Some((remote_dir, local_dir)) = pending.pop() {
        tokio::fs::create_dir_all(&local_dir)
            .await
            .map_err(|e| format!("create local directory {}: {e}", local_dir.display()))?;
        for entry in read_dir(workspace, &remote_dir, true).await? {
            let remote = join_remote(&remote_dir, &entry.name);
            let local = local_dir.join(sanitize_local_name(&entry.name));
            if entry.kind == RemoteEntryKind::Dir {
                pending.push((remote, local));
            } else {
                let data = read_file(workspace, &remote, u64::MAX).await?;
                tokio::fs::write(&local, data)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(local_root)
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

fn local_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("invalid local path: {}", path.display()))
}

fn sanitize_local_name(name: &str) -> String {
    let value: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            value if value.is_control() => '_',
            value => value,
        })
        .collect();
    if value.is_empty() || value == "." || value == ".." {
        "download".into()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::validate_destructive_path;

    #[test]
    fn destructive_paths_reject_root_and_parent_traversal() {
        for path in ["/", "//", ".", "..", "/tmp/..", "a/../b", "a/./b"] {
            assert!(validate_destructive_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_destructive_path("/home/me/project/file.txt").is_ok());
        assert!(validate_destructive_path("relative/file.txt").is_ok());
    }
}
