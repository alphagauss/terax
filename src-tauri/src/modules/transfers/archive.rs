//! Archive 传输策略与本地安全归档。
//!
//! Archive 仅用于用户显式创建的 WSL 或 SSH 任务。它只在规划阶段确认顶层来源，
//! 随后以单个 tar.gz 传输，并通过 SHA-256 和受控解包保证完整性与路径安全。归档
//! 条目提供的路径永远不会直接交给文件系统。

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use tar::{Archive, Builder, EntryType, Header};

use super::errors::{
    contextual_io_error, io_failure, is_source_changed_io,
    source_changed_io as source_changed_error, TransferErrorCode,
};
use super::manager::{TaskControl, TransferRunError};
use super::planner::{LocalPlan, PreparedTransfer, RemoteUploadPlan, TransferManifest};
use super::progress::ExecutionContext;
use super::source::LocalSourceIdentity;

type RunResult<T> = Result<T, TransferRunError>;
const MAX_ARCHIVE_TRAILING_BYTES: u64 = 1024 * 1024;

/// 构建完成后由 `TempPath` 自动清理的本地归档。
pub(crate) struct LocalArchive {
    pub(crate) path: tempfile::TempPath,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) file_count: u64,
}

/// 归档安全层允许处理的条目类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArchiveEntryKind {
    File,
    Directory,
}

struct PackEntry {
    source: PathBuf,
    path: String,
    kind: ArchiveEntryKind,
    size: u64,
    mode: u32,
    mtime: u64,
    modified: Option<SystemTime>,
    source_identity: Option<LocalSourceIdentity>,
}

/// 未经预扫描的下载归档允许写入的顶层根。
///
/// `archive_path` 是 tar 中的规范相对路径，`destination` 是该根对应的任务私有
/// staging。子路径只会在此根之下创建，绝不会由归档直接指定宿主绝对路径。
#[derive(Clone)]
pub(crate) struct ExtractRoot {
    pub(crate) archive_path: String,
    pub(crate) destination: PathBuf,
    pub(crate) kind: ArchiveEntryKind,
}

/// 执行已经完成扫描和目标 reservation 的 Archive 计划。
pub(crate) async fn execute(
    prepared: PreparedTransfer,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let result = match prepared.manifest {
        TransferManifest::RemoteUpload(plan) => {
            super::ssh::archive::execute_upload(plan, context).await
        }
        TransferManifest::RemoteDownload(plan) => {
            super::ssh::archive::execute_download(plan, context).await
        }
        TransferManifest::Local(plan) => super::wsl::archive::execute(plan, context).await,
    };
    result
}

/// 按远端 staging 相对路径创建本地 tar.gz，并在打包过程中递归枚举来源。
///
/// Archive 计划只保存顶层来源。子树由本函数写入归档时直接遍历，避免在高延迟
/// 文件系统上先完整扫描一遍、随后又为了打包重复读取同一棵树。
pub(crate) async fn build_upload_archive(
    plan: &RemoteUploadPlan,
    remote_parent: &str,
    context: &mut ExecutionContext,
) -> RunResult<LocalArchive> {
    let mut entries = Vec::with_capacity(plan.directories.len() + plan.files.len());
    for directory in &plan.directories {
        entries.push(PackEntry {
            source: directory.source.clone(),
            path: remote_relative(&directory.destination, remote_parent)?,
            kind: ArchiveEntryKind::Directory,
            size: 0,
            mode: directory.metadata.archive_mode(),
            mtime: directory.metadata.archive_mtime(),
            modified: directory.metadata.modified(),
            source_identity: directory.source_identity,
        });
    }
    for file in &plan.files {
        entries.push(PackEntry {
            source: file.source.clone(),
            path: remote_relative(&file.destination, remote_parent)?,
            kind: ArchiveEntryKind::File,
            size: file.size,
            mode: file.metadata.archive_mode(),
            mtime: file.metadata.archive_mtime(),
            modified: file.metadata.modified(),
            source_identity: file.source_identity,
        });
    }
    build_archive(entries, context).await
}

