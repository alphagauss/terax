//! Alpha 运行源码定位、版本计算与内嵌归档释放。
//!
//! Debug 构建直接使用项目根目录并按运行文件内容计算 revision；Release 构建在跨进程
//! 文件锁内把内嵌归档原子释放到内容哈希目录，供统一生命周期协调逻辑比较版本。

use crate::modules::app_data::{self, Directory};
#[cfg(not(debug_assertions))]
use crate::modules::storage::FileLock;
#[cfg(any(not(debug_assertions), test))]
use flate2::read::GzDecoder;
#[cfg(any(debug_assertions, test))]
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
#[cfg(any(not(debug_assertions), test))]
use std::io::Write;
#[cfg(any(not(debug_assertions), test))]
use std::path::Component;
use std::path::{Path, PathBuf};
#[cfg(not(debug_assertions))]
use std::time::Duration;
#[cfg(any(not(debug_assertions), test))]
use tar::Archive;

const COMPLETE_MARKER: &str = ".complete";
#[cfg(any(debug_assertions, test))]
const EXCLUDED_DIRECTORIES: &[&str] = &["__pycache__", "docs", "scripts", "tests"];
#[cfg(not(debug_assertions))]
const ARCHIVE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/alpha-runtime.tar.gz"));
#[cfg(not(debug_assertions))]
const RELEASE_ARCHIVE_HASH: &str = env!("TERAX_ALPHA_RELEASE_ARCHIVE_SHA256");

/// 当前进程启动 Alpha 所需的源码目录和稳定版本标识。
pub struct RuntimeSpec {
    /// 传给 Python 模块启动器的工作目录。
    pub code_root: PathBuf,
    /// 由构建模式和运行文件内容确定的版本标识。
    pub revision: String,
}

/// 解析当前构建应使用的 Alpha 运行目录和 revision。
///
/// 开发环境按运行文件的相对路径与内容实时计算 SHA-256；生产环境复用内嵌归档哈希。
pub fn runtime_spec() -> Result<RuntimeSpec, String> {
    let code_root = code_root()?;
    #[cfg(debug_assertions)]
    let revision = development_revision(&code_root)?;
    #[cfg(not(debug_assertions))]
    let revision = format!("release:{RELEASE_ARCHIVE_HASH}");
    Ok(RuntimeSpec {
        code_root,
        revision,
    })
}

/// 判断开发文件事件是否影响当前 Alpha 运行 revision。
#[cfg(debug_assertions)]
pub(super) fn is_development_runtime_path(alpha_root: &Path, path: &Path) -> bool {
    if !is_development_runtime_scope_path(alpha_root, path) {
        return false;
    }
    let relative = path
        .strip_prefix(alpha_root)
        .expect("Alpha 开发运行路径已经验证位于监听根目录内");
    relative == Path::new("requirements-runtime.txt")
        || relative.extension().and_then(|value| value.to_str()) == Some("py")
}

/// 判断开发文件事件是否位于可能包含运行文件的目录范围内。
///
/// 目录删除和重命名事件不一定逐个报告子文件，因此监听器需要用更宽的范围判断兜底。
#[cfg(debug_assertions)]
pub(super) fn is_development_runtime_scope_path(alpha_root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(alpha_root) else {
        return false;
    };
    relative.components().all(|component| match component {
        std::path::Component::Normal(name) => !EXCLUDED_DIRECTORIES
            .iter()
            .any(|excluded| name == *excluded),
        std::path::Component::CurDir => true,
        _ => false,
    })
}

/// 返回当前构建应使用的 Alpha 代码根目录。
///
/// 开发环境使用仓库根目录，生产环境按需释放内嵌归档并返回对应内容哈希目录。
pub fn code_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法解析 Alpha 开发源码目录".to_string())?;
        validate_runtime(&root, None)?;
        Ok(root)
    }

    #[cfg(not(debug_assertions))]
    {
        ensure_embedded_runtime()
    }
}

