//! 基于 SFTP 的远程文件系统实现。
//!
//! Explorer 使用不查询扩展的 raw session 流水线读取目录；文件内容操作由上层服务
//! 选择后端，本模块实现默认 SFTP 传输、原子提交和破坏性操作的安全约束。

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use futures_util::stream::{FuturesUnordered, StreamExt};
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use tokio::io::AsyncWriteExt;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use super::file_service::{
    RemoteCheckedWrite, RemoteFileRead, RemoteObservedVersion, RemoteVersion,
};
use super::session::{join_remote, shell_quote, validate_remote_path, RemoteWorkspace};

const RECURSIVE_DELETE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
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
fn plan_file_read_chunks(size: u64, chunk_len: u32) -> VecDeque<FileReadChunk> {
    debug_assert!(chunk_len > 0);
    let mut chunks = VecDeque::new();
    let mut offset = 0;
    while offset < size {
        let len = (size - offset).min(u64::from(chunk_len)) as u32;
        chunks.push_back(FileReadChunk { offset, len });
        offset += u64::from(len);
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
    let output_len = usize::try_from(size).map_err(|_| {
        russh_sftp::client::error::Error::UnexpectedBehavior(
            "remote file does not fit in local memory".into(),
        )
    })?;
    let mut output = vec![0; output_len];
    let mut queued = plan_file_read_chunks(size, chunk_len);
    let mut pending = FuturesUnordered::new();
    fill_file_read_pipeline(&mut pending, &mut queued, &session, &handle);

    while let Some((chunk, result)) = pending.next().await {
        let data = result?.data;
        if data.is_empty() || data.len() > chunk.len as usize {
            return Err(russh_sftp::client::error::Error::UnexpectedBehavior(
                "remote file returned an invalid read length".into(),
            ));
        }
        let start = usize::try_from(chunk.offset).map_err(|_| {
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
        fill_file_read_pipeline(&mut pending, &mut queued, &session, &handle);
    }
    Ok(output)
}

/// 将待处理块补充到固定并发上限。
fn fill_file_read_pipeline(
    pending: &mut FuturesUnordered<FileReadFuture>,
    queued: &mut VecDeque<FileReadChunk>,
    session: &Arc<russh_sftp::client::RawSftpSession>,
    handle: &str,
) {
    while pending.len() < FILE_READ_PIPELINE {
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
    let (temporary, channel) =
        stage_remote_write_and_open_commit(workspace, &sftp, &target, None, content).await?;
    let outcome = commit_remote_missing(workspace, channel, &temporary, &target).await;
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
    let revision = remote_sha256(workspace, &target).await?;
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
        let revision = remote_sha256(workspace, &target).await?;
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

    let (temporary, channel) = stage_remote_write_and_open_commit(
        workspace,
        &sftp,
        &target,
        metadata.permissions,
        content,
    )
    .await?;
    let outcome = commit_remote_checked(
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
    let command = format!(
        "target={target}; mv -f -- {temporary} \"$target\" || exit 74; \
         metadata=$(stat -c '%s %Y' -- \"$target\" 2>/dev/null) || metadata=; printf '%s' \"$metadata\"",
        temporary = shell_quote(temporary),
        target = shell_quote(target),
    );
    let moved = match workspace
        .exec_on_channel(channel, &command, None, std::time::Duration::from_secs(15))
        .await
    {
        Ok(moved) => moved,
        Err(error) => {
            let _ = sftp.remove_file(temporary).await;
            return Err(error);
        }
    };
    if moved.timed_out || moved.exit_code != Some(0) {
        let _ = sftp.remove_file(temporary).await;
        let detail = String::from_utf8_lossy(&moved.stderr).trim().to_string();
        return Err(if moved.timed_out {
            format!("timed out replacing remote file {target}")
        } else if detail.is_empty() {
            format!("replace remote file {target} failed")
        } else {
            format!("replace remote file {target} failed: {detail}")
        });
    }
    Ok(parse_remote_observed(&moved.stdout))
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

fn parse_sha256(output: &[u8]) -> Result<String, String> {
    let output = String::from_utf8_lossy(output);
    let revision = output
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "remote SHA-256 output is invalid".to_string())?;
    Ok(revision.to_ascii_lowercase())
}

async fn remote_sha256(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<String, String> {
    let path = shell_quote(path);
    let command = format!(
        "if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {path}; \
         elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {path}; \
         elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r {path}; \
         else exit 72; fi"
    );
    let output = workspace
        .exec(&command, None, Duration::from_secs(60))
        .await?;
    if output.timed_out || output.exit_code != Some(0) {
        return Err("remote SHA-256 command failed or is unavailable".into());
    }
    parse_sha256(&output.stdout)
}

#[derive(Debug, PartialEq, Eq)]
enum RemoteCommit {
    Complete(Option<RemoteObservedVersion>),
    Missing,
    Conflict(Option<RemoteObservedVersion>),
}

async fn commit_remote_checked(
    workspace: &Arc<RemoteWorkspace>,
    channel: russh::Channel<russh::client::Msg>,
    temporary: &str,
    target: &str,
    expected_revision: &str,
    replacement_revision: &str,
) -> Result<RemoteCommit, String> {
    let command =
        checked_commit_command(temporary, target, expected_revision, replacement_revision);
    let output = workspace
        .exec_on_channel(channel, &command, None, Duration::from_secs(60))
        .await?;
    if output.timed_out || output.exit_code != Some(0) {
        return Err("remote checked replace failed".into());
    }
    parse_remote_commit(&output.stdout)
        .map_err(|_| "remote checked replace returned an invalid status".into())
}

/// 在已预开的 channel 上原子发布一个仍缺失的远端目标。
async fn commit_remote_missing(
    workspace: &Arc<RemoteWorkspace>,
    channel: russh::Channel<russh::client::Msg>,
    temporary: &str,
    target: &str,
) -> Result<RemoteCommit, String> {
    let command = missing_commit_command(temporary, target);
    let output = workspace
        .exec_on_channel(channel, &command, None, Duration::from_secs(60))
        .await?;
    if output.timed_out || output.exit_code != Some(0) {
        return Err("remote missing-only write failed".into());
    }
    match parse_remote_commit(&output.stdout) {
        Ok(RemoteCommit::Complete(observed)) => Ok(RemoteCommit::Complete(observed)),
        Ok(RemoteCommit::Conflict(observed)) => Ok(RemoteCommit::Conflict(observed)),
        _ => Err("remote missing-only write returned an invalid status".into()),
    }
}

/// 解析提交状态及同一远端进程返回的可选 size、mtime。
fn parse_remote_commit(output: &[u8]) -> Result<RemoteCommit, String> {
    let mut fields = output.splitn(2, |byte| *byte == 0);
    let status = std::str::from_utf8(fields.next().unwrap_or_default())
        .map_err(|_| "remote commit status is not UTF-8")?
        .trim();
    let observed = fields.next().and_then(parse_remote_observed);
    match status {
        "written" | "converged" => Ok(RemoteCommit::Complete(observed)),
        "missing" => Ok(RemoteCommit::Missing),
        "conflict" => Ok(RemoteCommit::Conflict(observed)),
        _ => Err("unknown remote commit status".into()),
    }
}

/// 解析 Linux stat 输出，并转换为与 SFTP v3 相同的毫秒时间戳。
fn parse_remote_observed(output: &[u8]) -> Option<RemoteObservedVersion> {
    let output = std::str::from_utf8(output).ok()?;
    let mut fields = output.split_whitespace();
    let size = fields.next()?.parse().ok()?;
    let mtime_seconds: u64 = fields.next()?.parse().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some(RemoteObservedVersion {
        size,
        mtime: mtime_seconds.saturating_mul(1000),
    })
}

/// 构造使用同目录硬链接完成原子 no-clobber 发布的安全命令。
fn missing_commit_command(temporary: &str, target: &str) -> String {
    format!(
        "target={target}; temporary={temporary}; \
         report() {{ metadata=$(stat -c '%s %Y' -- \"$target\" 2>/dev/null) || metadata=; printf '%s\\000%s' \"$1\" \"$metadata\"; }}; \
         if [ -e \"$target\" ] || [ -L \"$target\" ]; then rm -f -- \"$temporary\"; report conflict; \
         elif ln -- \"$temporary\" \"$target\" 2>/dev/null; then rm -f -- \"$temporary\"; report written; \
         elif [ -e \"$target\" ] || [ -L \"$target\" ]; then rm -f -- \"$temporary\"; report conflict; \
         else rm -f -- \"$temporary\"; exit 74; fi",
        target = shell_quote(target),
        temporary = shell_quote(temporary),
    )
}

/// 构造在同一远端进程内完成摘要比较和替换的安全命令。
fn checked_commit_command(
    temporary: &str,
    target: &str,
    expected_revision: &str,
    replacement_revision: &str,
) -> String {
    format!(
        "target={target}; temporary={temporary}; expected={expected}; replacement={replacement}; \
         report() {{ metadata=$(stat -c '%s %Y' -- \"$target\" 2>/dev/null) || metadata=; printf '%s\\000%s' \"$1\" \"$metadata\"; }}; \
         if [ ! -f \"$target\" ]; then rm -f -- \"$temporary\"; printf 'missing'; exit 0; fi; \
         if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum -- \"$target\") || exit 73; \
         elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 -- \"$target\") || exit 73; \
         elif command -v openssl >/dev/null 2>&1; then actual=$(openssl dgst -sha256 -r \"$target\") || exit 73; \
         else exit 72; fi; actual=${{actual%% *}}; \
         if [ \"$actual\" = \"$replacement\" ]; then rm -f -- \"$temporary\" && report converged; \
         elif [ \"$actual\" != \"$expected\" ]; then rm -f -- \"$temporary\"; report conflict; \
         else mv -f -- \"$temporary\" \"$target\" && report written; fi",
        target = shell_quote(target),
        temporary = shell_quote(temporary),
        expected = shell_quote(expected_revision),
        replacement = shell_quote(replacement_revision),
    )
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

/// 删除远端文件或目录。
///
/// 文件仍使用单次 SFTP 删除；目录改由远端 `rm` 在服务器本地递归，避免文件数量
/// 放大为逐项网络往返。命令参数经过 POSIX shell 转义，且危险根路径会被提前拒绝。
pub async fn delete(workspace: &Arc<RemoteWorkspace>, path: &str) -> Result<(), String> {
    validate_destructive_path(path)?;
    let metadata = stat(workspace, path).await?;
    if metadata.kind != RemoteEntryKind::Dir {
        let sftp = session(workspace).await?;
        return sftp_result(
            workspace,
            &sftp,
            format!("remove remote file {path}"),
            sftp.remove_file(path).await,
        )
        .await;
    }

    let command = recursive_delete_command(path);
    let output = workspace
        .exec(&command, None, RECURSIVE_DELETE_TIMEOUT)
        .await?;
    if output.timed_out {
        return Err(format!("remote recursive delete timed out: {path}"));
    }
    if output.exit_code == Some(0) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    if detail.is_empty() {
        Err(format!(
            "remote recursive delete failed with exit {:?}: {path}",
            output.exit_code
        ))
    } else {
        Err(format!("remote recursive delete failed: {detail}"))
    }
}

/// 构造只包含一个已转义路径参数的远端递归删除命令。
fn recursive_delete_command(path: &str) -> String {
    format!(
        "rm -rf -- {}",
        super::session::shell_quote(path.trim_end_matches('/'))
    )
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
        checked_commit_command, existing_write_target, missing_commit_command, parse_remote_commit,
        parse_sha256, permission_attributes, plan_file_read_chunks, recursive_delete_command,
        remote_parent_name, sanitize_local_name, should_fail_transport, should_invalidate_session,
        validate_destructive_path, FileReadChunk, RemoteCommit, RemoteObservedVersion,
        DEFAULT_FILE_READ_CHUNK, FILE_READ_PIPELINE,
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
    fn destructive_paths_reject_root_and_parent_traversal() {
        for path in ["/", "//", ".", "..", "/tmp/..", "a/../b", "a/./b"] {
            assert!(validate_destructive_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_destructive_path("/home/me/project/file.txt").is_ok());
        assert!(validate_destructive_path("relative/file.txt").is_ok());
    }

    #[test]
    fn recursive_delete_command_quotes_one_exact_path() {
        assert_eq!(
            recursive_delete_command("/home/me/a b/it's"),
            "rm -rf -- '/home/me/a b/it'\\''s'"
        );
        assert_eq!(
            recursive_delete_command("/home/me/project///"),
            "rm -rf -- '/home/me/project'"
        );
        let injected = recursive_delete_command("/tmp/a'; touch /tmp/pwned; '");
        assert_eq!(injected, "rm -rf -- '/tmp/a'\\''; touch /tmp/pwned; '\\'''");
    }

    #[test]
    fn checked_commit_command_quotes_every_dynamic_value() {
        let command = checked_commit_command(
            "/tmp/stage'; echo bad; '",
            "/tmp/target'; touch /tmp/pwned; '",
            "expected'; false; '",
            "replacement'; false; '",
        );

        assert!(command.contains("target='/tmp/target'\\''; touch /tmp/pwned; '\\''';"));
        assert!(command.contains("temporary='/tmp/stage'\\''; echo bad; '\\''';"));
        assert!(command
            .contains("if [ ! -f \"$target\" ]; then rm -f -- \"$temporary\"; printf 'missing'"));
        assert!(command.contains("then rm -f -- \"$temporary\"; report conflict"));
        assert!(command.contains("stat -c '%s %Y'"));
        assert!(!command.contains("target=/tmp/target"));
    }

    #[test]
    fn missing_commit_uses_atomic_no_clobber_and_quotes_paths() {
        let command = missing_commit_command(
            "/tmp/stage'; echo bad; '",
            "/tmp/target'; touch /tmp/pwned; '",
        );

        assert!(command.contains("target='/tmp/target'\\''; touch /tmp/pwned; '\\''';"));
        assert!(command.contains("temporary='/tmp/stage'\\''; echo bad; '\\''';"));
        assert!(command.contains("[ -e \"$target\" ] || [ -L \"$target\" ]"));
        assert!(command.contains("ln -- \"$temporary\" \"$target\""));
        assert!(!command.contains("mv -f"));
    }

    #[test]
    fn parses_standard_sha256_outputs() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_sha256(format!("{digest}  /tmp/file\n").as_bytes()).unwrap(),
            digest
        );
        assert!(parse_sha256(b"not-a-digest").is_err());
    }

    #[test]
    fn parses_commit_status_with_optional_metadata() {
        assert_eq!(
            parse_remote_commit(b"written\0"),
            Ok(RemoteCommit::Complete(None))
        );
        assert_eq!(
            parse_remote_commit(b"converged\0"),
            Ok(RemoteCommit::Complete(None))
        );
        assert_eq!(
            parse_remote_commit(b"conflict\x0010 1735689600"),
            Ok(RemoteCommit::Conflict(Some(RemoteObservedVersion {
                size: 10,
                mtime: 1_735_689_600_000,
            })))
        );
        assert_eq!(parse_remote_commit(b"missing"), Ok(RemoteCommit::Missing));
        assert!(parse_remote_commit(b"unknown").is_err());
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