/// 按 WSL staging 相对路径创建本地 tar.gz，跨边界时只传输这一条归档流。
pub(crate) async fn build_wsl_upload_archive(
    plan: &LocalPlan,
    context: &mut ExecutionContext,
) -> RunResult<LocalArchive> {
    let mut entries = Vec::with_capacity(plan.directories.len() + plan.files.len());
    for directory in &plan.directories {
        entries.push(PackEntry {
            source: directory.source.clone(),
            path: local_relative(&directory.destination, &plan.destination_parent)?,
            kind: ArchiveEntryKind::Directory,
            size: 0,
            mode: directory.metadata.archive_mode(),
            mtime: directory.metadata.archive_mtime(),
            modified: directory.metadata.modified(),
            source_identity: directory.source_identity,
        });
    }
    for file in &plan.files {
        entries.push(PackEntry {
            source: file.source.clone(),
            path: local_relative(&file.destination, &plan.destination_parent)?,
            kind: ArchiveEntryKind::File,
            size: file.size,
            mode: file.metadata.archive_mode(),
            mtime: file.metadata.archive_mtime(),
            modified: file.metadata.modified(),
            source_identity: file.source_identity,
        });
    }
    build_archive(entries, context).await
}

async fn build_archive(
    entries: Vec<PackEntry>,
    context: &mut ExecutionContext,
) -> RunResult<LocalArchive> {
    context
        .set_stage(super::models::TransferStage::Archiving)
        .await;
    let temporary = tempfile::Builder::new()
        .prefix("terax-archive-")
        .suffix(".tar.gz")
        .tempfile()
        .map_err(|error| TransferRunError::Failed(io_failure("create local archive", &error)))?;
    let path = temporary.into_temp_path();
    let excluded_path = std::fs::canonicalize(&path).map_err(|error| {
        TransferRunError::Failed(io_failure("canonicalize local archive", &error))
    })?;
    let build_path = path.to_path_buf();
    let control = context.control();
    let build_control = control.clone();
    let build = tokio::task::spawn_blocking(move || {
        build_archive_blocking(&build_path, entries, &excluded_path, &build_control)
    })
    .await
    .map_err(|error| message(format!("join archive task: {error}")))?;
    let built = build.map_err(|error| blocking_error(error, &control))?;
    let size = std::fs::metadata(&path)
        .map_err(|error| TransferRunError::Failed(io_failure("stat local archive", &error)))?
        .len();
    Ok(LocalArchive {
        path,
        size,
        sha256: built.sha256,
        file_count: built.file_count,
    })
}

/// 在不预扫描远端子树的前提下安全解压下载归档。
///
/// 所有条目仍会逐一检查路径和类型，但检查发生在接收端本地磁盘，不产生按文件的
/// SSH 或 WSL 往返。返回普通文件数量，供任务进度在整个归档验证完成后一次更新。
pub(crate) async fn extract_download_archive_roots(
    archive: &Path,
    roots: Vec<ExtractRoot>,
    context: &mut ExecutionContext,
) -> RunResult<u64> {
    context
        .set_stage(super::models::TransferStage::Extracting)
        .await;
    let archive = archive.to_path_buf();
    let control = context.control();
    let extract_control = control.clone();
    let extracted = tokio::task::spawn_blocking(move || {
        extract_archive_roots(&archive, roots, &extract_control)
    })
    .await
    .map_err(|error| message(format!("join archive extraction: {error}")))?;
    extracted.map_err(|error| blocking_error(error, &control))
}

