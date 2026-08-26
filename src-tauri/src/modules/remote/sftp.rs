//! 基于 SFTP 的远程文件系统实现。
//!
//! Explorer 使用不查询扩展的 raw session 流水线读取目录；文件内容操作由上层服务
//! 选择后端，本模块只实现默认 SFTP 传输 primitive；摘要、原子提交和递归变更由
//! 上层文件服务与封闭任务模块管理。

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use futures_util::stream::{FuturesUnordered, StreamExt};
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use tokio::io::AsyncWriteExt;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use super::file_service::{
    RemoteCheckedWrite, RemoteFileRead, RemoteObservedVersion, RemoteVersion,
};
use super::session::{join_remote, validate_remote_path, RemoteWorkspace};
use super::tasks::sftp_fallback::{self, RemoteCommit};
use super::tasks::TaskKind;

const DIRECTORY_READ_PIPELINE: usize = 2;
const FILE_READ_PIPELINE: usize = 8;
const DEFAULT_FILE_READ_CHUNK: u32 = 240 * 1024;

/// 目录与文件正文读取共享的 raw SFTP session 及服务端读取能力。
pub(crate) struct RemoteReadSession {
    pub(crate) session: Arc<russh_sftp::client::RawSftpSession>,
    supports_limits: bool,
    read_len: OnceCell<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileReadChunk {
    offset: u64,
    len: u32,
}

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

/// 属性页使用的一次 LSTAT 结果，保留服务端可选的 POSIX 身份字段。
#[derive(Clone, Debug)]
pub struct RemotePropertyStat {
    pub kind: RemoteEntryKind,
    pub size: u64,
    pub atime: Option<u64>,
    pub mtime: Option<u64>,
    pub permissions: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
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
    walk_cancellable(workspace, root, show_hidden, max_depth, max_entries, None).await
}

/// 递归枚举远端树，并允许交互式调用在目录边界停止后续 SFTP 请求。
pub(crate) async fn walk_cancellable(
    workspace: &Arc<RemoteWorkspace>,
    root: &str,
    show_hidden: bool,
    max_depth: usize,
    max_entries: usize,
    cancellation: Option<&CancellationToken>,
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
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(super::session::EXEC_CANCELLED_ERROR.into());
        }
        if depth >= max_depth {
            continue;
        }
        for entry in read_dir(workspace, &directory, show_hidden).await? {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(super::session::EXEC_CANCELLED_ERROR.into());
            }
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
            if entry.kind == RemoteEntryKind::Dir {
                if PRUNE.contains(&entry.name.as_str()) {
                    continue;
                }
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
    let mut cached = workspace.remote_fs.session.lock().await;
    if let Some(session) = cached.as_ref() {
        return Ok(session.clone());
    }
    let session = open_cached_session(workspace).await?;
    *cached = Some(session.clone());
    Ok(session)
}

/// 提前建立目录和文件正文读取共享的标准 SFTP v3 session。
pub async fn warm_read_session(workspace: &Arc<RemoteWorkspace>) -> Result<(), String> {
    read_session(workspace).await.map(|_| ())
}

/// 提前建立普通文件、元数据和修改操作复用的高层 SFTP session。
pub async fn warm_file_session(workspace: &Arc<RemoteWorkspace>) -> Result<(), String> {
    session(workspace).await.map(|_| ())
}

/// 返回目录和文件正文读取共享的 raw SFTP session。
async fn read_session(workspace: &Arc<RemoteWorkspace>) -> Result<Arc<RemoteReadSession>, String> {
    let mut cached = workspace.remote_fs.read_session.lock().await;
    if let Some(session) = cached.as_ref() {
        return Ok(session.clone());
    }
    let channel = workspace
        .handle
        .channel_open_session()
        .await
        .map_err(|error| format!("open directory SFTP channel: {error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("request directory SFTP subsystem: {error}"))?;
    let session = russh_sftp::client::RawSftpSession::new(channel.into_stream());
    let version = session
        .init()
        .await
        .map_err(|error| format!("initialize directory SFTP: {error}"))?;
    session.set_timeout(30);
    let session = Arc::new(RemoteReadSession {
        session: Arc::new(session),
        supports_limits: version
            .extensions
            .get(russh_sftp::extensions::LIMITS)
            .is_some_and(|value| value == "1"),
        read_len: OnceCell::new(),
    });
    *cached = Some(session.clone());
    Ok(session)
}

async fn invalidate_read_session(
    workspace: &Arc<RemoteWorkspace>,
    failed: &Arc<RemoteReadSession>,
) {
    let mut cached = workspace.remote_fs.read_session.lock().await;
    if cached
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, failed))
    {
        *cached = None;
    }
}

/// 创建仅供 Explorer 和普通文件操作复用的缓存 SFTP 会话。
async fn open_cached_session(
    workspace: &Arc<RemoteWorkspace>,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    let channel = workspace
        .handle
        .channel_open_session()
        .await
        .map_err(|error| format!("open SFTP channel: {error}"))?;
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
    let mut cached = workspace.remote_fs.session.lock().await;
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
            if should_fail_transport(&error) {
                workspace.report_transport_failure();
            }
            if should_invalidate_session(&error) {
                invalidate_session(workspace, session).await;
            }
            Err(format!("{context}: {error}"))
        }
    }
}

