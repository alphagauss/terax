//! Markdown 图片资源的准备、复用与保存。
//!
//! Local 与 WSL 复用已授权原文件，SSH 与网络图片只读取一次并保存到临时文件。
//! 所有资源按引用计数释放，网络下载同时执行 SSRF、格式和体积校验。

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;
use tempfile::{Builder as TempFileBuilder, NamedTempFile};
use uuid::Uuid;

use crate::modules::net;
use crate::modules::remote::{self, RemoteState};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEMP_IMAGE_BYTES: u64 = 128 * 1024 * 1024;
const IMAGE_SNIFF_BYTES: usize = 8 * 1024;

/// 前端允许准备的 Markdown 图片来源。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MarkdownImageSource {
    /// 当前进程工作区中的 Local、WSL 或 SSH 文件。
    Workspace {
        /// 前端已相对 Markdown 文档解析的规范路径。
        path: String,
        /// 当前进程确定的工作区环境。
        workspace: WorkspaceEnv,
    },
    /// 需要通过 SSRF 安全下载器读取的公开 HTTP(S) 图片。
    Network {
        /// 原始图片 URL，重定向会在原生侧逐跳验证。
        url: String,
        /// WebView User-Agent，只在短且无控制字符时转发。
        #[serde(rename = "userAgent")]
        user_agent: String,
    },
}

/// 可交给 asset protocol 显示并由后续命令复用的图片资源。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMarkdownImage {
    /// 资源生命周期和后续操作使用的不透明标识。
    pub token: String,
    /// 可交给 Tauri asset protocol 的本地路径。
    pub path: String,
}

struct ImageEntry {
    key: String,
    path: PathBuf,
    name: String,
    size: u64,
    refs: usize,
    temporary: Option<NamedTempFile>,
}

#[derive(Default)]
struct ImageEntries {
    by_token: HashMap<String, ImageEntry>,
    token_by_key: HashMap<String, String>,
    temporary_bytes: u64,
}

/// 维护当前 WebView 持有的图片资源及临时文件引用计数。
#[derive(Default)]
pub struct MarkdownImageState {
    entries: Mutex<ImageEntries>,
}

struct LoadedImage {
    key: String,
    path: PathBuf,
    name: String,
    size: u64,
    temporary: Option<NamedTempFile>,
}

/// 允许交给 WebView 解码的图片格式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageFormat {
    Avif,
    Gif,
    Ico,
    Jpeg,
    Png,
    Svg,
    Webp,
}

impl ImageFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Avif => "avif",
            Self::Gif => "gif",
            Self::Ico => "ico",
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Svg => "svg",
            Self::Webp => "webp",
        }
    }
}

