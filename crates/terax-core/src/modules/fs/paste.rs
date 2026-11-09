//! 文件树粘贴在原生侧分配名称，并以无覆盖方式发布文件或目录。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::no_replace::rename_no_replace;
use crate::modules::workspace::WorkspaceEnv;

#[cfg(any(windows, feature = "workspace-runtime", all(test, target_os = "linux")))]
pub(crate) const SCRIPT: &str = include_str!("paste.sh");

const MAX_ATTEMPTS: u32 = 10_000;

/// 副本可能保留只读权限，失败退出时按私有目录规则清理。
/// 接管临时路径，避免默认析构清理绕过挂载边界。
struct PasteStaging(PathBuf);

impl Drop for PasteStaging {
    fn drop(&mut self) {
        if let Err(error) = super::cleanup::remove_owned_path(&self.0) {
            log::warn!(
                "paste staging cleanup({}) failed: {error}",
                self.0.display()
            );
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PasteMode {
    Copy,
    Cut,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum PasteError {
    InvalidPath,
    Descendant,
    Unavailable,
    CrossDevice,
    NamesExhausted,
    Io(String),
}

impl From<io::Error> for PasteError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::CrossesDevices => Self::CrossDevice,
            io::ErrorKind::Unsupported => Self::Unavailable,
            _ => Self::Io(error.to_string()),
        }
    }
}

/// 粘贴同一环境中的单个条目，返回实际落地的文件名。
pub async fn paste(
    source: String,
    destination: String,
    mode: PasteMode,
    workspace: WorkspaceEnv,
) -> Result<String, PasteError> {
    match workspace {
        WorkspaceEnv::Local => {
            blocking(move || paste_local(Path::new(&source), Path::new(&destination), mode)).await
        }
        #[cfg(windows)]
        WorkspaceEnv::Wsl { distro } => paste_wsl(&source, &destination, mode, &distro).await,
        #[cfg(feature = "workspace-runtime")]
        WorkspaceEnv::Ssh { profile_id } => {
            use crate::modules::remote::{manager::global_manager, tasks::explorer_paste};

            let args = script_args(&source, &destination, mode)?;
            let manager = global_manager().map_err(PasteError::Io)?;
            let remote = manager
                .workspace(&profile_id)
                .await
                .map_err(PasteError::Io)?;
            let output = explorer_paste::run(&remote, &args)
                .await
                .map_err(PasteError::Io)?;
            parse_script_result(&output)
        }
        #[allow(unreachable_patterns)]
        _ => Err(PasteError::Unavailable),
    }
}

#[cfg(windows)]
async fn paste_wsl(
    source: &str,
    destination: &str,
    mode: PasteMode,
    distro: &str,
) -> Result<String, PasteError> {
    use crate::modules::workspace::{
        decode_command_output, validate_wsl_distro_name, wsl_path_to_host,
    };
    use std::path::{Component, Prefix};
    use std::process::Stdio;
    use std::time::Duration;

    let args = script_args(source, destination, mode)?;
    validate_wsl_distro_name(distro).map_err(PasteError::Io)?;
    let host_target = wsl_path_to_host(distro, destination);
    if matches!(
        host_target.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    ) {
        // DrvFS 不一定提供 renameat2 的无覆盖标志。目标属于 Windows 盘时由宿主提交。
        let host_source = wsl_path_to_host(distro, source);
        return blocking(move || paste_local(&host_source, &host_target, mode)).await;
    }

    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .args(["-d", distro, "--exec", "bash", "-c", SCRIPT, "terax-paste"])
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    crate::modules::proc::hide_console(command.as_std_mut());
    let output = tokio::time::timeout(Duration::from_secs(30 * 60), command.output())
        .await
        .map_err(|_| PasteError::Io("WSL paste timed out".into()))??;
    if !output.status.success() {
        let stderr = decode_command_output(&output.stderr);
        let detail = stderr.trim();
        return Err(PasteError::Io(if detail.is_empty() {
            output.status.to_string()
        } else {
            detail.to_owned()
        }));
    }
    parse_script_result(&decode_command_output(&output.stdout))
}

async fn blocking(
    run: impl FnOnce() -> Result<String, PasteError> + Send + 'static,
) -> Result<String, PasteError> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| PasteError::Io(error.to_string()))?
}