/// 返回 Alpha 配置和本机状态根目录并确保它存在。
pub fn alpha_home() -> Result<PathBuf, String> {
    let path = app_data::directory(Directory::Alpha)?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

/// 返回 Alpha 日志目录并确保它存在。
pub fn logs_dir() -> Result<PathBuf, String> {
    let path = app_data::directory(Directory::Logs)?.join("alpha");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

/// 返回 Alpha 跨进程服务操作锁路径。
pub fn service_lock_path() -> Result<PathBuf, String> {
    Ok(app_data::directory(Directory::Alpha)?.join("service.lock"))
}

/// 返回本机服务凭据文件路径。
pub fn token_path() -> Result<PathBuf, String> {
    Ok(app_data::directory(Directory::Alpha)?.join("service.token"))
}

#[cfg(not(debug_assertions))]
fn ensure_embedded_runtime() -> Result<PathBuf, String> {
    let alpha_dir = app_data::directory(Directory::Alpha)?;
    let runtime_parent = alpha_dir.join("runtime");
    let destination = runtime_parent.join(RELEASE_ARCHIVE_HASH);
    if validate_runtime(&destination, Some(RELEASE_ARCHIVE_HASH)).is_ok() {
        return Ok(destination);
    }

    fs::create_dir_all(&runtime_parent).map_err(|error| error.to_string())?;
    let _lock = FileLock::acquire(&alpha_dir.join("extract.lock"), Duration::from_secs(20))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "等待其他 Terax 进程释放 Alpha 源码超时".to_string())?;
    if validate_runtime(&destination, Some(RELEASE_ARCHIVE_HASH)).is_ok() {
        return Ok(destination);
    }

    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|error| {
            format!(
                "无法清理损坏的 Alpha 运行目录 {}: {error}",
                destination.display()
            )
        })?;
    }
    let temporary = tempfile::Builder::new()
        .prefix(".alpha-runtime-")
        .tempdir_in(&runtime_parent)
        .map_err(|error| error.to_string())?;
    extract_archive(ARCHIVE, temporary.path()).map_err(|error| error.to_string())?;
    fs::write(
        temporary.path().join(COMPLETE_MARKER),
        RELEASE_ARCHIVE_HASH.as_bytes(),
    )
    .map_err(|error| error.to_string())?;
    validate_runtime(temporary.path(), Some(RELEASE_ARCHIVE_HASH))?;
    let temporary_path = temporary.keep();
    fs::rename(&temporary_path, &destination).map_err(|error| {
        let _ = fs::remove_dir_all(&temporary_path);
        format!("无法发布 Alpha 运行目录 {}: {error}", destination.display())
    })?;
    Ok(destination)
}

/// 计算开发源码的稳定 revision，只覆盖生产归档会包含的运行文件。
#[cfg(any(debug_assertions, test))]
fn development_revision(project_root: &Path) -> Result<String, String> {
    let alpha_root = project_root.join("alpha");
    let mut files = Vec::new();
    collect_development_files(&alpha_root, &mut files).map_err(|error| error.to_string())?;
    let requirements = alpha_root.join("requirements-runtime.txt");
    if !requirements.is_file() {
        return Err(format!(
            "Alpha 运行依赖清单不存在: {}",
            requirements.display()
        ));
    }
    files.push(requirements);
    files.sort();
    files.dedup();

    let mut hasher = Sha256::new();
    for file in files {
        let relative = file
            .strip_prefix(project_root)
            .map_err(|error| error.to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        let bytes = fs::read(&file).map_err(|error| error.to_string())?;
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    Ok(format!("dev:{:x}", hasher.finalize()))
}

/// 收集开发环境参与 revision 的 Python 运行文件，并拒绝符号链接造成的边界漂移。
#[cfg(any(debug_assertions, test))]
fn collect_development_files(directory: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Alpha runtime cannot contain symlink {}", path.display()),
            ));
        }
        if metadata.is_dir() {
            let name = entry.file_name();
            if !EXCLUDED_DIRECTORIES.contains(&name.to_string_lossy().as_ref()) {
                collect_development_files(&path, files)?;
            }
        } else if metadata.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("py")
        {
            files.push(path);
        }
    }
    Ok(())
}

/// 校验运行目录包含入口文件和可选的完整归档标记。
fn validate_runtime(root: &Path, expected_hash: Option<&str>) -> Result<(), String> {
    if !root.join("alpha").join("__main__.py").is_file() {
        return Err(format!("Alpha 入口文件不存在: {}", root.display()));
    }
    if let Some(expected_hash) = expected_hash {
        let marker =
            fs::read_to_string(root.join(COMPLETE_MARKER)).map_err(|error| error.to_string())?;
        if marker != expected_hash {
            return Err("Alpha 运行目录版本标记不匹配".to_string());
        }
    }
    Ok(())
}