impl MarkdownImageState {
    /// 命中已准备资源时增加引用，避免相同图片重复读取。
    fn retain_existing(&self, key: &str) -> Result<Option<PreparedMarkdownImage>, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "markdown image state is poisoned".to_string())?;
        let Some(token) = entries.token_by_key.get(key).cloned() else {
            return Ok(None);
        };
        let entry = entries
            .by_token
            .get_mut(&token)
            .ok_or_else(|| "markdown image index is inconsistent".to_string())?;
        entry.refs = entry.refs.saturating_add(1);
        Ok(Some(prepared(&token, entry)))
    }

    /// 插入新资源；并发准备已先完成时复用获胜者并丢弃重复临时文件。
    fn insert_or_retain(&self, loaded: LoadedImage) -> Result<PreparedMarkdownImage, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "markdown image state is poisoned".to_string())?;
        if let Some(token) = entries.token_by_key.get(&loaded.key).cloned() {
            let entry = entries
                .by_token
                .get_mut(&token)
                .ok_or_else(|| "markdown image index is inconsistent".to_string())?;
            entry.refs = entry.refs.saturating_add(1);
            return Ok(prepared(&token, entry));
        }

        if loaded.temporary.is_some()
            && entries.temporary_bytes.saturating_add(loaded.size) > MAX_TEMP_IMAGE_BYTES
        {
            return Err("markdown image cache limit exceeded".into());
        }
        let token = Uuid::new_v4().to_string();
        let entry = ImageEntry {
            key: loaded.key.clone(),
            path: loaded.path,
            name: loaded.name,
            size: loaded.size,
            refs: 1,
            temporary: loaded.temporary,
        };
        if entry.temporary.is_some() {
            entries.temporary_bytes = entries.temporary_bytes.saturating_add(entry.size);
        }
        let result = prepared(&token, &entry);
        entries
            .token_by_key
            .insert(entry.key.clone(), token.clone());
        entries.by_token.insert(token, entry);
        Ok(result)
    }

    /// 在保存对话框存续期间额外保留资源。
    fn retain_token(&self, token: &str) -> Result<(PathBuf, String), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "markdown image state is poisoned".to_string())?;
        let entry = entries
            .by_token
            .get_mut(token)
            .ok_or_else(|| "markdown image resource is unavailable".to_string())?;
        entry.refs = entry.refs.saturating_add(1);
        Ok((entry.path.clone(), entry.name.clone()))
    }

    /// 释放一个引用，并在计数归零时通过所有权自动删除临时文件。
    fn release(&self, token: &str) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "markdown image state is poisoned".to_string())?;
        let Some(entry) = entries.by_token.get_mut(token) else {
            return Ok(());
        };
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs > 0 {
            return Ok(());
        }
        let Some(entry) = entries.by_token.remove(token) else {
            return Ok(());
        };
        entries.token_by_key.remove(&entry.key);
        if entry.temporary.is_some() {
            entries.temporary_bytes = entries.temporary_bytes.saturating_sub(entry.size);
        }
        Ok(())
    }
}

/// 准备可显示、复制和保存的 Markdown 图片资源。
#[tauri::command]
pub async fn markdown_image_prepare(
    app: tauri::AppHandle,
    source: MarkdownImageSource,
    state: tauri::State<'_, MarkdownImageState>,
    remote: tauri::State<'_, RemoteState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<PreparedMarkdownImage, String> {
    let key = source_key(&source);
    if let Some(existing) = state.retain_existing(&key)? {
        return Ok(existing);
    }

    let loaded = match source {
        MarkdownImageSource::Workspace { path, workspace } => {
            load_workspace_image(key, path, workspace, &remote, &registry).await?
        }
        MarkdownImageSource::Network { url, user_agent } => {
            load_network_image(&app, key, url, &user_agent).await?
        }
    };
    state.insert_or_retain(loaded)
}

/// 释放一个图片资源引用；最后一个引用释放时删除临时文件。
#[tauri::command]
pub fn markdown_image_release(
    token: String,
    state: tauri::State<'_, MarkdownImageState>,
) -> Result<(), String> {
    state.release(&token)
}

/// 选择本地目标并原子保存已经准备好的原始图片。
///
/// 对话框打开期间会额外保留资源引用，取消或保存完成后统一释放。
#[tauri::command]
pub async fn markdown_image_save_as(
    token: String,
    title: String,
    image_filter: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MarkdownImageState>,
) -> Result<bool, String> {
    let (source, name) = state.retain_token(&token)?;
    let extension = Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_owned);
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .set_file_name(name);
    if let Some(extension) = extension.as_deref() {
        dialog = dialog.add_filter(image_filter, &[extension]);
    }
    let destination = dialog.blocking_save_file();
    let selected = destination.is_some();
    let copy_result = match destination {
        Some(destination) => {
            let destination = destination.into_path().map_err(|error| error.to_string());
            match destination {
                Ok(destination) => {
                    match tauri::async_runtime::spawn_blocking(move || {
                        copy_file_atomic(&source, &destination)
                    })
                    .await
                    {
                        Ok(result) => result,
                        Err(error) => Err(error.to_string()),
                    }
                }
                Err(error) => Err(error),
            }
        }
        None => Ok(()),
    };
    if let Err(error) = state.release(&token) {
        log::warn!("release markdown image after save failed: {error}");
    }
    copy_result?;
    Ok(selected)
}

