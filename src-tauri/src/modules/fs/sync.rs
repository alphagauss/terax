//! 编辑器文件的单检查点分块同步。环境适配只负责取得摘要和字节区间，比较与协议共用。

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::file::{FORCE_MAX_READ_BYTES, MAX_READ_BYTES};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};
use std::io::Read;

pub(crate) const BLOCK_SIZE: usize = 256 * 1024;

/// 检查点只包含已确认正文的摘要，不保存服务器缓存或历史快照。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileCheckpoint {
    pub size: u64,
    pub mtime: u64,
    pub revision: String,
    pub blocks: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SyncChunk {
    pub offset: u64,
    pub data: String,
}

/// 变化区间使用原始字节，客户端组装完成后统一校验和解码，允许跨 UTF-8 与 CRLF 边界。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileSyncResult {
    Changed {
        checkpoint: FileCheckpoint,
        chunks: Vec<SyncChunk>,
    },
    Unchanged {
        checkpoint: FileCheckpoint,
    },
    Missing,
    TooLarge {
        size: u64,
        limit: u64,
        mtime: u64,
    },
}

#[cfg(feature = "desktop")]
pub(crate) enum FileProbe {
    Changed(FileCheckpoint),
    Unchanged(FileCheckpoint),
    Missing,
    TooLarge { size: u64, mtime: u64 },
}

pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn validate(checkpoint: &FileCheckpoint) -> Result<(), String> {
    let digest = |s: &str| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit());
    if checkpoint.size > FORCE_MAX_READ_BYTES
        || checkpoint.blocks.len() != checkpoint.size.div_ceil(BLOCK_SIZE as u64) as usize
        || !digest(&checkpoint.revision)
        || !checkpoint.blocks.iter().all(|value| digest(value))
    {
        return Err("invalid file synchronization checkpoint".into());
    }
    Ok(())
}

/// 合并相邻变化块；缩短文件只保留新长度以内的区间。
pub(crate) fn changed_ranges(
    next: &FileCheckpoint,
    previous: Option<&FileCheckpoint>,
) -> Vec<(u64, u64)> {
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    for (index, digest) in next.blocks.iter().enumerate() {
        if previous.and_then(|value| value.blocks.get(index)) == Some(digest) {
            continue;
        }
        let start = (index * BLOCK_SIZE) as u64;
        let end = (start + BLOCK_SIZE as u64).min(next.size);
        if let Some(last) = ranges.last_mut().filter(|last| last.0 + last.1 == start) {
            last.1 = end - last.0;
        } else {
            ranges.push((start, end - start));
        }
    }
    ranges
}