fn build_archive_blocking(
    path: &Path,
    entries: Vec<PackEntry>,
    excluded_path: &Path,
    control: &Arc<TaskControl>,
) -> io::Result<ArchiveBuild> {
    let file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| {
            contextual_io_error(format!("open local archive {}", path.display()), error)
        })?;
    let encoder = GzEncoder::new(HashingWriter::new(file), Compression::default());
    let mut archive = Builder::new(encoder);
    let mut seen = HashSet::new();
    let mut file_count = 0u64;
    let mut pending: Vec<_> = entries.into_iter().rev().map(PackAction::Entry).collect();
    while let Some(action) = pending.pop() {
        control_io(control)?;
        match action {
            PackAction::Entry(entry) => append_pack_entry(
                &mut archive,
                entry,
                &mut seen,
                &mut file_count,
                &mut pending,
                control,
            )?,
            PackAction::DirectoryEntries {
                source,
                archive_path,
                source_identity,
                mut entries,
            } => match entries.next() {
                Some(child) => {
                    control_io(control)?;
                    let child = child.map_err(|error| {
                        contextual_io_error(format!("read directory {}", source.display()), error)
                    })?;
                    let child_source = child.path();
                    if child_source == excluded_path {
                        pending.push(PackAction::DirectoryEntries {
                            source,
                            archive_path,
                            source_identity,
                            entries,
                        });
                        continue;
                    }
                    let child_metadata =
                        std::fs::symlink_metadata(&child_source).map_err(|error| {
                            contextual_io_error(
                                format!("stat source {}", child_source.display()),
                                error,
                            )
                        })?;
                    let child_name = child.file_name().into_string().map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "archive source path is not valid UTF-8: {}",
                                child_source.display()
                            ),
                        )
                    })?;
                    let child_path = format!("{archive_path}/{child_name}");
                    pending.push(PackAction::DirectoryEntries {
                        source,
                        archive_path,
                        source_identity,
                        entries,
                    });
                    pending.push(PackAction::Entry(pack_entry_from_metadata(
                        child_source,
                        child_path,
                        &child_metadata,
                    )?));
                }
                None => {
                    super::source::verify_directory_blocking(&source, source_identity)?;
                }
            },
        }
    }
    archive.finish().map_err(|error| {
        contextual_io_error(format!("finish local archive {}", path.display()), error)
    })?;
    let encoder = archive.into_inner().map_err(|error| {
        contextual_io_error(format!("flush local archive {}", path.display()), error)
    })?;
    let hashing = encoder.finish().map_err(|error| {
        contextual_io_error(format!("compress local archive {}", path.display()), error)
    })?;
    let (file, sha256) = hashing.finish();
    file.sync_all().map_err(|error| {
        contextual_io_error(format!("sync local archive {}", path.display()), error)
    })?;
    Ok(ArchiveBuild { sha256, file_count })
}

struct ArchiveBuild {
    sha256: String,
    file_count: u64,
}

enum PackAction {
    Entry(PackEntry),
    DirectoryEntries {
        source: PathBuf,
        archive_path: String,
        source_identity: Option<LocalSourceIdentity>,
        entries: Box<std::fs::ReadDir>,
    },
}