fn paste_local(source: &Path, destination: &Path, mode: PasteMode) -> Result<String, PasteError> {
    if !source.is_absolute() || !destination.is_absolute() {
        return Err(PasteError::InvalidPath);
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(PasteError::InvalidPath)?;
    let source_parent = fs::canonicalize(source.parent().ok_or(PasteError::InvalidPath)?)?;
    let source = source_parent.join(name);
    let destination = fs::canonicalize(destination)?;
    let metadata = fs::symlink_metadata(&source)?;
    if metadata.is_dir() && is_within_directory(&source, &metadata, &destination)? {
        return Err(PasteError::Descendant);
    }
    if mode == PasteMode::Cut && source_parent == destination {
        return Ok(name.into());
    }

    let names = CopyNames::new(name, metadata.is_dir());
    let staging = if mode == PasteMode::Copy {
        let staging = PasteStaging(
            tempfile::Builder::new()
                .prefix(".terax-paste-")
                .tempdir_in(&destination)?
                .keep(),
        );
        copy_entry(&source, &staging.0.join("item"))?;
        Some(staging)
    } else {
        None
    };
    let staged_path = staging.as_ref().map(|dir| dir.0.join("item"));
    let pending = staged_path.as_deref().unwrap_or(&source);
    for attempt in 0..MAX_ATTEMPTS {
        let candidate = names.candidate(name, attempt);
        let target = destination.join(&candidate);
        match rename_no_replace(pending, &target) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            // Windows 上部分目标类型冲突会返回拒绝访问，而非名称已占用。
            Err(_) if fs::symlink_metadata(&target).is_ok() => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(PasteError::NamesExhausted)
}

fn is_within_directory(
    source: &Path,
    metadata: &fs::Metadata,
    destination: &Path,
) -> io::Result<bool> {
    if destination.starts_with(fs::canonicalize(source)?) {
        return Ok(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        // 绑定挂载可以给同一个目录提供无法通过字符串比较识别的路径。
        for ancestor in destination.ancestors() {
            let ancestor = fs::metadata(ancestor)?;
            if ancestor.dev() == metadata.dev() && ancestor.ino() == metadata.ino() {
                return Ok(true);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    Ok(false)
}

fn copy_entry(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    let kind = metadata.file_type();
    if kind.is_symlink() {
        let link = fs::read_link(source)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(link, target);
        #[cfg(windows)]
        {
            use std::os::windows::fs::{symlink_dir, symlink_file, FileTypeExt};
            return if kind.is_symlink_dir() {
                symlink_dir(link, target)
            } else {
                symlink_file(link, target)
            };
        }
    }
    if kind.is_dir() {
        fs::create_dir(target)?;
        for child in fs::read_dir(source)? {
            let child = child?;
            copy_entry(&child.path(), &target.join(child.file_name()))?;
        }
        fs::set_permissions(target, metadata.permissions())
    } else if kind.is_file() {
        fs::copy(source, target).map(|_| ())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported file type",
        ))
    }
}

struct CopyNames<'a> {
    stem: &'a str,
    extension: &'a str,
    first: u32,
}

impl<'a> CopyNames<'a> {
    fn new(name: &'a str, is_dir: bool) -> Self {
        // 用 Unix 及 Windows 文件名都适用的规则拆分扩展名，单独的前导点属于文件名。
        let (stem, extension) = match name.rfind('.') {
            Some(index) if !is_dir && index > 0 => name.split_at(index),
            _ => (name, ""),
        };
        let (stem, first) =
            if let Some(base) = stem.strip_suffix(" copy").filter(|base| !base.is_empty()) {
                (base, 2)
            } else if let Some((base, number)) = stem.rsplit_once(" copy ") {
                match number.parse::<u32>() {
                    Ok(value)
                        if !base.is_empty()
                            && number.bytes().all(|byte| byte.is_ascii_digit())
                            && value < i32::MAX as u32 =>
                    {
                        (base, value + 1)
                    }
                    _ => (stem, 1),
                }
            } else {
                (stem, 1)
            };
        Self {
            stem,
            extension,
            first,
        }
    }

    fn candidate(&self, original: &str, attempt: u32) -> String {
        if attempt == 0 {
            return original.into();
        }
        let index = self.first + attempt - 1;
        if index == 1 {
            format!("{} copy{}", self.stem, self.extension)
        } else {
            format!("{} copy {index}{}", self.stem, self.extension)
        }
    }
}

#[cfg(any(windows, feature = "workspace-runtime", test))]
fn script_args(
    source: &str,
    destination: &str,
    mode: PasteMode,
) -> Result<Vec<String>, PasteError> {
    let valid = |path: &str| {
        path.starts_with('/')
            && !path.contains(['\0', '\r', '\n'])
            && !path.split('/').any(|part| matches!(part, "." | ".."))
    };
    let source = source.trim_end_matches('/');
    if !valid(source) || !valid(destination) {
        return Err(PasteError::InvalidPath);
    }
    let name = source.rsplit('/').next().ok_or(PasteError::InvalidPath)?;
    let file = CopyNames::new(name, false);
    let dir = CopyNames::new(name, true);
    Ok(vec![
        source.into(),
        destination.into(),
        if mode == PasteMode::Cut {
            "cut"
        } else {
            "copy"
        }
        .into(),
        file.stem.into(),
        file.extension.into(),
        file.first.to_string(),
        dir.stem.into(),
        dir.first.to_string(),
        MAX_ATTEMPTS.to_string(),
    ])
}

#[cfg(any(windows, feature = "workspace-runtime", test))]
fn parse_script_result(output: &str) -> Result<String, PasteError> {
    match output {
        "descendant\n" => return Err(PasteError::Descendant),
        "unavailable\n" => return Err(PasteError::Unavailable),
        "cross-device\n" => return Err(PasteError::CrossDevice),
        "names-exhausted\n" => return Err(PasteError::NamesExhausted),
        _ => {}
    }
    output
        .strip_prefix("ok\n")
        .and_then(|value| value.strip_suffix('\n'))
        .filter(|name| !name.is_empty() && !name.contains(['/', '\0', '\n']))
        .map(str::to_owned)
        .ok_or_else(|| PasteError::Io("invalid paste response".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[cfg(target_os = "linux")]
    #[test]
    fn remote_script_preserves_targets_and_cleans_failed_copies() {
        use std::process::Command;

        if !Command::new("python3")
            .args(["-I", "-c", "import ctypes; ctypes.CDLL(None).renameat2"])
            .status()
            .is_ok_and(|status| status.success())
        {
            eprintln!("skipping remote paste: Python 3 with renameat2 is unavailable");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("paste.sh");
        fs::write(&script, SCRIPT).unwrap();
        let output = Command::new("bash")
            .args(["-c", include_str!("paste_test.sh"), "terax-paste-test"])
            .arg(script)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn concurrent_copies_preserve_existing_file_and_choose_distinct_names() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("target");
        fs::create_dir(&destination).unwrap();
        let source = temp.path().join("report.txt");
        fs::write(&source, "copy contents").unwrap();
        fs::write(destination.join("report.txt"), "existing").unwrap();

        let start = Barrier::new(2);
        let mut names = std::thread::scope(|scope| {
            let copy = || {
                start.wait();
                paste_local(&source, &destination, PasteMode::Copy).unwrap()
            };
            let first = scope.spawn(copy);
            let second = scope.spawn(copy);
            [first.join().unwrap(), second.join().unwrap()]
        });
        names.sort();
        assert_eq!(names, ["report copy 2.txt", "report copy.txt"]);
        assert_eq!(
            fs::read(destination.join("report.txt")).unwrap(),
            b"existing"
        );
        for name in names {
            assert_eq!(fs::read(destination.join(name)).unwrap(), b"copy contents");
        }
        assert_eq!(fs::read_dir(destination).unwrap().count(), 3);
    }

    #[test]
    fn cut_directory_checks_descendants_and_keeps_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("docs.v1");
        let child = source.join("sub");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("source"), "source").unwrap();
        assert_eq!(
            paste_local(&source, &child, PasteMode::Cut),
            Err(PasteError::Descendant)
        );
        assert_eq!(
            paste_local(&source, temp.path(), PasteMode::Cut).unwrap(),
            "docs.v1"
        );

        let destination = temp.path().join("target");
        let existing = destination.join("docs.v1");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("existing"), "existing").unwrap();
        let copied = paste_local(&source, &destination, PasteMode::Copy).unwrap();
        assert_eq!(copied, "docs.v1 copy");
        let moved = paste_local(&source, &destination, PasteMode::Cut).unwrap();
        assert_eq!(moved, "docs.v1 copy 2");
        assert!(!source.exists());
        assert!(existing.join("existing").is_file());
        for name in [copied, moved] {
            assert!(destination.join(&name).join("sub/source").is_file());
            assert!(!destination.join(name).join("existing").exists());
        }
    }

    #[test]
    fn abandoning_a_copy_cleans_readonly_staging_without_changing_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        let file = source.join("readonly.txt");
        fs::write(&file, "keep").unwrap();
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();
        let mut permissions = fs::metadata(&source).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&source, permissions).unwrap();

        let staging = PasteStaging(tempfile::tempdir_in(temp.path()).unwrap().keep());
        let path = staging.0.clone();
        copy_entry(&source, &path.join("item")).unwrap();
        drop(staging);

        assert!(!path.exists());
        assert_eq!(fs::read(&file).unwrap(), b"keep");
        assert!(fs::metadata(&file).unwrap().permissions().readonly());
        assert!(fs::metadata(&source).unwrap().permissions().readonly());
        super::super::cleanup::remove_owned_path(&source).unwrap();
    }

    #[test]
    fn remote_parameters_preserve_paths_and_match_native_naming() {
        let args = script_args("/tmp/a'b copy 4.txt", "/target", PasteMode::Copy).unwrap();
        assert_eq!(
            &args[..6],
            ["/tmp/a'b copy 4.txt", "/target", "copy", "a'b", ".txt", "5"]
        );
        assert_eq!(
            parse_script_result("ok\na'b copy 5.txt\n").unwrap(),
            "a'b copy 5.txt"
        );
        assert_eq!(
            parse_script_result("descendant\n"),
            Err(PasteError::Descendant)
        );
        assert_eq!(
            script_args("/", "/target", PasteMode::Cut),
            Err(PasteError::InvalidPath)
        );
    }
}