/// 从当前不可变工作区环境读取图片，并只为 SSH 来源创建临时副本。
async fn load_workspace_image(
    key: String,
    path: String,
    workspace: WorkspaceEnv,
    remote: &RemoteState,
    registry: &WorkspaceRegistry,
) -> Result<LoadedImage, String> {
    let name = path_name(&path).unwrap_or_else(|| "image".into());
    if let Some(profile_id) = workspace.ssh_profile_id() {
        let remote_workspace = remote.manager.workspace(profile_id).await?;
        let canonical = remote::sftp::canonicalize(&remote_workspace, &path).await?;
        let root = remote_workspace.home().await;
        if !is_remote_path_within_root(&canonical, &root) {
            return Err("image path is outside the authorized workspace".into());
        }
        let bytes = remote::sftp::read_file(&remote_workspace, &canonical, MAX_IMAGE_BYTES).await?;
        let format = detect_image_format(&bytes)
            .ok_or_else(|| "unsupported or invalid image format".to_string())?;
        let size = bytes.len() as u64;
        let temporary = run_blocking(move || write_temporary_image(&bytes, format)).await?;
        return Ok(LoadedImage {
            key,
            path: temporary.path().to_path_buf(),
            name: normalize_name(name, format),
            size,
            temporary: Some(temporary),
        });
    }

    let resolved = resolve_path(&path, &workspace);
    let canonical =
        run_blocking(move || fs::canonicalize(&resolved).map_err(|error| error.to_string()))
            .await?;
    if !registry.is_authorized(&canonical) {
        return Err("image path is outside the authorized workspace".into());
    }
    let inspect_path = canonical.clone();
    let (size, prefix) = run_blocking(move || {
        let metadata = fs::metadata(&inspect_path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("image path is not a file".into());
        }
        if metadata.len() > MAX_IMAGE_BYTES {
            return Err(format!("image is too large: {} bytes", metadata.len()));
        }
        Ok((metadata.len(), read_prefix(&inspect_path)?))
    })
    .await?;
    let format = detect_image_format(&prefix)
        .ok_or_else(|| "unsupported or invalid image format".to_string())?;
    Ok(LoadedImage {
        key,
        path: canonical,
        name: normalize_name(name, format),
        size,
        temporary: None,
    })
}

/// 按完整路径段判断 canonical SSH 路径是否位于当前远端 Workspace 根目录。
fn is_remote_path_within_root(path: &str, root: &str) -> bool {
    if root == "/" {
        return path.starts_with('/');
    }
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return false;
    }
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// 下载公开网络图片并写入受引用计数管理的临时文件。
async fn load_network_image(
    app: &tauri::AppHandle,
    key: String,
    url: String,
    user_agent: &str,
) -> Result<LoadedImage, String> {
    let downloaded =
        net::download_public_image(app, &url, MAX_IMAGE_BYTES as usize, user_agent).await?;
    let format = detect_image_format(&downloaded.bytes)
        .ok_or_else(|| "unsupported or invalid image format".to_string())?;
    let name = downloaded
        .final_url
        .path_segments()
        .and_then(Iterator::last)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "image".into());
    let size = downloaded.bytes.len() as u64;
    let temporary = run_blocking(move || write_temporary_image(&downloaded.bytes, format)).await?;
    Ok(LoadedImage {
        key,
        path: temporary.path().to_path_buf(),
        name: normalize_name(name, format),
        size,
        temporary: Some(temporary),
    })
}