/// 将一个来源条目写入归档，并把目录子项加入显式遍历栈。
///
/// 显式栈避免极深目录耗尽线程栈；目录退出动作会在全部子项处理完成后复验父目录，
/// 防止遍历期间发生的同名替换被静默接受。
fn append_pack_entry(
    archive: &mut Builder<GzEncoder<HashingWriter<File>>>,
    entry: PackEntry,
    seen: &mut HashSet<String>,
    file_count: &mut u64,
    pending: &mut Vec<PackAction>,
    control: &Arc<TaskControl>,
) -> io::Result<()> {
    control_io(control)?;
    let metadata = std::fs::symlink_metadata(&entry.source).map_err(|error| {
        contextual_io_error(format!("stat source {}", entry.source.display()), error)
    })?;
    let actual_kind = metadata_kind(&entry.source, &metadata)?;
    if actual_kind != entry.kind
        || entry
            .source_identity
            .is_some_and(|expected| !expected.matches_metadata(&metadata))
        || (entry.kind == ArchiveEntryKind::File && metadata.len() != entry.size)
        || entry
            .modified
            .is_some_and(|expected| metadata.modified().ok() != Some(expected))
    {
        return Err(source_changed_io(&entry.source));
    }
    if !seen.insert(entry.path.clone()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("archive contains duplicate path: {}", entry.path),
        ));
    }

    let mut header = Header::new_gnu();
    header.set_entry_type(match entry.kind {
        ArchiveEntryKind::File => EntryType::Regular,
        ArchiveEntryKind::Directory => EntryType::Directory,
    });
    header.set_size(entry.size);
    header.set_mode(entry.mode);
    header.set_mtime(entry.mtime);
    header.set_uid(0);
    header.set_gid(0);
    header.set_cksum();
    match entry.kind {
        ArchiveEntryKind::Directory => {
            archive
                .append_data(&mut header, &entry.path, io::empty())
                .map_err(|error| {
                    contextual_io_error(
                        format!("append directory {} to archive", entry.source.display()),
                        error,
                    )
                })?;
            let entries = super::source::read_verified_directory_blocking(
                &entry.source,
                entry.source_identity,
            )?;
            pending.push(PackAction::DirectoryEntries {
                source: entry.source,
                archive_path: entry.path,
                source_identity: entry.source_identity,
                entries: Box::new(entries),
            });
        }
        ArchiveEntryKind::File => {
            let mut file = super::source::open_verified_file_blocking(
                &entry.source,
                entry.source_identity,
                entry.size,
                entry.modified,
            )?;
            let reader = ControlledReader::new(&mut file, control.clone());
            archive
                .append_data(&mut header, &entry.path, reader)
                .map_err(|error| {
                    contextual_io_error(
                        format!("append file {} to archive", entry.source.display()),
                        error,
                    )
                })?;
            let opened = file.metadata().map_err(|error| {
                contextual_io_error(
                    format!("verify archived source {}", entry.source.display()),
                    error,
                )
            })?;
            if opened.len() != entry.size
                || entry
                    .modified
                    .is_some_and(|expected| opened.modified().ok() != Some(expected))
                || entry
                    .source_identity
                    .is_some_and(|expected| !expected.matches_std_file(&file, &opened))
            {
                return Err(source_changed_io(&entry.source));
            }
            *file_count = file_count.saturating_add(1);
        }
    }
    Ok(())
}

/// 将刚读取的本地元数据转换为归档条目，拒绝符号链接和特殊文件。
fn pack_entry_from_metadata(
    source: PathBuf,
    path: String,
    metadata: &std::fs::Metadata,
) -> io::Result<PackEntry> {
    let kind = metadata_kind(&source, metadata)?;
    Ok(PackEntry {
        source,
        path,
        kind,
        size: if kind == ArchiveEntryKind::File {
            metadata.len()
        } else {
            0
        },
        mode: archive_mode(metadata),
        mtime: archive_mtime(metadata),
        modified: metadata.modified().ok(),
        source_identity: LocalSourceIdentity::from_metadata(metadata),
    })
}

/// 返回可写入 tar 的普通文件或目录类型，其他来源一律拒绝。
fn metadata_kind(path: &Path, metadata: &std::fs::Metadata) -> io::Result<ArchiveEntryKind> {
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported source type: {}", path.display()),
        ));
    }
    Ok(if metadata.is_file() {
        ArchiveEntryKind::File
    } else {
        ArchiveEntryKind::Directory
    })
}

/// 归档使用可跨平台恢复的 Unix 权限位，Windows 仅区分只读与可写。
fn archive_mode(metadata: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        match (metadata.is_dir(), metadata.permissions().readonly()) {
            (true, true) => 0o555,
            (true, false) => 0o755,
            (false, true) => 0o444,
            (false, false) => 0o644,
        }
    }
}