/// 把受信任的内嵌归档释放到空目录，并拒绝链接和路径穿越条目。
#[cfg(any(not(debug_assertions), test))]
fn extract_archive(bytes: &[u8], destination: &Path) -> io::Result<()> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = Archive::new(decoder);
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Alpha archive can only contain regular files",
            ));
        }
        let relative = entry.path()?.into_owned();
        validate_archive_path(&relative)?;
        let output = destination.join(&relative);
        let parent = output.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Alpha archive path has no parent",
            )
        })?;
        fs::create_dir_all(parent)?;
        let mut file = fs::File::create(output)?;
        io::copy(&mut entry, &mut file)?;
        file.flush()?;
    }
    Ok(())
}

/// 确保归档条目只能落入目标目录，拒绝绝对路径、父目录和平台前缀。
#[cfg(any(not(debug_assertions), test))]
fn validate_archive_path(relative: &Path) -> io::Result<()> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsafe Alpha archive path {}", relative.display()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, GzBuilder};
    use tar::{Builder, Header};

    fn archive_with(path: &str, content: &[u8]) -> Vec<u8> {
        let encoder = GzBuilder::new()
            .mtime(0)
            .write(Vec::new(), Compression::default());
        let mut builder = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_mode(0o644);
        header.set_size(content.len() as u64);
        header.set_cksum();
        builder
            .append_data(&mut header, path, content)
            .expect("append");
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn extracts_regular_runtime_files() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = archive_with("alpha/__main__.py", b"print('ok')");
        extract_archive(&bytes, dir.path()).unwrap();
        assert_eq!(
            fs::read(dir.path().join("alpha/__main__.py")).unwrap(),
            b"print('ok')"
        );
    }

    #[test]
    fn validates_debug_runtime_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("alpha")).unwrap();
        fs::write(dir.path().join("alpha/__main__.py"), b"").unwrap();
        assert!(validate_runtime(dir.path(), None).is_ok());
        assert!(validate_runtime(dir.path(), Some("hash")).is_err());
    }

    #[test]
    fn development_revision_tracks_only_runtime_files() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = dir.path().join("alpha");
        fs::create_dir_all(alpha.join("tests")).unwrap();
        fs::write(alpha.join("__main__.py"), b"print('one')").unwrap();
        fs::write(alpha.join("requirements-runtime.txt"), b"fastapi\n").unwrap();
        fs::write(alpha.join("tests/test_main.py"), b"ignored = 1").unwrap();
        let first = development_revision(dir.path()).unwrap();

        fs::write(alpha.join("tests/test_main.py"), b"ignored = 2").unwrap();
        assert_eq!(development_revision(dir.path()).unwrap(), first);

        fs::write(alpha.join("__main__.py"), b"print('two')").unwrap();
        assert_ne!(development_revision(dir.path()).unwrap(), first);
    }

    #[test]
    fn development_runtime_filter_matches_revision_inputs() {
        let root = Path::new("C:/project/alpha");
        assert!(is_development_runtime_path(
            root,
            &root.join("api/routes/health.py")
        ));
        assert!(is_development_runtime_path(
            root,
            &root.join("requirements-runtime.txt")
        ));
        assert!(!is_development_runtime_path(
            root,
            &root.join("tests/test_app.py")
        ));
        assert!(!is_development_runtime_path(
            root,
            &root.join("api/__pycache__/app.pyc")
        ));
        assert!(!is_development_runtime_path(root, &root.join("README.md")));
        assert!(is_development_runtime_scope_path(root, &root.join("api")));
        assert!(!is_development_runtime_scope_path(
            root,
            &root.join("tests")
        ));
    }

    #[test]
    fn rejects_archive_paths_outside_destination() {
        assert!(validate_archive_path(Path::new("../outside.py")).is_err());
        assert!(validate_archive_path(Path::new("/absolute.py")).is_err());
        assert!(validate_archive_path(Path::new("alpha/../outside.py")).is_err());
        assert!(validate_archive_path(Path::new("alpha/__main__.py")).is_ok());
    }
}
