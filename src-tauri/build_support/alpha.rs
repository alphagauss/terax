//! Alpha 运行源码的构建期归档。
//!
//! 本模块只收集生产运行需要的 Python 文件，以稳定顺序生成可复现的 gzip tar
//! 归档，并把归档哈希传给应用编译过程。

use flate2::{Compression, GzBuilder};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tar::{Builder, EntryType, Header};

const EXCLUDED_DIRECTORIES: &[&str] = &["__pycache__", "docs", "scripts", "tests"];
const RUNTIME_REQUIREMENTS: &str = "requirements-runtime.txt";

/// 生成 Alpha 运行源码归档并导出内容哈希。
///
/// 归档条目使用固定元数据和排序，确保相同源码得到相同字节与版本目录。
pub fn build_archive() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "CARGO_MANIFEST_DIR is unavailable")
    })?);
    let project_root = manifest_dir.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "src-tauri must have a project parent",
        )
    })?;
    let alpha_root = project_root.join("alpha");
    let requirements = alpha_root.join(RUNTIME_REQUIREMENTS);
    if !requirements.is_file() {
        return Err(format!("missing {}", requirements.display()).into());
    }

    let mut files = Vec::new();
    collect_runtime_files(&alpha_root, &mut files)?;
    files.push(requirements);
    files.sort();
    files.dedup();

    let encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::best());
    let mut archive = Builder::new(encoder);
    archive.mode(tar::HeaderMode::Deterministic);

    for source in &files {
        println!("cargo:rerun-if-changed={}", source.display());
        let relative = source.strip_prefix(project_root)?;
        let bytes = fs::read(source)?;
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(bytes.len() as u64);
        header.set_cksum();
        archive.append_data(&mut header, relative, bytes.as_slice())?;
    }

    let encoder = archive.into_inner()?;
    let bytes = encoder.finish()?;
    let hash = hex_digest(&bytes);
    let out_dir = PathBuf::from(
        env::var_os("OUT_DIR")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "OUT_DIR is unavailable"))?,
    );
    fs::write(out_dir.join("alpha-runtime.tar.gz"), bytes)?;
    println!("cargo:rustc-env=TERAX_ALPHA_ARCHIVE_SHA256={hash}");
    Ok(())
}

/// 递归收集 Alpha 包中的 Python 运行文件。
fn collect_runtime_files(directory: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    println!("cargo:rerun-if-changed={}", directory.display());
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
            let name = name.to_string_lossy();
            if !EXCLUDED_DIRECTORIES.contains(&name.as_ref()) {
                collect_runtime_files(&path, files)?;
            }
            continue;
        }
        if metadata.is_file() && path.extension().and_then(|value| value.to_str()) == Some("py") {
            files.push(path);
        }
    }
    Ok(())
}

/// 把 SHA-256 摘要转换成稳定的小写十六进制字符串。
fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}