/// tar 头仅保存秒级修改时间，无法表示的值按 Unix epoch 处理。
fn archive_mtime(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn source_changed_io(path: &Path) -> io::Error {
    source_changed_error(format!(
        "source changed while archiving: {}",
        path.display()
    ))
}

/// 解压以顶层根映射约束的归档，并从 tar 头恢复可移植的 mode 与 mtime。
fn extract_archive_roots(
    path: &Path,
    mut roots: Vec<ExtractRoot>,
    control: &Arc<TaskControl>,
) -> io::Result<u64> {
    if roots.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "archive extraction has no allowed roots",
        ));
    }
    for root in &mut roots {
        root.archive_path = normalize_archive_path(Path::new(&root.archive_path))?;
    }
    for (index, root) in roots.iter().enumerate() {
        if roots.iter().skip(index + 1).any(|candidate| {
            archive_path_within(&root.archive_path, &candidate.archive_path)
                || archive_path_within(&candidate.archive_path, &root.archive_path)
        }) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "archive extraction roots overlap",
            ));
        }
    }
    roots.sort_by_key(|root| std::cmp::Reverse(root.archive_path.len()));

    let decoder = GzDecoder::new(File::open(path)?);
    let mut archive = Archive::new(decoder);
    let mut seen_paths = HashSet::new();
    let mut seen_roots = HashSet::new();
    let mut seen_destinations = HashSet::new();
    let mut directories = Vec::new();
    let mut file_count = 0u64;
    for entry in archive.entries()? {
        control_io(control)?;
        let mut entry = entry?;
        let archive_path = normalize_archive_path(&entry.path()?)?;
        if !seen_paths.insert(archive_path.clone()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("duplicate archive entry: {archive_path}"),
            ));
        }
        let kind = entry_kind(entry.header().entry_type())?;
        let (root, relative) = roots
            .iter()
            .find_map(|root| {
                if archive_path == root.archive_path {
                    Some((root, ""))
                } else {
                    archive_path
                        .strip_prefix(&root.archive_path)
                        .and_then(|suffix| suffix.strip_prefix('/'))
                        .map(|suffix| (root, suffix))
                }
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("archive entry is outside selected roots: {archive_path}"),
                )
            })?;
        if archive_path == root.archive_path {
            if kind != root.kind {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("archive root type changed: {archive_path}"),
                ));
            }
            seen_roots.insert(root.archive_path.clone());
        } else if root.kind != ArchiveEntryKind::Directory {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("archive file root contains descendants: {archive_path}"),
            ));
        }
        let destination = if relative.is_empty() {
            root.destination.clone()
        } else {
            safe_destination_path(&root.destination, relative)?
        };
        let destination_key = destination_identity(&destination);
        if !seen_destinations.insert(destination_key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("archive paths collide after destination normalization: {archive_path}"),
            ));
        }
        let metadata = archive_entry_metadata(entry.header())?;
        if kind == ArchiveEntryKind::Directory {
            std::fs::create_dir_all(&destination)?;
            directories.push((destination, metadata));
            continue;
        }

        let parent = destination.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "archive target has no parent")
        })?;
        std::fs::create_dir_all(parent)?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let mut writer = io::BufWriter::new(file);
        let mut reader = ControlledReader::new(&mut entry, control.clone());
        let copied = io::copy(&mut reader, &mut writer)?;
        if copied != entry.size() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("archive entry size changed: {archive_path}"),
            ));
        }
        use std::io::Write;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        apply_archive_metadata(&destination, metadata)?;
        file_count = file_count.saturating_add(1);
    }
    let decoder = archive.into_inner();
    let _ = consume_archive_tail(decoder, control)?;
    if seen_roots.len() != roots.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive is missing a selected root",
        ));
    }
    // 目录必须在所有子项创建完成后再变为只读并恢复时间，避免阻断后续写入。
    for (directory, metadata) in directories.into_iter().rev() {
        apply_archive_metadata(&directory, metadata)?;
    }
    Ok(file_count)
}

fn archive_path_within(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// 将归档内相对路径映射到本地路径，并沿用 Explorer 的跨平台文件名净化规则。
fn safe_destination_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    let mut destination = root.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || matches!(component, "." | "..") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "archive relative path is invalid",
            ));
        }
        destination.push(crate::modules::remote::sftp::sanitize_local_name(component));
    }
    Ok(destination)
}

/// 生成与目标平台一致的碰撞键，Windows 文件系统大小写不敏感。
fn destination_identity(path: &Path) -> String {
    let path = path.to_string_lossy();
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.into_owned()
    }
}

#[derive(Clone, Copy)]
struct ArchiveEntryMetadata {
    mode: u32,
    mtime: u64,
}

