//! Archive 传输策略与本地安全归档。
//!
//! Archive 仅用于用户显式创建的 WSL 或 SSH 任务。它消费与 Direct 相同的 Manifest、
//! reservation 和提交协议。本模块负责本地 tar.gz 的生成、完整性检查和受控解包，
//! 不把归档条目提供的路径直接交给文件系统。

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use tar::{Archive, Builder, EntryType, Header};

use super::manager::{TaskControl, TransferRunError};
use super::planner::{LocalPlan, PreparedTransfer, RemoteUploadPlan, TransferManifest};
use super::progress::ExecutionContext;

type RunResult<T> = Result<T, TransferRunError>;

/// 构建完成后由 `TempPath` 自动清理的本地归档。
pub(crate) struct LocalArchive {
    pub(crate) path: tempfile::TempPath,
    pub(crate) size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveEntryKind {
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
}

/// 本地安全解包时唯一允许写入的 Manifest 条目。
#[derive(Clone)]
pub(crate) struct ExtractEntry {
    pub(crate) destination: PathBuf,
    pub(crate) size: u64,
    pub(crate) is_dir: bool,
}

/// 执行已经完成扫描和目标 reservation 的 Archive 计划。
pub(crate) async fn execute(
    prepared: PreparedTransfer,
    context: &mut ExecutionContext,
) -> RunResult<Vec<String>> {
    let result = match prepared.manifest {
        TransferManifest::RemoteUpload(plan) => {
            super::ssh::archive::execute_upload(plan, context).await
        }
        TransferManifest::RemoteDownload(plan) => {
            super::ssh::archive::execute_download(plan, context).await
        }
        TransferManifest::Local(plan) => super::wsl::archive::execute(plan, context).await,
    };
    result?;
    Ok(prepared.changed_paths)
}

/// 按远端 staging 相对路径创建本地 tar.gz，并在上传前重新解析全部条目。
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
        });
    }
    build_archive(entries, context).await
}

async fn build_archive(
    entries: Vec<PackEntry>,
    context: &mut ExecutionContext,
) -> RunResult<LocalArchive> {
    let expected: HashMap<_, _> = entries
        .iter()
        .map(|entry| (entry.path.clone(), (entry.kind, entry.size)))
        .collect();
    if expected.len() != entries.len() {
        return Err(message("archive manifest contains duplicate paths"));
    }

    context
        .set_stage(super::models::TransferStage::Archiving)
        .await;
    let temporary = tempfile::Builder::new()
        .prefix("terax-archive-")
        .suffix(".tar.gz")
        .tempfile()
        .map_err(|error| message(format!("create local archive: {error}")))?;
    let path = temporary.into_temp_path();
    let build_path = path.to_path_buf();
    let control = context.control();
    let build_control = control.clone();
    let build = tokio::task::spawn_blocking(move || {
        build_archive_blocking(&build_path, entries, &build_control)
    })
    .await
    .map_err(|error| message(format!("join archive task: {error}")))?;
    if let Err(error) = build {
        return Err(blocking_error(error, &control));
    }

    let validate_path = path.to_path_buf();
    let validate_control = control.clone();
    let validated = tokio::task::spawn_blocking(move || {
        verify_gzip(&validate_path, &validate_control)?;
        validate_archive(&validate_path, &expected, &validate_control)
    })
    .await
    .map_err(|error| message(format!("join archive validation: {error}")))?;
    if let Err(error) = validated {
        return Err(blocking_error(error, &control));
    }
    let size = std::fs::metadata(&path)
        .map_err(|error| message(format!("stat local archive: {error}")))?
        .len();
    Ok(LocalArchive { path, size })
}

/// 校验 gzip 后按 Manifest 映射解包，归档中的路径永远不会直接成为写入目标。
pub(crate) async fn extract_download_archive(
    archive: &Path,
    expected: HashMap<String, ExtractEntry>,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    context
        .set_stage(super::models::TransferStage::Extracting)
        .await;
    let archive = archive.to_path_buf();
    let control = context.control();
    let extract_control = control.clone();
    let extracted = tokio::task::spawn_blocking(move || {
        verify_gzip(&archive, &extract_control)?;
        extract_archive(&archive, expected, &extract_control)
    })
    .await
    .map_err(|error| message(format!("join archive extraction: {error}")))?;
    extracted.map_err(|error| blocking_error(error, &control))
}

fn build_archive_blocking(
    path: &Path,
    entries: Vec<PackEntry>,
    control: &Arc<TaskControl>,
) -> io::Result<()> {
    let file = OpenOptions::new().write(true).truncate(true).open(path)?;
    let encoder = GzEncoder::new(file, Compression::default());
    let mut archive = Builder::new(encoder);
    for entry in entries {
        control_io(control)?;
        let metadata = std::fs::symlink_metadata(&entry.source)?;
        let actual_kind = if metadata.is_dir() {
            ArchiveEntryKind::Directory
        } else if metadata.is_file() {
            ArchiveEntryKind::File
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported source type: {}", entry.source.display()),
            ));
        };
        if metadata.file_type().is_symlink()
            || actual_kind != entry.kind
            || (entry.kind == ArchiveEntryKind::File && metadata.len() != entry.size)
            || entry
                .modified
                .is_some_and(|expected| metadata.modified().ok() != Some(expected))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "source changed before archiving: {}",
                    entry.source.display()
                ),
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
                archive.append_data(&mut header, entry.path, io::empty())?;
            }
            ArchiveEntryKind::File => {
                let file = File::open(&entry.source)?;
                let reader = ControlledReader::new(file, control.clone());
                archive.append_data(&mut header, entry.path, reader)?;
            }
        }
        let current = std::fs::symlink_metadata(&entry.source)?;
        if current.file_type().is_symlink()
            || (entry.kind == ArchiveEntryKind::File && current.len() != entry.size)
            || entry
                .modified
                .is_some_and(|expected| current.modified().ok() != Some(expected))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("source changed while archiving: {}", entry.source.display()),
            ));
        }
    }
    archive.finish()?;
    let encoder = archive.into_inner()?;
    let file = encoder.finish()?;
    file.sync_all()
}