pub(crate) fn chunk(offset: u64, bytes: &[u8]) -> SyncChunk {
    SyncChunk {
        offset,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

pub(crate) fn from_bytes(
    bytes: Vec<u8>,
    mtime: u64,
    previous: Option<&FileCheckpoint>,
) -> FileSyncResult {
    let checkpoint = FileCheckpoint {
        size: bytes.len() as u64,
        mtime,
        revision: hash(&bytes),
        blocks: bytes.chunks(BLOCK_SIZE).map(hash).collect(),
    };
    if previous.is_some_and(|old| old.revision == checkpoint.revision) {
        return FileSyncResult::Unchanged { checkpoint };
    }
    let chunks = changed_ranges(&checkpoint, previous)
        .into_iter()
        .map(|(offset, len)| chunk(offset, &bytes[offset as usize..(offset + len) as usize]))
        .collect();
    FileSyncResult::Changed { checkpoint, chunks }
}

/// 所有环境共用有界同步入口；元数据相同时仅低频强制重新计算摘要。
pub async fn sync_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    checkpoint: Option<FileCheckpoint>,
    force: bool,
    verify: bool,
) -> Result<FileSyncResult, String> {
    if let Some(previous) = &checkpoint {
        validate(previous)?;
    }
    let limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(feature = "desktop")]
        {
            let remote = crate::modules::remote::manager::global_manager()?
                .workspace(profile_id)
                .await?;
            return crate::modules::remote::file_service::sync_file(
                &remote,
                &path,
                checkpoint.as_ref(),
                limit,
                verify,
            )
            .await;
        }
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
    }
    tokio::task::spawn_blocking(move || {
        let target = resolve_path(&path, &workspace);
        let metadata = match std::fs::metadata(&target) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileSyncResult::Missing)
            }
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() {
            return Err("file synchronization requires a regular file".into());
        }
        let size = metadata.len();
        let mtime = super::file::mtime_millis(&metadata);
        if size > limit {
            return Ok(FileSyncResult::TooLarge { size, limit, mtime });
        }
        if !verify {
            if let Some(previous) = checkpoint
                .as_ref()
                .filter(|old| old.size == size && old.mtime == mtime)
            {
                return Ok(FileSyncResult::Unchanged {
                    checkpoint: previous.clone(),
                });
            }
        }
        // 与 SSH 一样固定本轮长度，后续追加交给下一轮。
        let mut bytes = Vec::with_capacity(size as usize);
        std::fs::File::open(&target)
            .map_err(|error| error.to_string())?
            .take(size)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 != size {
            return Err("file truncated during synchronization".into());
        }
        Ok(from_bytes(bytes, mtime, checkpoint.as_ref()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unpack(
        result: FileSyncResult,
        previous: &[u8],
    ) -> (FileCheckpoint, Vec<u8>, Vec<(u64, usize)>) {
        let FileSyncResult::Changed { checkpoint, chunks } = result else {
            panic!("expected changed content")
        };
        let mut bytes = previous.to_vec();
        bytes.resize(checkpoint.size as usize, 0);
        let mut ranges = Vec::new();
        for chunk in chunks {
            let data = base64::engine::general_purpose::STANDARD
                .decode(chunk.data)
                .unwrap();
            ranges.push((chunk.offset, data.len()));
            bytes[chunk.offset as usize..chunk.offset as usize + data.len()].copy_from_slice(&data);
        }
        assert_eq!(hash(&bytes), checkpoint.revision);
        (checkpoint, bytes, ranges)
    }

    #[tokio::test]
    async fn local_sync_reuses_one_checkpoint_for_append_overwrite_truncate_and_rotation() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("live.log");
        let path = target.to_string_lossy().into_owned();
        let mut bytes = vec![b'a'; BLOCK_SIZE * 3 + 5];
        std::fs::write(&target, &bytes).unwrap();
        let (mut checkpoint, _, _) = unpack(
            sync_file(path.clone(), None, None, false, true)
                .await
                .unwrap(),
            &[],
        );
        assert!(matches!(
            sync_file(path.clone(), None, Some(checkpoint.clone()), false, false)
                .await
                .unwrap(),
            FileSyncResult::Unchanged { .. }
        ));
        let old = bytes.clone();
        bytes.extend_from_slice("追加\r\n".as_bytes());
        std::fs::write(&target, &bytes).unwrap();
        let (next, assembled, ranges) = unpack(
            sync_file(path.clone(), None, Some(checkpoint), false, true)
                .await
                .unwrap(),
            &old,
        );
        assert_eq!(assembled, bytes);
        assert_eq!(ranges, vec![((BLOCK_SIZE * 3) as u64, 13)]);
        checkpoint = next;

        let old = bytes.clone();
        bytes[BLOCK_SIZE - 1] = b'b';
        bytes[BLOCK_SIZE] = b'c';
        std::fs::write(&target, &bytes).unwrap();
        let (next, assembled, ranges) = unpack(
            sync_file(path.clone(), None, Some(checkpoint), false, true)
                .await
                .unwrap(),
            &old,
        );
        assert_eq!(assembled, bytes);
        assert_eq!(ranges, vec![(0, BLOCK_SIZE * 2)]);
        checkpoint = next;

        let old = bytes.clone();
        bytes.truncate(BLOCK_SIZE);
        std::fs::write(&target, &bytes).unwrap();
        let (next, assembled, ranges) = unpack(
            sync_file(path.clone(), None, Some(checkpoint), false, true)
                .await
                .unwrap(),
            &old,
        );
        assert_eq!(assembled, bytes);
        assert!(ranges.is_empty());

        std::fs::remove_file(&target).unwrap();
        assert!(matches!(
            sync_file(path.clone(), None, Some(next.clone()), false, true)
                .await
                .unwrap(),
            FileSyncResult::Missing
        ));
        std::fs::write(&target, b"rotated").unwrap();
        let (_, assembled, _) = unpack(
            sync_file(path, None, Some(next), false, true)
                .await
                .unwrap(),
            &bytes,
        );
        assert_eq!(assembled, b"rotated");
    }

    #[tokio::test]
    async fn verifies_same_metadata_and_preserves_limits_and_regular_file_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("file");
        let path = target.to_string_lossy().into_owned();
        std::fs::write(&target, b"first").unwrap();
        let (checkpoint, _, _) = unpack(
            sync_file(path.clone(), None, None, false, true)
                .await
                .unwrap(),
            &[],
        );
        let time =
            filetime::FileTime::from_last_modification_time(&std::fs::metadata(&target).unwrap());
        std::fs::write(&target, b"other").unwrap();
        filetime::set_file_mtime(&target, time).unwrap();
        let (_, bytes, _) = unpack(
            sync_file(path.clone(), None, Some(checkpoint), false, true)
                .await
                .unwrap(),
            b"first",
        );
        assert_eq!(bytes, b"other");
        std::fs::File::create(&target)
            .unwrap()
            .set_len(MAX_READ_BYTES + 1)
            .unwrap();
        assert!(matches!(
            sync_file(path.clone(), None, None, false, true)
                .await
                .unwrap(),
            FileSyncResult::TooLarge { .. }
        ));
        let invalid = FileCheckpoint {
            size: FORCE_MAX_READ_BYTES + 1,
            mtime: 0,
            revision: "a".repeat(64),
            blocks: vec![],
        };
        assert!(sync_file(path, None, Some(invalid), true, true)
            .await
            .is_err());
        assert!(sync_file(
            directory.path().to_string_lossy().into_owned(),
            None,
            None,
            false,
            true
        )
        .await
        .is_err());
    }
}