/// 生成进程内资源去重键，不在持久化边界使用。
fn source_key(source: &MarkdownImageSource) -> String {
    match source {
        MarkdownImageSource::Workspace { path, workspace } => match workspace {
            WorkspaceEnv::Wsl { distro } => format!("workspace:wsl:{distro}\0{path}"),
            WorkspaceEnv::Ssh { profile_id } => {
                format!("workspace:ssh:{profile_id}\0{path}")
            }
            WorkspaceEnv::Local => format!("workspace:local\0{path}"),
        },
        MarkdownImageSource::Network { url, .. } => format!("network:{url}"),
    }
}

/// 将可能阻塞的磁盘操作移出异步执行器工作线程。
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

fn prepared(token: &str, entry: &ImageEntry) -> PreparedMarkdownImage {
    PreparedMarkdownImage {
        token: token.to_string(),
        path: entry.path.to_string_lossy().into_owned(),
    }
}

fn read_prefix(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = vec![0; IMAGE_SNIFF_BYTES];
    let read = file.read(&mut bytes).map_err(|error| error.to_string())?;
    bytes.truncate(read);
    Ok(bytes)
}

/// 将已校验图片写入自动清理的临时文件。
fn write_temporary_image(bytes: &[u8], format: ImageFormat) -> Result<NamedTempFile, String> {
    let mut file = TempFileBuilder::new()
        .prefix("terax-markdown-image-")
        .suffix(&format!(".{}", format.extension()))
        .tempfile()
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    Ok(file)
}

/// 通过目标目录内的临时文件替换目标，避免失败时留下半写入图片。
fn copy_file_atomic(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "save destination has no parent".to_string())?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    std::io::copy(&mut input, temporary.as_file_mut()).map_err(|error| error.to_string())?;
    drop(input);
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(destination)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

fn path_name(path: &str) -> Option<String> {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .map(str::to_owned)
}

/// 清理不可信文件名、统一真实扩展名，并限制系统对话框的默认名称长度。
fn normalize_name(name: String, format: ImageFormat) -> String {
    let sanitized: String = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let extension = format!(".{}", format.extension());
    let lower = sanitized.to_ascii_lowercase();
    let stem = if lower.ends_with(&extension) {
        &sanitized[..sanitized.len() - extension.len()]
    } else {
        sanitized
            .rsplit_once('.')
            .map_or(sanitized.as_str(), |(stem, _)| stem)
    };
    let stem = stem.trim_matches('.');
    let stem = if stem.is_empty() { "image" } else { stem };
    let device_name = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let stem = if is_windows_reserved_name(&device_name) {
        "image"
    } else {
        stem
    };
    let mut bounded = String::new();
    for character in stem.chars() {
        if bounded.len() + character.len_utf8() > 120 {
            break;
        }
        bounded.push(character);
    }
    let stem = if bounded.is_empty() {
        "image"
    } else {
        &bounded
    };
    format!("{stem}{extension}")
}

/// 判断默认保存名是否命中 Windows 保留设备名。
fn is_windows_reserved_name(name: &str) -> bool {
    matches!(name, "CON" | "PRN" | "AUX" | "NUL")
        || name
            .strip_prefix("COM")
            .or_else(|| name.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                suffix.len() == 1
                    && suffix
                        .as_bytes()
                        .first()
                        .is_some_and(|digit| (b'1'..=b'9').contains(digit))
            })
}