fn verify_gzip(path: &Path, control: &Arc<TaskControl>) -> io::Result<()> {
    let decoder = GzDecoder::new(File::open(path)?);
    let mut reader = ControlledReader::new(decoder, control.clone());
    io::copy(&mut reader, &mut io::sink())?;
    Ok(())
}

fn validate_archive(
    path: &Path,
    expected: &HashMap<String, (ArchiveEntryKind, u64)>,
    control: &Arc<TaskControl>,
) -> io::Result<()> {
    let decoder = GzDecoder::new(File::open(path)?);
    let mut archive = Archive::new(decoder);
    let mut seen = HashSet::new();
    for entry in archive.entries()? {
        control_io(control)?;
        let entry = entry?;
        let path = normalize_archive_path(&entry.path()?)?;
        let kind = entry_kind(entry.header().entry_type())?;
        let (expected_kind, expected_size) = expected.get(&path).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected archive entry: {path}"),
            )
        })?;
        if !seen.insert(path.clone())
            || kind != *expected_kind
            || (kind == ArchiveEntryKind::File && entry.size() != *expected_size)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid archive entry: {path}"),
            ));
        }
    }
    if seen.len() != expected.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive is missing manifest entries",
        ));
    }
    Ok(())
}

fn extract_archive(
    path: &Path,
    expected: HashMap<String, ExtractEntry>,
    control: &Arc<TaskControl>,
) -> io::Result<()> {
    let decoder = GzDecoder::new(File::open(path)?);
    let mut archive = Archive::new(decoder);
    let mut seen = HashSet::new();
    for entry in archive.entries()? {
        control_io(control)?;
        let mut entry = entry?;
        let archive_path = normalize_archive_path(&entry.path()?)?;
        let kind = entry_kind(entry.header().entry_type())?;
        let target = expected.get(&archive_path).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected archive entry: {archive_path}"),
            )
        })?;
        let expected_kind = if target.is_dir {
            ArchiveEntryKind::Directory
        } else {
            ArchiveEntryKind::File
        };
        if !seen.insert(archive_path.clone())
            || kind != expected_kind
            || (!target.is_dir && entry.size() != target.size)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid archive entry: {archive_path}"),
            ));
        }
        if target.is_dir {
            std::fs::create_dir_all(&target.destination)?;
            continue;
        }
        let parent = target.destination.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "archive target has no parent")
        })?;
        std::fs::create_dir_all(parent)?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target.destination)?;
        let mut writer = io::BufWriter::new(file);
        let mut reader = ControlledReader::new(&mut entry, control.clone());
        let copied = io::copy(&mut reader, &mut writer)?;
        if copied != target.size {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("archive entry size changed: {archive_path}"),
            ));
        }
        use std::io::Write;
        writer.flush()?;
        writer.get_ref().sync_all()?;
    }
    if seen.len() != expected.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "archive is missing manifest entries",
        ));
    }
    Ok(())
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
                TransferRunError::Message(value) => value,
            },
        )
    })
}

fn blocking_error(error: io::Error, control: &TaskControl) -> TransferRunError {
    if control.is_cancelled() {
        TransferRunError::Canceled
    } else {
        message(format!("archive operation failed: {error}"))
    }
}

fn message(value: impl Into<String>) -> TransferRunError {
    TransferRunError::Message(value.into())
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
    fn archive_validation_rejects_parent_paths_and_links() {
        let directory = tempfile::tempdir().unwrap();
        let control = Arc::new(TaskControl::new());
        let parent = directory.path().join("parent.tar.gz");
        write_test_archive(&parent, b"../escape", EntryType::Regular);
        assert!(validate_archive(&parent, &HashMap::new(), &control).is_err());

        let link = directory.path().join("link.tar.gz");
        write_test_archive(&link, b"link", EntryType::Symlink);
        assert!(validate_archive(&link, &HashMap::new(), &control).is_err());
    }

    #[test]
    fn safe_extraction_uses_manifest_destination_instead_of_archive_path() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("safe.tar.gz");
        write_test_archive(&archive_path, b"remote/name.txt", EntryType::Regular);
        let destination = directory.path().join("stage").join("safe-name.txt");
        let expected = HashMap::from([(
            "remote/name.txt".to_string(),
            ExtractEntry {
                destination: destination.clone(),
                size: 0,
                is_dir: false,
            },
        )]);
        extract_archive(&archive_path, expected, &Arc::new(TaskControl::new())).unwrap();
        assert!(destination.is_file());
        assert!(!directory.path().join("remote").exists());
    }
}
