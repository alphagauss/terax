//! HTTP 文件请求复用通用网络服务与文件授权。仅处理快照、字节变换和落盘，不解释平台协议。
use super::{HttpEvent, HttpRedirectMode, HttpState};
use aes::{
    cipher::{Array, BlockCipherDecrypt, BlockCipherEncrypt, KeyInit},
    Aes128,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use terax_core::modules::{
    fs::{
        agent::{self, AgentFileState, AgentPermissionMode},
        file,
    },
    network_proxy::NetworkTarget,
    secrets::SecretsState,
    workspace::WorkspaceRegistry,
};

const MAX_BYTES: usize = super::HTTP_RESPONSE_MAX_BYTES;
const EXPIRY: Duration = Duration::from_secs(15 * 60);
static FILE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Deserialize)]
#[serde(tag = "algorithm", rename_all = "kebab-case")]
pub enum ByteTransform {
    #[serde(rename = "aes-128-ecb-pkcs7")]
    Aes128EcbPkcs7 {
        key: [u8; 16],
        operation: TransformOperation,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransformOperation {
    Encrypt,
    Decrypt,
}

/// 明确算法与原始密钥字节，协议中的 hex/base64 编码由调用方解释。
fn transform(bytes: &mut Vec<u8>, transform: Option<&ByteTransform>) -> Result<(), String> {
    let Some(ByteTransform::Aes128EcbPkcs7 { key, operation }) = transform else {
        return Ok(());
    };
    let encrypt = matches!(operation, TransformOperation::Encrypt);
    if encrypt {
        let padding = 16 - bytes.len() % 16;
        bytes.resize(bytes.len() + padding, padding as u8);
    } else if bytes.is_empty() || !bytes.len().is_multiple_of(16) {
        return Err("invalid encrypted length".into());
    }
    let cipher = Aes128::new(&Array::from(*key));
    for chunk in bytes.as_chunks_mut::<16>().0 {
        let mut block = Array::from(*chunk);
        if encrypt {
            cipher.encrypt_block(&mut block);
        } else {
            cipher.decrypt_block(&mut block);
        }
        chunk.copy_from_slice(&block);
    }
    if !encrypt {
        let pad = usize::from(*bytes.last().ok_or("empty encrypted content")?);
        if !(1..=16).contains(&pad)
            || !bytes[bytes.len() - pad..]
                .iter()
                .all(|byte| usize::from(*byte) == pad)
        {
            return Err("invalid encrypted padding".into());
        }
        bytes.truncate(bytes.len() - pad);
    }
    Ok(())
}

struct PreparedFile {
    path: tempfile::TempPath,
    created: Instant,
    size: usize,
    digest: [u8; 32],
}

impl PreparedFile {
    /// 临时目录仍可能被外部修改，上传前有界读取并核对准备时的内容身份。
    async fn read_body(&self) -> Result<Vec<u8>, String> {
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(&self.path)
            .await
            .map_err(|e| e.to_string())?;
        let metadata = file.metadata().await.map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() != self.size as u64 {
            return Err("prepared file changed".into());
        }
        let mut body = Vec::new();
        file.take(self.size as u64 + 1)
            .read_to_end(&mut body)
            .await
            .map_err(|e| e.to_string())?;
        let digest: [u8; 32] = Sha256::digest(&body).into();
        if body.len() != self.size || digest != self.digest {
            return Err("prepared file changed".into());
        }
        Ok(body)
    }
}

/// 快照按宿主隔离；显式释放、过期或宿主销毁时自动删除临时文件。
#[derive(Default)]
pub struct PreparedFiles {
    entries: Mutex<HashMap<(String, String), Arc<PreparedFile>>>,
}

impl PreparedFiles {
    pub(super) fn contains(&self, owner: &str, id: &str) -> bool {
        self.get(owner, id).is_ok()
    }
    fn insert(&self, owner: &str, id: &str, bytes: &[u8]) -> Result<(), String> {
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        entries.retain(|_, value| value.created.elapsed() < EXPIRY);
        let key = (owner.to_string(), id.to_string());
        if entries.len() >= 32
            || entries.keys().filter(|(window, _)| window == owner).count() >= 8
            || entries.contains_key(&key)
        {
            return Err("prepared file limit reached or duplicate ID".into());
        }
        let mut file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        entries.insert(
            key,
            Arc::new(PreparedFile {
                path: file.into_temp_path(),
                created: Instant::now(),
                size: bytes.len(),
                digest: Sha256::digest(bytes).into(),
            }),
        );
        Ok(())
    }

    fn get(&self, owner: &str, id: &str) -> Result<Arc<PreparedFile>, String> {
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        entries.retain(|_, value| value.created.elapsed() < EXPIRY);
        entries
            .get(&(owner.to_string(), id.to_string()))
            .cloned()
            .ok_or("prepared file unavailable".into())
    }

    pub fn release(&self, owner: &str, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&(owner.to_string(), id.to_string()));
        }
    }