/// 读取 tar 头中可安全恢复的 mode 与 mtime。
fn archive_entry_metadata(header: &Header) -> io::Result<ArchiveEntryMetadata> {
    Ok(ArchiveEntryMetadata {
        mode: header.mode()?,
        mtime: header.mtime()?,
    })
}

/// 将 tar 头元数据恢复到目标条目，不复制 uid、gid、ACL 或扩展属性。
fn apply_archive_metadata(path: &Path, metadata: ArchiveEntryMetadata) -> io::Result<()> {
    let mtime = filetime::FileTime::from_unix_time(metadata.mtime.min(i64::MAX as u64) as i64, 0);
    filetime::set_file_mtime(path, mtime)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(metadata.mode & 0o777))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_readonly(metadata.mode & 0o222 == 0);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn consume_archive_tail<R: Read>(
    mut decoder: GzDecoder<R>,
    control: &Arc<TaskControl>,
) -> io::Result<GzDecoder<R>> {
    let reader = ControlledReader::new(&mut decoder, control.clone());
    let copied = io::copy(
        &mut reader.take(MAX_ARCHIVE_TRAILING_BYTES + 1),
        &mut io::sink(),
    )?;
    if copied > MAX_ARCHIVE_TRAILING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive contains excessive data after the tar end marker",
        ));
    }
    Ok(decoder)
}

fn normalize_archive_path(path: &Path) -> io::Result<String> {
    if path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive contains an absolute path",
        ));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "archive path is not valid UTF-8",
                    )
                })?;
                if value.is_empty() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "archive path contains an empty component",
                    ));
                }
                parts.push(value);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "archive path escapes its extraction root",
                ))
            }
        }
    }
    if parts.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive path is empty",
        ));
    }
    Ok(parts.join("/"))
}

fn entry_kind(kind: EntryType) -> io::Result<ArchiveEntryKind> {
    if kind.is_file() {
        Ok(ArchiveEntryKind::File)
    } else if kind.is_dir() {
        Ok(ArchiveEntryKind::Directory)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive contains a link or special file",
        ))
    }
}

fn remote_relative(path: &str, parent: &str) -> RunResult<String> {
    let parent = parent.trim_end_matches('/');
    let prefix = if parent.is_empty() {
        "/".to_string()
    } else {
        format!("{parent}/")
    };
    let relative = path
        .strip_prefix(&prefix)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| message(format!("archive path is outside destination: {path}")))?;
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "..")
    {
        return Err(message(format!("invalid archive destination path: {path}")));
    }
    Ok(relative.to_string())
}