/// 将远端目标不存在转换为 `None`，其余错误仍按传输语义处理。
async fn optional_sftp_result<T>(
    workspace: &Arc<RemoteWorkspace>,
    session: &Arc<russh_sftp::client::SftpSession>,
    context: String,
    result: Result<T, russh_sftp::client::error::Error>,
) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(None)
        }
        Err(error) => {
            if should_fail_transport(&error) {
                workspace.report_transport_failure();
            }
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
                if should_fail_transport(&error) {
                    workspace.report_transport_failure();
                    return Err(format!("{context}: {error}"));
                }
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

/// 仅将明确的连接关闭上报给 Runtime，普通 SFTP 超时仍允许重建子会话。
fn should_fail_transport(error: &russh_sftp::client::error::Error) -> bool {
    matches!(
        error,
        russh_sftp::client::error::Error::Status(status)
            if matches!(
                status.status_code,
                StatusCode::NoConnection | StatusCode::ConnectionLost
            )
    )
}

pub async fn read_dir(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    show_hidden: bool,
) -> Result<Vec<RemoteDirEntry>, String> {
    workspace
        .remote_fs
        .read_dir(workspace.clone(), path.to_string(), show_hidden)
        .await
}

/// 执行一次未合并的底层 SFTP 目录读取。
pub(crate) async fn read_dir_uncached(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<Vec<RemoteDirEntry>, String> {
    validate_remote_path(path)?;
    let session = read_session(workspace).await?;
    let read = match read_directory_pipelined(session.session.clone(), path).await {
        Ok(entries) => entries,
        Err(error) if should_invalidate_session(&error) => {
            if should_fail_transport(&error) {
                workspace.report_transport_failure();
                return Err(format!("read remote directory {path}: {error}"));
            }
            invalidate_read_session(workspace, &session).await;
            let retry = read_session(workspace).await?;
            match read_directory_pipelined(retry.session.clone(), path).await {
                Ok(entries) => entries,
                Err(retry_error) => {
                    if should_fail_transport(&retry_error) {
                        workspace.report_transport_failure();
                    }
                    if should_invalidate_session(&retry_error) {
                        invalidate_read_session(workspace, &retry).await;
                    }
                    return Err(format!("read remote directory {path}: {retry_error}"));
                }
            }
        }
        Err(error) => return Err(format!("read remote directory {path}: {error}")),
    };
    let mut entries = Vec::new();
    for entry in read {
        let name = entry.filename;
        if name == "." || name == ".." {
            continue;
        }
        let metadata = entry.attrs;
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

/// 使用多个并发 READDIR 请求覆盖目录项与 EOF 的串行往返，CLOSE 在后台回收句柄。
async fn read_directory_pipelined(
    session: Arc<russh_sftp::client::RawSftpSession>,
    path: &str,
) -> Result<Vec<russh_sftp::protocol::File>, russh_sftp::client::error::Error> {
    let handle = session.opendir(path.to_string()).await?.handle;
    let mut pending = FuturesUnordered::new();
    for _ in 0..DIRECTORY_READ_PIPELINE {
        pending.push(session.readdir(handle.clone()));
    }
    let mut entries = Vec::new();
    let mut eof = false;
    while let Some(result) = pending.next().await {
        match result {
            Ok(names) => {
                entries.extend(names.files);
                if !eof {
                    pending.push(session.readdir(handle.clone()));
                }
            }
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::Eof =>
            {
                eof = true;
            }
            Err(error) => {
                let _ = session.close(handle).await;
                return Err(error);
            }
        }
    }
    let close_session = session.clone();
    tauri::async_runtime::spawn(async move {
        let _ = close_session.close(handle).await;
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

/// 判断远端路径是否存在，并保留连接或权限错误，供拒绝覆盖的调用方安全区分失败与缺失。
pub(crate) async fn exists(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<bool, String> {
    validate_remote_path(path)?;
    let remote_path = path.to_string();
    retry_sftp_read(
        workspace,
        format!("check remote path {path}"),
        move |sftp| {
            let path = remote_path.clone();
            Box::pin(async move { sftp.try_exists(path).await })
        },
    )
    .await
}

/// 使用一次 LSTAT 读取属性页所需的远端元数据，不跟随符号链接。
pub async fn property_stat(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<RemotePropertyStat, String> {
    validate_remote_path(path)?;
    let remote_path = path.to_string();
    let metadata = retry_sftp_read(
        workspace,
        format!("read remote properties {path}"),
        move |sftp| {
            let path = remote_path.clone();
            Box::pin(async move { sftp.symlink_metadata(path).await })
        },
    )
    .await?;
    Ok(RemotePropertyStat {
        kind: entry_kind(metadata.file_type()),
        size: metadata.len(),
        atime: metadata.atime.map(|value| u64::from(value) * 1000),
        mtime: metadata.mtime.map(|value| u64::from(value) * 1000),
        permissions: metadata.permissions.map(|value| value & 0o7777),
        uid: metadata.uid,
        gid: metadata.gid,
        user: metadata.user,
        group: metadata.group,
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
    match read_file_snapshot(workspace, path, limit).await? {
        RemoteFileRead::Content { bytes, .. } => Ok(bytes),
        RemoteFileRead::TooLarge { size, .. } => {
            Err(format!("REMOTE_FILE_TOO_LARGE:{size}:{limit}"))
        }
    }
}

/// 并发取得目标元数据与文件 handle，再流水线读取已确认大小的正文。
///
/// 小文件只保留 `STAT + OPEN` 和 `READ` 两个依赖阶段；大文件按固定 offset 维持
/// 有上限的 in-flight 请求，响应可以乱序到达，不再按块串行等待 RTT。
pub(crate) async fn read_file_snapshot(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    limit: u64,
) -> Result<RemoteFileRead, String> {
    validate_remote_path(path)?;
    let context = format!("read remote file {path}");
    for attempt in 0..2 {
        let current = read_session(workspace).await?;
        match read_file_snapshot_once(current.clone(), path, limit).await {
            Ok(value) => return Ok(value),
            Err(error) if should_invalidate_session(&error) => {
                if should_fail_transport(&error) {
                    workspace.report_transport_failure();
                    return Err(format!("{context}: {error}"));
                }
                invalidate_read_session(workspace, &current).await;
                if attempt == 1 {
                    return Err(format!("{context}: {error}"));
                }
            }
            Err(error) => return Err(format!("{context}: {error}")),
        }
    }
    unreachable!("raw SFTP read retry loop always returns")
}

/// 在一次 raw session 上完成元数据、handle 和正文读取。
async fn read_file_snapshot_once(
    read_session: Arc<RemoteReadSession>,
    path: &str,
    limit: u64,
) -> Result<RemoteFileRead, russh_sftp::client::error::Error> {
    let session = read_session.session.clone();
    let metadata_path = path.to_string();
    let open_path = path.to_string();
    let (chunk_len, metadata, opened) = tokio::join!(
        file_read_chunk_len(&read_session),
        session.stat(metadata_path),
        session.open(open_path, OpenFlags::READ, FileAttributes::empty()),
    );
    let (metadata, handle) = match (metadata, opened) {
        (Ok(metadata), Ok(handle)) => (metadata.attrs, handle.handle),
        (Err(error), Ok(handle)) => {
            close_read_handle(session, handle.handle);
            return Err(error);
        }
        (Ok(_), Err(error)) | (Err(error), Err(_)) => return Err(error),
    };
    let size = metadata.len();
    let mtime = remote_mtime(&metadata);
    if size > limit {
        close_read_handle(session, handle);
        return Ok(RemoteFileRead::TooLarge { size, mtime });
    }
    let bytes = match read_file_pipelined(session.clone(), handle.clone(), size, chunk_len).await {
        Ok(bytes) => bytes,
        Err(error) => {
            close_read_handle(session, handle);
            return Err(error);
        }
    };
    close_read_handle(session, handle);
    Ok(RemoteFileRead::Content { bytes, size, mtime })
}

/// 首次文件读取时并行查询服务端 limits，失败时使用保守块大小。
async fn file_read_chunk_len(session: &RemoteReadSession) -> u32 {
    *session
        .read_len
        .get_or_init(|| async {
            if !session.supports_limits {
                return DEFAULT_FILE_READ_CHUNK;
            }
            session
                .session
                .limits()
                .await
                .ok()
                .and_then(|limits| u32::try_from(limits.max_read_len).ok())
                .filter(|limit| *limit > 0)
                .map(|limit| limit.min(DEFAULT_FILE_READ_CHUNK))
                .unwrap_or(DEFAULT_FILE_READ_CHUNK)
        })
        .await
}

/// 按 offset 规划完整且不重叠的文件读取块。
#[cfg(test)]
fn plan_file_read_chunks(size: u64, chunk_len: u32) -> VecDeque<FileReadChunk> {
    plan_file_read_range_chunks(0, size, chunk_len)
}

/// 从绝对 offset 规划一个完整且不重叠的有界读取区间。
fn plan_file_read_range_chunks(
    start_offset: u64,
    size: u64,
    chunk_len: u32,
) -> VecDeque<FileReadChunk> {
    debug_assert!(chunk_len > 0);
    let mut chunks = VecDeque::new();
    let mut consumed = 0;
    while consumed < size {
        let len = (size - consumed).min(u64::from(chunk_len)) as u32;
        let offset = start_offset.saturating_add(consumed);
        chunks.push_back(FileReadChunk { offset, len });
        consumed += u64::from(len);
    }
    chunks
}

/// 在单个 handle 上维持固定数量的并发 offset 读取，并按位置组装乱序响应。
async fn read_file_pipelined(
    session: Arc<russh_sftp::client::RawSftpSession>,
    handle: String,
    size: u64,
    chunk_len: u32,
) -> Result<Vec<u8>, russh_sftp::client::error::Error> {
    read_file_range_pipelined(
        session,
        handle,
        0,
        size,
        chunk_len,
        FILE_READ_PIPELINE,
    )
    .await
}

/// 在单个 handle 上流水线读取绝对 offset 对应的有界区间。
async fn read_file_range_pipelined(
    session: Arc<russh_sftp::client::RawSftpSession>,
    handle: String,
    base_offset: u64,
    size: u64,
    chunk_len: u32,
    max_inflight: usize,
) -> Result<Vec<u8>, russh_sftp::client::error::Error> {
    let output_len = usize::try_from(size).map_err(|_| {
        russh_sftp::client::error::Error::UnexpectedBehavior(
            "remote file does not fit in local memory".into(),
        )
    })?;
    let mut output = vec![0; output_len];
    let mut queued = plan_file_read_range_chunks(base_offset, size, chunk_len);
    let mut pending = FuturesUnordered::new();
    fill_file_read_pipeline(
        &mut pending,
        &mut queued,
        &session,
        &handle,
        max_inflight,
    );

    while let Some((chunk, result)) = pending.next().await {
        let data = result?.data;
        if data.is_empty() || data.len() > chunk.len as usize {
            return Err(russh_sftp::client::error::Error::UnexpectedBehavior(
                "remote file returned an invalid read length".into(),
            ));
        }
        let start = usize::try_from(chunk.offset.saturating_sub(base_offset)).map_err(|_| {
            russh_sftp::client::error::Error::UnexpectedBehavior(
                "remote file offset does not fit in local memory".into(),
            )
        })?;
        let end = start.checked_add(data.len()).ok_or_else(|| {
            russh_sftp::client::error::Error::UnexpectedBehavior(
                "remote file read overflowed its destination".into(),
            )
        })?;
        if end > output.len() {
            return Err(russh_sftp::client::error::Error::UnexpectedBehavior(
                "remote file read exceeded its declared size".into(),
            ));
        }
        output[start..end].copy_from_slice(&data);
        if data.len() < chunk.len as usize {
            queued.push_front(FileReadChunk {
                offset: chunk.offset + data.len() as u64,
                len: chunk.len - data.len() as u32,
            });
        }
        fill_file_read_pipeline(
            &mut pending,
            &mut queued,
            &session,
            &handle,
            max_inflight,
        );
    }
    Ok(output)
}

/// 将待处理块补充到固定并发上限。
fn fill_file_read_pipeline(
    pending: &mut FuturesUnordered<FileReadFuture>,
    queued: &mut VecDeque<FileReadChunk>,
    session: &Arc<russh_sftp::client::RawSftpSession>,
    handle: &str,
    max_inflight: usize,
) {
    debug_assert!(max_inflight > 0);
    while pending.len() < max_inflight {
        let Some(chunk) = queued.pop_front() else {
            break;
        };
        pending.push(Box::pin(read_file_chunk(
            session.clone(),
            handle.to_string(),
            chunk,
        )));
    }
}

type FileReadResult = (
    FileReadChunk,
    Result<russh_sftp::protocol::Data, russh_sftp::client::error::Error>,
);
type FileReadFuture = Pin<Box<dyn Future<Output = FileReadResult> + Send>>;

/// 发送一个带固定 offset 的 raw SFTP READ。
async fn read_file_chunk(
    session: Arc<russh_sftp::client::RawSftpSession>,
    handle: String,
    chunk: FileReadChunk,
) -> FileReadResult {
    let result = session.read(handle, chunk.offset, chunk.len).await;
    (chunk, result)
}

/// 后台关闭已完成或失败的读取 handle，不把 CLOSE 往返加入用户可见延迟。
fn close_read_handle(session: Arc<russh_sftp::client::RawSftpSession>, handle: String) {
    tauri::async_runtime::spawn(async move {
        let _ = session.close(handle).await;
    });
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
    let (sftp, target, permissions) = prepare_remote_write(workspace, path).await?;
    sftp_fallback::ensure_available(workspace, TaskKind::SftpReplace)?;
    let (temporary, channel) =
        stage_remote_write_and_open_commit(workspace, &sftp, &target, permissions, content).await?;
    if let Some(written) =
        replace_remote_file(workspace, &sftp, channel, &temporary, &target).await?
    {
        return Ok(written.mtime);
    }
    let metadata = sftp_result(
        workspace,
        &sftp,
        format!("read written remote file metadata {target}"),
        sftp.metadata(&target).await,
    )
    .await?;
    Ok(remote_mtime(&metadata))
}

/// 仅在远端目标仍不存在时原子创建文件。
///
/// 临时文件与目标位于同一目录，最终通过硬链接执行原子 no-clobber 发布；目标在审批后
/// 出现时返回冲突，不能退化为覆盖。
pub(crate) async fn write_file_missing(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
) -> Result<RemoteCheckedWrite, String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    let target = canonical_target_for_new_file(workspace, &sftp, path).await?;
    sftp_fallback::ensure_available(workspace, TaskKind::SftpCommitMissing)?;
    let (temporary, channel) =
        stage_remote_write_and_open_commit(workspace, &sftp, &target, None, content).await?;
    let outcome = sftp_fallback::commit_missing(workspace, channel, &temporary, &target).await;
    match outcome {
        Ok(RemoteCommit::Complete(Some(written))) => Ok(RemoteCheckedWrite::Written {
            mtime: written.mtime,
        }),
        Ok(RemoteCommit::Complete(None)) => {
            let metadata = sftp_result(
                workspace,
                &sftp,
                format!("read created remote file metadata {target}"),
                sftp.metadata(&target).await,
            )
            .await?;
            Ok(RemoteCheckedWrite::Written {
                mtime: remote_mtime(&metadata),
            })
        }
        Ok(RemoteCommit::Conflict(Some(current))) => Ok(RemoteCheckedWrite::Conflict {
            current: Some(current),
        }),
        Ok(RemoteCommit::Conflict(None)) => {
            let current = optional_sftp_result(
                workspace,
                &sftp,
                format!("read conflicting remote file metadata {target}"),
                sftp.metadata(&target).await,
            )
            .await?
            .map(|metadata| remote_observed(&metadata));
            Ok(RemoteCheckedWrite::Conflict { current })
        }
        Ok(RemoteCommit::Missing) => Err("remote missing-only write returned missing".into()),
        Err(error) => {
            let _ = sftp.remove_file(&temporary).await;
            Err(error)
        }
    }
}

/// 解析现有远端文件并读取一次目标元数据，不额外执行存在性探测。
async fn existing_remote_file(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<Option<(Arc<russh_sftp::client::SftpSession>, String, FileAttributes)>, String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    let Some(target) = optional_sftp_result(
        workspace,
        &sftp,
        format!("canonicalize remote file {path}"),
        sftp.canonicalize(path).await,
    )
    .await?
    else {
        return Ok(None);
    };
    let Some(metadata) = optional_sftp_result(
        workspace,
        &sftp,
        format!("read remote file metadata {target}"),
        sftp.metadata(&target).await,
    )
    .await?
    else {
        return Ok(None);
    };
    Ok(Some((sftp, target, metadata)))
}

/// 在远端计算文件版本，只返回元数据和摘要。
pub(crate) async fn file_version(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    max_size: u64,
) -> Result<Option<RemoteVersion>, String> {
    let Some((sftp, target, before)) = existing_remote_file(workspace, path).await? else {
        return Ok(None);
    };
    if before.len() > max_size {
        return Err(format!("remote file exceeds version limit: {max_size}"));
    }
    let revision = sftp_fallback::sha256(workspace, &target).await?;
    let after = sftp_result(
        workspace,
        &sftp,
        format!("verify remote file metadata {target}"),
        sftp.metadata(&target).await,
    )
    .await?;
    if remote_observed(&before) != remote_observed(&after) {
        return Err("remote file changed while computing its revision".into());
    }
    Ok(Some(RemoteVersion {
        revision,
        size: after.len(),
        mtime: remote_mtime(&after),
    }))
}

/// 在远端数据源上校验摘要并提交临时文件，正常保存不下载旧文件正文。
pub(crate) async fn write_file_checked(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
    content: &[u8],
    expected: &RemoteVersion,
    replacement_revision: &str,
) -> Result<RemoteCheckedWrite, String> {
    let Some((sftp, target, metadata)) = existing_remote_file(workspace, path).await? else {
        return Ok(RemoteCheckedWrite::Conflict { current: None });
    };
    let current = remote_observed(&metadata);
    if current.size != expected.size {
        return Ok(RemoteCheckedWrite::Conflict {
            current: Some(current),
        });
    }
    if current.mtime != expected.mtime {
        let revision = sftp_fallback::sha256(workspace, &target).await?;
        let Some(after) = optional_sftp_result(
            workspace,
            &sftp,
            format!("verify remote file metadata {target}"),
            sftp.metadata(&target).await,
        )
        .await?
        else {
            return Ok(RemoteCheckedWrite::Conflict { current: None });
        };
        let verified = remote_observed(&after);
        if verified != current {
            return Ok(RemoteCheckedWrite::Conflict {
                current: Some(verified),
            });
        }
        if revision == replacement_revision {
            return Ok(RemoteCheckedWrite::Written {
                mtime: verified.mtime,
            });
        }
        if revision != expected.revision {
            return Ok(RemoteCheckedWrite::Conflict {
                current: Some(verified),
            });
        }
    }

    sftp_fallback::ensure_available(workspace, TaskKind::SftpCommitChecked)?;
    let (temporary, channel) = stage_remote_write_and_open_commit(
        workspace,
        &sftp,
        &target,
        metadata.permissions,
        content,
    )
    .await?;
    let outcome = sftp_fallback::commit_checked(
        workspace,
        channel,
        &temporary,
        &target,
        &expected.revision,
        replacement_revision,
    )
    .await;
    match outcome {
        Ok(RemoteCommit::Complete(Some(written))) => Ok(RemoteCheckedWrite::Written {
            mtime: written.mtime,
        }),
        Ok(RemoteCommit::Complete(None)) => {
            let metadata = sftp_result(
                workspace,
                &sftp,
                format!("read committed remote file metadata {target}"),
                sftp.metadata(&target).await,
            )
            .await?;
            Ok(RemoteCheckedWrite::Written {
                mtime: remote_mtime(&metadata),
            })
        }
        Ok(RemoteCommit::Missing) => Ok(RemoteCheckedWrite::Conflict { current: None }),
        Ok(RemoteCommit::Conflict(Some(current))) => Ok(RemoteCheckedWrite::Conflict {
            current: Some(current),
        }),
        Ok(RemoteCommit::Conflict(None)) => {
            let metadata = sftp_result(
                workspace,
                &sftp,
                format!("read conflicting remote file metadata {target}"),
                sftp.metadata(&target).await,
            )
            .await?;
            Ok(RemoteCheckedWrite::Conflict {
                current: Some(remote_observed(&metadata)),
            })
        }
        Err(error) => {
            let _ = sftp.remove_file(&temporary).await;
            Err(error)
        }
    }
}

async fn prepare_remote_write(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<(Arc<russh_sftp::client::SftpSession>, String, Option<u32>), String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    let existing = optional_sftp_result(
        workspace,
        &sftp,
        format!("canonicalize remote file {path}"),
        sftp.canonicalize(path).await,
    )
    .await?;
    let existing = if let Some(target) = existing {
        let metadata = optional_sftp_result(
            workspace,
            &sftp,
            format!("read remote file metadata {target}"),
            sftp.metadata(&target).await,
        )
        .await?;
        existing_write_target(target, metadata)
    } else {
        None
    };
    let (target, permissions) = if let Some(existing) = existing {
        existing
    } else {
        (
            canonical_target_for_new_file(workspace, &sftp, path).await?,
            None,
        )
    };
    Ok((sftp, target, permissions))
}

/// 只有规范路径和元数据同时存在时才将目标视为现有文件。
///
/// 部分 OpenSSH 服务端会为不存在的末级路径返回成功的 `REALPATH`，不能仅凭规范路径
/// 继承权限或跳过新文件的父目录解析。
fn existing_write_target(
    target: String,
    metadata: Option<FileAttributes>,
) -> Option<(String, Option<u32>)> {
    metadata.map(|metadata| (target, metadata.permissions))
}

/// 上传排他临时文件，同时预开仅在上传成功后使用的提交 channel。
///
/// 两条并发分支任一失败都会关闭或删除另一条已经创建的资源，远端不会遗留仅为本次
/// 提交准备的 channel 或临时文件。
async fn stage_remote_write_and_open_commit(
    workspace: &Arc<RemoteWorkspace>,
    sftp: &Arc<russh_sftp::client::SftpSession>,
    target: &str,
    permissions: Option<u32>,
    content: &[u8],
) -> Result<(String, russh::Channel<russh::client::Msg>), String> {
    let temporary = temporary_sibling(target)?;
    let (stage_result, channel_result) = tokio::join!(
        stage_remote_write(workspace, sftp, &temporary, permissions, content),
        workspace.open_exec_channel(),
    );
    match (stage_result, channel_result) {
        (Ok(()), Ok(channel)) => Ok((temporary, channel)),
        (Err(stage_error), Ok(channel)) => {
            let _ = channel.close().await;
            Err(stage_error)
        }
        (Ok(()), Err(channel_error)) => {
            let _ = sftp.remove_file(&temporary).await;
            Err(channel_error)
        }
        (Err(stage_error), Err(_)) => Err(stage_error),
    }
}

/// 将新内容上传到目标同目录的排他临时文件。
///
/// `russh-sftp` 的 `flush()` 会先等待全部写入确认，再在服务端支持时执行一次
/// `fsync@openssh.com`；因此不能再调用 `sync_all()` 重复一次高延迟往返。
async fn stage_remote_write(
    workspace: &Arc<RemoteWorkspace>,
    sftp: &Arc<russh_sftp::client::SftpSession>,
    temporary: &str,
    permissions: Option<u32>,
    content: &[u8],
) -> Result<(), String> {
    let mut file = sftp_result(
        workspace,
        sftp,
        format!("create temporary remote file {temporary}"),
        sftp.open_with_flags(
            temporary,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await,
    )
    .await?;
    let write_and_flush = async {
        file.write_all(content)
            .await
            .map_err(|error| format!("write temporary remote file {temporary}: {error}"))?;
        file.flush()
            .await
            .map_err(|error| format!("flush temporary remote file {temporary}: {error}"))
    };
    let preserve_permissions = async {
        match permissions {
            Some(permissions) => {
                let attributes = permission_attributes(permissions);
                sftp.set_metadata(temporary, attributes).await
            }
            None => Ok(()),
        }
    };
    let (write_result, permissions_result) = tokio::join!(write_and_flush, preserve_permissions);
    if let Err(error) = write_result {
        invalidate_session(workspace, sftp).await;
        let _ = sftp.remove_file(temporary).await;
        return Err(error);
    }
    if let Err(error) = file.shutdown().await {
        invalidate_session(workspace, sftp).await;
        let _ = sftp.remove_file(temporary).await;
        return Err(format!("close temporary remote file {temporary}: {error}"));
    }
    if let Err(error) = permissions_result {
        if should_invalidate_session(&error) {
            invalidate_session(workspace, sftp).await;
        }
        let _ = sftp.remove_file(temporary).await;
        return Err(format!(
            "preserve permissions on temporary remote file {temporary}: {error}"
        ));
    }
    Ok(())
}

async fn replace_remote_file(
    workspace: &Arc<RemoteWorkspace>,
    sftp: &Arc<russh_sftp::client::SftpSession>,
    channel: russh::Channel<russh::client::Msg>,
    temporary: &str,
    target: &str,
) -> Result<Option<RemoteObservedVersion>, String> {
    match sftp_fallback::replace(workspace, channel, temporary, target).await {
        Ok(observed) => Ok(observed),
        Err(error) => {
            let _ = sftp.remove_file(temporary).await;
            Err(error)
        }
    }
}

fn remote_mtime(metadata: &FileAttributes) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn remote_observed(metadata: &FileAttributes) -> RemoteObservedVersion {
    RemoteObservedVersion {
        size: metadata.len(),
        mtime: remote_mtime(metadata),
    }
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

/// 使用单次 SFTP 请求删除文件或符号链接。
pub(crate) async fn remove_file(
    workspace: &Arc<RemoteWorkspace>,
    path: &str,
) -> Result<(), String> {
    validate_remote_path(path)?;
    let sftp = session(workspace).await?;
    sftp_result(
        workspace,
        &sftp,
        format!("remove remote file {path}"),
        sftp.remove_file(path).await,
    )
    .await
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
        existing_write_target, permission_attributes, plan_file_read_chunks,
        plan_file_read_range_chunks, remote_parent_name, sanitize_local_name,
        should_fail_transport, should_invalidate_session, FileReadChunk, DEFAULT_FILE_READ_CHUNK,
        FILE_READ_PIPELINE,
    };

    #[test]
    fn plans_file_reads_as_complete_non_overlapping_chunks() {
        let size = u64::from(DEFAULT_FILE_READ_CHUNK) * (FILE_READ_PIPELINE as u64 + 2) + 17;
        let chunks = plan_file_read_chunks(size, DEFAULT_FILE_READ_CHUNK);
        let mut expected_offset = 0;

        for chunk in &chunks {
            assert_eq!(chunk.offset, expected_offset);
            assert!(chunk.len > 0 && chunk.len <= DEFAULT_FILE_READ_CHUNK);
            expected_offset += u64::from(chunk.len);
        }
        assert_eq!(expected_offset, size);
        assert!(chunks.len() > FILE_READ_PIPELINE);
    }

    #[test]
    fn plans_empty_and_boundary_file_reads_without_eof_probe() {
        assert!(plan_file_read_chunks(0, DEFAULT_FILE_READ_CHUNK).is_empty());
        assert_eq!(
            plan_file_read_chunks(u64::from(DEFAULT_FILE_READ_CHUNK), DEFAULT_FILE_READ_CHUNK),
            std::collections::VecDeque::from([FileReadChunk {
                offset: 0,
                len: DEFAULT_FILE_READ_CHUNK,
            }])
        );
    }

    #[test]
    fn plans_log_ranges_with_absolute_offsets() {
        let chunks = plan_file_read_range_chunks(4096, 10, 4);
        assert_eq!(
            chunks,
            std::collections::VecDeque::from([
                FileReadChunk {
                    offset: 4096,
                    len: 4,
                },
                FileReadChunk {
                    offset: 4100,
                    len: 4,
                },
                FileReadChunk {
                    offset: 4104,
                    len: 2,
                },
            ])
        );
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
        assert!(should_fail_transport(&status_error(
            russh_sftp::protocol::StatusCode::ConnectionLost
        )));
        assert!(!should_fail_transport(&status_error(
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

    #[test]
    fn canonical_path_without_metadata_is_still_a_new_write_target() {
        assert_eq!(existing_write_target("/tmp/new.txt".into(), None), None);

        let existing = existing_write_target(
            "/tmp/existing.txt".into(),
            Some(permission_attributes(0o100751)),
        );
        assert_eq!(existing, Some(("/tmp/existing.txt".into(), Some(0o100751))));
    }
}