    pub fn clear_owner(&self, owner: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(window, _), _| window != owner);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub owner_session_id: String,
    pub root: String,
    pub path: String,
    pub permission_mode: AgentPermissionMode,
    pub max_bytes: usize,
    pub transform: Option<ByteTransform>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMetadata {
    pub name: String,
    pub size: usize,
    pub body_size: usize,
    pub md5: String,
}

/// 按会话权限准备 Local 文件快照；原始摘要与变换后大小对应同一次读取。
pub async fn prepare(
    state: &HttpState,
    files: &AgentFileState,
    registry: &WorkspaceRegistry,
    owner: &str,
    id: &str,
    request: PrepareRequest,
) -> Result<PreparedMetadata, String> {
    let _slot = FILE_SLOTS
        .acquire()
        .await
        .map_err(|_| "file transport closed")?;
    validate_limit(request.max_bytes)?;
    let (name, mut bytes) = agent::agent_file_snapshot(
        files,
        registry,
        &request.owner_session_id,
        &request.root,
        &request.path,
        request.permission_mode,
        request.max_bytes,
    )
    .await?;
    let size = bytes.len();
    let md5 = format!("{:x}", md5::compute(&bytes));
    transform(&mut bytes, request.transform.as_ref())?;
    if bytes.len() > MAX_BYTES {
        return Err("prepared request body is too large".into());
    }
    let body_size = bytes.len();
    state.files.insert(owner, id, &bytes)?;
    Ok(PreparedMetadata {
        name,
        size,
        body_size,
        md5,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDestination {
    pub root: String,
    pub path: String,
    #[serde(default)]
    pub rename_on_conflict: bool,
    pub max_bytes: usize,
    pub transform: Option<ByteTransform>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest {
    pub url: String,
    pub method: String,
    pub headers: Option<HashMap<String, String>>,
    pub redirect: Option<HttpRedirectMode>,
    pub network_target: NetworkTarget,
    pub allow_private_network: Option<bool>,
    pub timeout_ms: Option<u64>,
    pub max_response_bytes: usize,
    pub body_file: Option<String>,
    pub destination: Option<FileDestination>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<SavedFile>,
}

#[derive(Serialize)]
pub struct SavedFile {
    pub path: String,
    pub size: usize,
}

/// 文件请求只替换请求体来源与响应正文出口，传输与 http_request 共用内核。
pub async fn request(
    secrets: &SecretsState,
    registry: &WorkspaceRegistry,
    state: &HttpState,
    owner: &str,
    input: FileRequest,
) -> Result<FileResponse, String> {
    let _slot = FILE_SLOTS
        .acquire()
        .await
        .map_err(|_| "file transport closed")?;
    validate_limit(input.max_response_bytes)?;
    let destination_root = input
        .destination
        .as_ref()
        .map(|target| -> Result<_, String> {
            validate_limit(target.max_bytes)?;
            let root = std::fs::canonicalize(&target.root).map_err(|e| e.to_string())?;
            if !registry.is_authorized_root(&root) {
                return Err("download root is not authorized".into());
            }
            Ok(root)
        })
        .transpose()?;
    let snapshot = input
        .body_file
        .as_ref()
        .map(|id| state.files.get(owner, id))
        .transpose()?;
    let body = if let Some(snapshot) = &snapshot {
        Some(snapshot.read_body().await?)
    } else {
        None
    };
    let response = Mutex::new(FileResponse::default());
    // 外层 operation 覆盖文件准备与发布的生命周期，取消会丢弃这里的完整网络 future。
    super::exchange(
        secrets,
        input.url,
        input.method,
        input.redirect,
        input.headers,
        body,
        input.allow_private_network,
        input.network_target,
        input.max_response_bytes,
        |event| {
            let mut response = response.lock().map_err(|e| e.to_string())?;
            match event {
                HttpEvent::Headers { status, headers } => {
                    response.status = status;
                    response.headers = headers;
                }
                HttpEvent::Chunk { bytes } => response.body.extend_from_slice(&bytes),
                _ => {}
            }
            Ok(())
        },
    )
    .await?;
    let mut response = response.into_inner().map_err(|e| e.to_string())?;
    if let (Some(destination), Some(root)) = (input.destination, destination_root) {
        if (200..300).contains(&response.status) {
            transform(&mut response.body, destination.transform.as_ref())?;
            if response.body.len() > destination.max_bytes {
                return Err("downloaded file is too large".into());
            }
            let path = file::create_downloaded_file(
                &root,
                &destination.path,
                &response.body,
                destination.rename_on_conflict,
            )?;
            response.file = Some(SavedFile {
                path,
                size: response.body.len(),
            });
            response.body.clear();
        }
    }
    Ok(response)
}

fn validate_limit(value: usize) -> Result<(), String> {
    if value == 0 || value > MAX_BYTES {
        return Err("file size limit is out of range".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn file_preparation_preserves_bytes_and_file_permissions() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = root.path().join("source");
        std::fs::write(&path, b"original").unwrap();
        std::fs::write(outside.path().join("secret"), b"outside").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(root.path()).unwrap();
        let files = AgentFileState::default();
        let http = HttpState::default();
        let session = uuid::Uuid::new_v4().to_string();
        let source = |path: &str, permission_mode| PrepareRequest {
            root: root.path().to_string_lossy().into_owned(),
            owner_session_id: session.clone(),
            path: path.into(),
            permission_mode,
            max_bytes: 100,
            transform: None,
        };
        let metadata = prepare(
            &http,
            &files,
            &registry,
            "window",
            "relative",
            source("source", AgentPermissionMode::Ask),
        )
        .await
        .unwrap();
        prepare(
            &http,
            &files,
            &registry,
            "window",
            "absolute",
            source(path.to_str().unwrap(), AgentPermissionMode::Ask),
        )
        .await
        .unwrap();
        assert_eq!(metadata.size, 8);
        let snapshot = http.files.get("window", "relative").unwrap();
        assert_eq!(snapshot.read_body().await.unwrap(), b"original");
        std::fs::write(&path, b"changed").unwrap();
        assert_eq!(
            std::fs::read(&http.files.get("window", "relative").unwrap().path).unwrap(),
            b"original"
        );
        assert_eq!(
            std::fs::read(&http.files.get("window", "absolute").unwrap().path).unwrap(),
            b"original"
        );
        std::fs::write(&snapshot.path, b"tampered").unwrap();
        assert!(snapshot.read_body().await.is_err());
        assert!(prepare(
            &http,
            &files,
            &registry,
            "window",
            "directory",
            source(".", AgentPermissionMode::FullAccess)
        )
        .await
        .is_err());
        assert!(prepare(
            &http,
            &files,
            &registry,
            "window",
            "outside",
            source(
                outside.path().join("secret").to_str().unwrap(),
                AgentPermissionMode::Ask
            )
        )
        .await
        .is_err());
        let mut oversized = source("source", AgentPermissionMode::Ask);
        oversized.max_bytes = 1;
        assert!(
            prepare(&http, &files, &registry, "window", "oversized", oversized)
                .await
                .is_err()
        );
        #[cfg(windows)]
        for path in ["NUL", "source:stream"] {
            assert!(prepare(
                &http,
                &files,
                &registry,
                "window",
                "device",
                source(path, AgentPermissionMode::FullAccess)
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn failed_http_responses_never_become_downloaded_files() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, expected_file) in [(200, true), (403, false)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/file", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                let mut buffer = [0; 4096];
                while !header.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert!(read > 0 && header.len() < 16384);
                    header.extend_from_slice(&buffer[..read]);
                }
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: 7\r\nConnection: close\r\n\r\npayload").as_bytes()).await.unwrap();
            });
            let root = tempfile::tempdir().unwrap();
            let registry = WorkspaceRegistry::default();
            registry.authorize(root.path()).unwrap();
            let result = request(
                &SecretsState::default(),
                &registry,
                &HttpState::default(),
                "window",
                FileRequest {
                    url,
                    method: "GET".into(),
                    headers: None,
                    redirect: Some(HttpRedirectMode::Error),
                    network_target: NetworkTarget::Direct,
                    allow_private_network: Some(true),
                    timeout_ms: Some(2000),
                    max_response_bytes: 100,
                    body_file: None,
                    destination: Some(FileDestination {
                        root: root.path().to_string_lossy().into_owned(),
                        path: "downloads/file".into(),
                        rename_on_conflict: false,
                        max_bytes: 100,
                        transform: None,
                    }),
                },
            )
            .await
            .unwrap();
            server.await.unwrap();
            assert_eq!(result.status, status);
            assert_eq!(result.file.is_some(), expected_file);
            assert_eq!(root.path().join("downloads/file").exists(), expected_file);
            if expected_file {
                assert!(result.body.is_empty());
            } else {
                assert_eq!(result.body, b"payload");
            }
        }
    }

    #[tokio::test]
    async fn cancelled_operations_reclaim_their_own_late_snapshot_only() {
        let state = HttpState::default();
        let id = uuid::Uuid::new_v4().to_string();
        state.files.insert("window", "unrelated", b"keep").unwrap();
        let result = state
            .operation("window", &id, |_event| Ok(()), 1000, async {
                state.files.insert("window", &id, b"late")?;
                state.cancel("window", &id);
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert!(state.files.get("window", &id).is_err());
        assert!(state.files.get("window", "unrelated").is_ok());
    }
    #[test]
    fn prepared_files_are_immutable_owner_scoped_and_reclaimed() {
        let files = PreparedFiles::default();
        files.insert("a", "id", b"snapshot").unwrap();
        let snapshot = files.get("a", "id").unwrap();
        let path = snapshot.path.to_path_buf();
        assert!(files.get("b", "id").is_err());
        files.release("b", "id");
        assert!(files.get("a", "id").is_ok());
        files.clear_owner("a");
        assert!(files.get("a", "id").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"snapshot");
        drop(snapshot);
        assert!(!path.exists());
    }

    #[test]
    fn aes_transform_uses_raw_keys_and_rejects_invalid_padding() {
        let key = [42u8; 16];
        for size in [0, 1, 15, 16, 17, 1000] {
            let mut bytes = vec![7; size];
            transform(
                &mut bytes,
                Some(&ByteTransform::Aes128EcbPkcs7 {
                    key,
                    operation: TransformOperation::Encrypt,
                }),
            )
            .unwrap();
            assert_eq!(bytes.len(), (size / 16 + 1) * 16);
            transform(
                &mut bytes,
                Some(&ByteTransform::Aes128EcbPkcs7 {
                    key,
                    operation: TransformOperation::Decrypt,
                }),
            )
            .unwrap();
            assert_eq!(bytes, vec![7; size]);
        }
        let cipher = Aes128::new(&Array::from(key));
        let mut invalid = Array::from([0u8; 16]);
        cipher.encrypt_block(&mut invalid);
        assert!(transform(
            &mut invalid.to_vec(),
            Some(&ByteTransform::Aes128EcbPkcs7 {
                key,
                operation: TransformOperation::Decrypt
            })
        )
        .is_err());
    }
}