fn local_relative(path: &Path, parent: &Path) -> RunResult<String> {
    let relative = path.strip_prefix(parent).map_err(|_| {
        message(format!(
            "archive path is outside destination: {}",
            path.display()
        ))
    })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or_else(|| {
                    message(format!(
                        "archive destination is not valid UTF-8: {}",
                        path.display()
                    ))
                })?;
                if value.is_empty() || matches!(value, "." | "..") {
                    return Err(message(format!(
                        "invalid archive destination path: {}",
                        path.display()
                    )));
                }
                parts.push(value);
            }
            _ => {
                return Err(message(format!(
                    "invalid archive destination path: {}",
                    path.display()
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(message(format!(
            "archive path equals destination root: {}",
            path.display()
        )));
    }
    Ok(parts.join("/"))
}

struct ControlledReader<R> {
    inner: R,
    control: Arc<TaskControl>,
}

/// 在 gzip 编码器写出压缩字节时同步累计 SHA-256，避免归档落盘后再次完整读取。
struct HashingWriter<W> {
    inner: W,
    digest: Sha256,
}

impl<W> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
        }
    }

    fn finish(self) -> (W, String) {
        (self.inner, format!("{:x}", self.digest.finalize()))
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.digest.update(&buffer[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<R> ControlledReader<R> {
    fn new(inner: R, control: Arc<TaskControl>) -> Self {
        Self { inner, control }
    }
}

impl<R: Read> Read for ControlledReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        control_io(&self.control)?;
        self.inner.read(buffer)
    }
}

fn control_io(control: &TaskControl) -> io::Result<()> {
    control.checkpoint_blocking().map_err(|error| {
        io::Error::new(
            io::ErrorKind::Interrupted,
            match error {
                TransferRunError::Canceled => "archive task canceled".to_string(),
                TransferRunError::Failed(failure) => failure.detail,
            },
        )
    })
}

fn blocking_error(error: io::Error, control: &TaskControl) -> TransferRunError {
    if control.is_cancelled() {
        TransferRunError::Canceled
    } else if is_source_changed_io(&error) {
        TransferRunError::failed(TransferErrorCode::SourceChanged, error.to_string())
    } else if error.kind() == io::ErrorKind::InvalidData {
        TransferRunError::failed(TransferErrorCode::IntegrityCheckFailed, error.to_string())
    } else {
        TransferRunError::Failed(io_failure("archive operation", &error))
    }
}

fn message(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IntegrityCheckFailed, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_archive(path: &Path, entry_path: &[u8], kind: EntryType) {
        let file = File::create(path).unwrap();
        let encoder = GzEncoder::new(file, Compression::fast());
        let mut archive = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(0);
        header.set_mode(0o600);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..entry_path.len()].copy_from_slice(entry_path);
        header.set_cksum();
        archive.append(&header, io::empty()).unwrap();
        archive.finish().unwrap();
        archive.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn archive_paths_reject_escape_and_normalize_current_directory() {
        assert_eq!(
            normalize_archive_path(Path::new("./root/file.txt")).unwrap(),
            "root/file.txt"
        );
        assert!(normalize_archive_path(Path::new("../file.txt")).is_err());
        assert!(normalize_archive_path(Path::new("/root/file.txt")).is_err());
    }

    #[test]
    fn links_and_special_entries_are_rejected() {
        assert!(entry_kind(EntryType::Symlink).is_err());
        assert!(entry_kind(EntryType::Link).is_err());
        assert!(entry_kind(EntryType::Fifo).is_err());
        assert_eq!(
            entry_kind(EntryType::Regular).unwrap(),
            ArchiveEntryKind::File
        );
    }

    #[test]
    fn archive_extraction_rejects_parent_paths_and_links() {
        let directory = tempfile::tempdir().unwrap();
        let control = Arc::new(TaskControl::new());
        let parent = directory.path().join("parent.tar.gz");
        write_test_archive(&parent, b"../escape", EntryType::Regular);
        assert!(extract_archive_roots(
            &parent,
            vec![ExtractRoot {
                archive_path: "escape".into(),
                destination: directory.path().join("escape"),
                kind: ArchiveEntryKind::File,
            }],
            &control,
        )
        .is_err());

        let link = directory.path().join("link.tar.gz");
        write_test_archive(&link, b"link", EntryType::Symlink);
        assert!(extract_archive_roots(
            &link,
            vec![ExtractRoot {
                archive_path: "link".into(),
                destination: directory.path().join("link"),
                kind: ArchiveEntryKind::File,
            }],
            &control,
        )
        .is_err());
    }

    #[test]
    fn archive_extraction_consumes_the_stream_and_checks_gzip_integrity() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("corrupt.tar.gz");
        write_test_archive(&archive_path, b"file.txt", EntryType::Regular);
        let mut bytes = std::fs::read(&archive_path).unwrap();
        let last = bytes.last_mut().unwrap();
        *last ^= 0xff;
        std::fs::write(&archive_path, bytes).unwrap();

        assert!(extract_archive_roots(
            &archive_path,
            vec![ExtractRoot {
                archive_path: "file.txt".into(),
                destination: directory.path().join("file.txt"),
                kind: ArchiveEntryKind::File,
            }],
            &Arc::new(TaskControl::new()),
        )
        .is_err());
    }

    #[test]
    fn hashing_writer_tracks_bytes_without_a_second_read() {
        let mut writer = HashingWriter::new(Vec::new());
        writer.write_all(b"archive-bytes").unwrap();
        let (bytes, actual) = writer.finish();
        assert_eq!(bytes, b"archive-bytes");
        assert_eq!(actual, format!("{:x}", Sha256::digest(&bytes)));
    }

    #[test]
    fn local_archive_excludes_its_own_output_from_a_source_ancestor() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("payload.txt"), b"payload").unwrap();
        let archive_path = source.join("payload.tar.gz");
        File::create(&archive_path).unwrap();
        let metadata = std::fs::symlink_metadata(&source).unwrap();
        let entry = PackEntry {
            source: source.clone(),
            path: "root".into(),
            kind: ArchiveEntryKind::Directory,
            size: 0,
            mode: archive_mode(&metadata),
            mtime: archive_mtime(&metadata),
            modified: metadata.modified().ok(),
            source_identity: LocalSourceIdentity::from_metadata(&metadata),
        };
        let control = Arc::new(TaskControl::new());

        build_archive_blocking(&archive_path, vec![entry], &archive_path, &control).unwrap();
        let destination = directory.path().join("destination");
        let files = extract_archive_roots(
            &archive_path,
            vec![ExtractRoot {
                archive_path: "root".into(),
                destination: destination.clone(),
                kind: ArchiveEntryKind::Directory,
            }],
            &control,
        )
        .unwrap();

        assert_eq!(files, 1);
        assert_eq!(
            std::fs::read(destination.join("payload.txt")).unwrap(),
            b"payload"
        );
        assert!(!destination.join("payload.tar.gz").exists());
    }

    #[test]
    fn extraction_rejects_changed_or_overlapping_root_types() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("root-type.tar.gz");
        write_test_archive(&archive_path, b"root", EntryType::Regular);
        let control = Arc::new(TaskControl::new());

        assert!(extract_archive_roots(
            &archive_path,
            vec![ExtractRoot {
                archive_path: "root".into(),
                destination: directory.path().join("changed"),
                kind: ArchiveEntryKind::Directory,
            }],
            &control,
        )
        .is_err());
        assert!(extract_archive_roots(
            &archive_path,
            vec![
                ExtractRoot {
                    archive_path: "root".into(),
                    destination: directory.path().join("parent"),
                    kind: ArchiveEntryKind::Directory,
                },
                ExtractRoot {
                    archive_path: "root/child".into(),
                    destination: directory.path().join("child"),
                    kind: ArchiveEntryKind::File,
                },
            ],
            &control,
        )
        .is_err());
    }

    #[test]
    fn root_mapped_extraction_accepts_nested_entries_without_pre_scan() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("nested.tar.gz");
        let file = File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(file, Compression::fast());
        let mut archive = Builder::new(encoder);
        let mut directory_header = Header::new_gnu();
        directory_header.set_entry_type(EntryType::Directory);
        directory_header.set_size(0);
        directory_header.set_mode(0o755);
        directory_header.set_mtime(1);
        directory_header.set_uid(0);
        directory_header.set_gid(0);
        directory_header.set_cksum();
        archive
            .append_data(&mut directory_header, "root", io::empty())
            .unwrap();
        let mut file_header = Header::new_gnu();
        file_header.set_entry_type(EntryType::Regular);
        file_header.set_size(7);
        file_header.set_mode(0o644);
        file_header.set_mtime(2);
        file_header.set_uid(0);
        file_header.set_gid(0);
        file_header.set_cksum();
        archive
            .append_data(&mut file_header, "root/file.txt", &b"payload"[..])
            .unwrap();
        archive.finish().unwrap();
        archive.into_inner().unwrap().finish().unwrap();

        let destination = directory.path().join("staging");
        let files = extract_archive_roots(
            &archive_path,
            vec![ExtractRoot {
                archive_path: "root".into(),
                destination: destination.clone(),
                kind: ArchiveEntryKind::Directory,
            }],
            &Arc::new(TaskControl::new()),
        )
        .unwrap();

        assert_eq!(files, 1);
        assert_eq!(
            std::fs::read(destination.join("file.txt")).unwrap(),
            b"payload"
        );
    }
}