/// 通过文件签名识别允许交给 WebView 解码的图片格式。
fn detect_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && bytes[8..bytes.len().min(32)]
            .windows(4)
            .any(|brand| matches!(brand, b"avif" | b"avis"))
    {
        return Some(ImageFormat::Avif);
    }
    if bytes.starts_with(b"\0\0\x01\0") {
        return Some(ImageFormat::Ico);
    }
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(IMAGE_SNIFF_BYTES)]);
    let trimmed = text
        .trim_start_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    let lower = trimmed.to_ascii_lowercase();
    if lower.match_indices("<svg").any(|(index, _)| {
        lower[index + 4..]
            .chars()
            .next()
            .is_some_and(|character| character.is_whitespace() || matches!(character, '>' | '/'))
    }) {
        return Some(ImageFormat::Svg);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_image_signatures() {
        assert_eq!(
            detect_image_format(b"\x89PNG\r\n\x1a\nrest"),
            Some(ImageFormat::Png)
        );
        assert_eq!(
            detect_image_format(b"\xff\xd8\xff\xe0rest"),
            Some(ImageFormat::Jpeg)
        );
        assert_eq!(detect_image_format(b"GIF89arest"), Some(ImageFormat::Gif));
        assert_eq!(
            detect_image_format(b"RIFFxxxxWEBPrest"),
            Some(ImageFormat::Webp)
        );
        assert_eq!(
            detect_image_format(b"xxxxftypavifrest"),
            Some(ImageFormat::Avif)
        );
        assert_eq!(
            detect_image_format(b"<?xml version=\"1.0\"?><svg></svg>"),
            Some(ImageFormat::Svg)
        );
        assert_eq!(
            detect_image_format(b"<!-- generated --><svg viewBox=\"0 0 1 1\"></svg>"),
            Some(ImageFormat::Svg)
        );
        assert_eq!(detect_image_format(b"<svgg></svgg>"), None);
        assert_eq!(detect_image_format(b"not an image"), None);
    }

    #[test]
    fn normalizes_untrusted_download_names() {
        assert_eq!(
            normalize_name("my image.png".into(), ImageFormat::Png),
            "my_image.png"
        );
        assert_eq!(
            normalize_name("download".into(), ImageFormat::Jpeg),
            "download.jpg"
        );
        assert_eq!(
            normalize_name("photo.jpeg".into(), ImageFormat::Jpeg),
            "photo.jpg"
        );
        assert_eq!(
            normalize_name("示意 图.png".into(), ImageFormat::Png),
            "示意_图.png"
        );
        assert_eq!(
            normalize_name("CON.preview.png".into(), ImageFormat::Png),
            "image.png"
        );
        assert_eq!(
            normalize_name(format!("{}.png", "a".repeat(200)), ImageFormat::Png).len(),
            124
        );
    }

    #[test]
    fn checks_remote_authorization_on_path_boundaries() {
        assert!(is_remote_path_within_root(
            "/srv/workspace/assets/image.png",
            "/srv/workspace"
        ));
        assert!(is_remote_path_within_root(
            "/srv/workspace",
            "/srv/workspace/"
        ));
        assert!(is_remote_path_within_root("/etc/image.png", "/"));
        assert!(!is_remote_path_within_root(
            "/srv/workspace-copy/image.png",
            "/srv/workspace"
        ));
        assert!(!is_remote_path_within_root(
            "/srv/other/image.png",
            "/srv/workspace"
        ));
    }

    #[test]
    fn releases_temporary_file_after_the_last_reference() {
        let state = MarkdownImageState::default();
        let first_temp = write_temporary_image(b"\x89PNG\r\n\x1a\nrest", ImageFormat::Png).unwrap();
        let path = first_temp.path().to_path_buf();
        let first = state
            .insert_or_retain(LoadedImage {
                key: "network:https://example.com/image.png".into(),
                path: path.clone(),
                name: "image.png".into(),
                size: 12,
                temporary: Some(first_temp),
            })
            .unwrap();
        let second = state
            .retain_existing("network:https://example.com/image.png")
            .unwrap()
            .unwrap();
        assert_eq!(first.token, second.token);

        state.release(&first.token).unwrap();
        assert!(path.exists());
        state.release(&second.token).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn atomically_replaces_an_existing_saved_image() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.png");
        let destination = directory.path().join("saved.png");
        fs::write(&source, b"new image").unwrap();
        fs::write(&destination, b"old image").unwrap();

        copy_file_atomic(&source, &destination).unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"new image");
    }
}
