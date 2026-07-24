//! WSL Archive 文件传输数据面。
//!
//! 上传先在宿主机生成归档并以单流复制到 WSL 私有临时目录；下载先在 WSL 内生成
//! 归档，再以单流复制到宿主机。两端 SHA-256 一致后才安全解包，结果始终进入
//! Planner 指定的 staging，最终仍使用通用 no-replace 提交。

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

#[cfg(windows)]
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

use crate::modules::transfers::archive::{
    build_wsl_upload_archive, extract_download_archive_roots, ArchiveEntryKind, ExtractRoot,
};
use crate::modules::transfers::commit::{cleanup_local_staging, commit_local_root, LocalRoot};
use crate::modules::transfers::errors::TransferErrorCode;
use crate::modules::transfers::local::verify_apply_commit;
use crate::modules::transfers::manager::TransferRunError;
use crate::modules::transfers::models::TransferStage;
use crate::modules::transfers::planner::{LocalPlan, WslArchiveContext};
use crate::modules::transfers::progress::ExecutionContext;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const COPY_BUFFER_BYTES: usize = 256 * 1024;
const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

type RunResult<T> = Result<T, TransferRunError>;

/// 按 Planner 保留的 WSL 方向执行上传或下载。
pub(crate) async fn execute(plan: LocalPlan, context: &mut ExecutionContext) -> RunResult<()> {
    #[cfg(windows)]
    {
        match &plan.wsl {
            WslArchiveContext::Upload {
                distro,
                destination_parent,
            } => execute_upload(&plan, distro, destination_parent, context).await,
            WslArchiveContext::Download { distro, sources } => {
                execute_download(&plan, distro, sources, context).await
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (plan, context);
        Err(message("WSL archive transfer is only available on Windows"))
    }
}

#[cfg(windows)]
async fn execute_upload(
    plan: &LocalPlan,
    distro: &str,
    destination_parent: &str,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut work_dir = None;
    let result = async {
        ensure_capability(distro).await?;
        let archive = build_wsl_upload_archive(plan, context).await?;
        context.set_archive_size(archive.size).await;
        context.set_archive_file_count(archive.file_count).await;

        let directory = create_upload_work_dir(distro, destination_parent).await?;
        work_dir = Some(directory.clone());
        let remote_archive = format!("{directory}/payload.tar.gz");
        let host_archive = resolve_path(
            &remote_archive,
            &WorkspaceEnv::Wsl {
                distro: distro.to_string(),
            },
        );
        let copied_sha256 =
            copy_archive_to_new(&archive.path, &host_archive, archive.size, context).await?;
        if copied_sha256 != archive.sha256 {
            return Err(message("WSL archive changed during transfer"));
        }
        context.set_stage(TransferStage::Verifying).await;
        verify_and_extract_wsl_archive(
            distro,
            &remote_archive,
            &directory,
            archive.size,
            &archive.sha256,
            context,
        )
        .await?;
        publish_upload_staging(plan, distro, &directory, context).await?;
        cleanup_work_dir(distro, &directory).await;
        work_dir = None;
        context.complete_files(archive.file_count).await;
        verify_apply_commit(plan, context).await
    }
    .await;
    if let Some(directory) = work_dir {
        if matches!(&result, Err(TransferRunError::Canceled)) {
            schedule_cleanup_work_dir(distro.to_string(), directory);
        } else {
            cleanup_work_dir(distro, &directory).await;
        }
    }
    if result.is_err() {
        cleanup_local_staging(&plan.roots).await;
    }
    result
}

#[cfg(windows)]
async fn execute_download(
    plan: &LocalPlan,
    distro: &str,
    sources: &[String],
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let mut work_dir = None;
    let result = async {
        ensure_capability(distro).await?;
        context.set_stage(TransferStage::Archiving).await;
        let directory = create_work_dir(distro).await?;
        work_dir = Some(directory.clone());
        let remote_archive = format!("{directory}/payload.tar.gz");
        context.set_stage(TransferStage::Verifying).await;
        let remote_sha256 = create_wsl_archive(distro, &remote_archive, sources, context).await?;
        verify_sources(plan, context).await?;

        let host_archive = resolve_path(
            &remote_archive,
            &WorkspaceEnv::Wsl {
                distro: distro.to_string(),
            },
        );
        let archive_size = tokio::fs::symlink_metadata(&host_archive)
            .await
            .map_err(|error| message(format!("stat WSL archive: {error}")))?
            .len();
        context.set_archive_size(archive_size).await;
        let temporary = tempfile::Builder::new()
            .prefix("terax-archive-")
            .suffix(".tar.gz")
            .tempfile()
            .map_err(|error| message(format!("create local archive: {error}")))?;
        let local_archive = temporary.path().to_path_buf();
        let output = temporary
            .reopen()
            .map_err(|error| message(format!("open local archive: {error}")))?;
        let mut output = tokio::fs::File::from_std(output);
        let local_sha256 = copy_archive(&host_archive, &mut output, archive_size, context).await?;
        if local_sha256 != remote_sha256 {
            return Err(message("downloaded WSL archive checksum mismatch"));
        }
        cleanup_work_dir(distro, &directory).await;
        work_dir = None;

        let roots = download_extract_roots(plan, sources)?;
        let file_count = extract_download_archive_roots(&local_archive, roots, context).await?;
        context.set_archive_file_count(file_count).await;
        context.complete_files(file_count).await;
        verify_apply_commit(plan, context).await
    }
    .await;
    if let Some(directory) = work_dir {
        if matches!(&result, Err(TransferRunError::Canceled)) {
            schedule_cleanup_work_dir(distro.to_string(), directory);
        } else {
            cleanup_work_dir(distro, &directory).await;
        }
    }
    if result.is_err() {
        cleanup_local_staging(&plan.roots).await;
    }
    result
}

#[cfg(windows)]
/// 排他创建 WSL 侧归档目标，并在复制过程中返回实际数据流的 SHA-256。
async fn copy_archive_to_new(
    source: &Path,
    destination: &Path,
    expected: u64,
    context: &mut ExecutionContext,
) -> RunResult<String> {
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await
        .map_err(|error| message(format!("create WSL archive: {error}")))?;
    copy_archive(source, &mut output, expected, context).await
}

#[cfg(windows)]
/// 复制一条 WSL 归档流，同时统计长度和计算 SHA-256，避免完成后再次读取。
async fn copy_archive(
    source: &Path,
    output: &mut tokio::fs::File,
    expected: u64,
    context: &mut ExecutionContext,
) -> RunResult<String> {
    context.set_stage(TransferStage::Transferring).await;
    let mut input = tokio::fs::File::open(source)
        .await
        .map_err(|error| message(format!("open archive source: {error}")))?;
    let mut copied = 0u64;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; COPY_BUFFER_BYTES];
    loop {
        context.checkpoint().await?;
        let read = input
            .read(&mut buffer)
            .await
            .map_err(|error| message(format!("read archive stream: {error}")))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .await
            .map_err(|error| message(format!("write archive stream: {error}")))?;
        digest.update(&buffer[..read]);
        copied = copied.saturating_add(read as u64);
        context.report_bytes(read as u64).await;
    }
    output
        .flush()
        .await
        .map_err(|error| message(format!("flush archive stream: {error}")))?;
    output
        .sync_all()
        .await
        .map_err(|error| message(format!("sync archive stream: {error}")))?;
    if copied != expected {
        return Err(message(format!(
            "archive size changed during transfer: expected {expected}, found {copied}"
        )));
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(windows)]
async fn ensure_capability(distro: &str) -> RunResult<()> {
    capture_wsl(
        distro,
        "sh",
        &[
            "-c",
            "command -v tar >/dev/null && command -v gzip >/dev/null && command -v mktemp >/dev/null && (command -v sha256sum >/dev/null || command -v shasum >/dev/null || command -v openssl >/dev/null)",
        ],
    )
    .await
    .map(|_| ())
    .map_err(|_| {
        TransferRunError::failed(
            TransferErrorCode::ArchiveUnavailable,
            "WSL Archive requires tar, gzip, mktemp, and a SHA-256 tool",
        )
    })
}

#[cfg(windows)]
/// 在一个 WSL 进程中校验归档大小和 SHA-256，成功后解压并删除压缩包。
async fn verify_and_extract_wsl_archive(
    distro: &str,
    archive: &str,
    directory: &str,
    expected_size: u64,
    expected_sha256: &str,
    context: &ExecutionContext,
) -> RunResult<()> {
    const SCRIPT: &str = r#"
set -e
archive=$1
directory=$2
expected_size=$3
expected_sha256=$4
size=$(wc -c < "$archive")
[ "$size" = "$expected_size" ] || exit 73
if command -v sha256sum >/dev/null 2>&1; then
  checksum=$(sha256sum -- "$archive")
  checksum=${checksum%% *}
elif command -v shasum >/dev/null 2>&1; then
  checksum=$(shasum -a 256 -- "$archive")
  checksum=${checksum%% *}
else
  checksum=$(openssl dgst -sha256 "$archive")
  checksum=${checksum##* }
fi
[ "$checksum" = "$expected_sha256" ] || exit 74
tar -xzf "$archive" -C "$directory"
rm -f -- "$archive"
"#;
    run_wsl_program(
        distro,
        "sh",
        &[
            "-c",
            SCRIPT,
            "terax-wsl-archive-verify",
            archive,
            directory,
            &expected_size.to_string(),
            expected_sha256,
        ],
        context,
    )
    .await
    .map(|_| ())
}

#[cfg(windows)]
/// 在一个 WSL 进程中创建归档并返回服务器本地计算的 SHA-256。
async fn create_wsl_archive(
    distro: &str,
    archive: &str,
    sources: &[String],
    context: &ExecutionContext,
) -> RunResult<String> {
    const SCRIPT: &str = r#"
set -e
archive=$1
shift
tar -czf "$archive" -C / -- "$@"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -- "$archive"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -- "$archive"
else
  openssl dgst -sha256 "$archive"
fi
"#;
    let mut arguments = vec![
        "-c".to_string(),
        SCRIPT.to_string(),
        "terax-wsl-archive-create".to_string(),
        archive.to_string(),
    ];
    for source in sources {
        arguments.push(format!("./{}", archive_source_path(source)?));
    }
    let arguments: Vec<_> = arguments.iter().map(String::as_str).collect();
    let output = run_wsl_program(distro, "sh", &arguments, context).await?;
    parse_sha256(&output)
}

#[cfg(windows)]
async fn create_work_dir(distro: &str) -> RunResult<String> {
    let output = capture_wsl(
        distro,
        "sh",
        &[
            "-c",
            "umask 077; mktemp -d \"${TMPDIR:-/tmp}/terax-archive.XXXXXXXX\"",
        ],
    )
    .await?;
    let directory = output.trim();
    validate_work_dir(directory)?;
    Ok(directory.to_string())
}

#[cfg(windows)]
async fn create_upload_work_dir(distro: &str, destination_parent: &str) -> RunResult<String> {
    let parent = destination_parent.trim_end_matches('/');
    let name = format!(".terax-archive-{}", Uuid::new_v4());
    let directory = if parent.is_empty() {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    };
    validate_work_dir(&directory)?;
    capture_wsl(distro, "mkdir", &["-m", "700", "--", &directory]).await?;
    Ok(directory)
}

#[cfg(windows)]
async fn cleanup_work_dir(distro: &str, directory: &str) {
    if validate_work_dir(directory).is_err() {
        log::warn!("refused to clean invalid WSL archive directory: {directory}");
        return;
    }
    if let Err(error) = capture_wsl(distro, "rm", &["-rf", "--", directory]).await {
        log::warn!("failed to clean WSL archive directory {directory}: {error:?}");
    }
}

#[cfg(windows)]
/// 取消后在后台执行单个 WSL 本地递归删除，避免清理阻塞任务进入 Canceled。
fn schedule_cleanup_work_dir(distro: String, directory: String) {
    tauri::async_runtime::spawn(async move {
        cleanup_work_dir(&distro, &directory).await;
    });
}

#[cfg(windows)]
fn validate_work_dir(path: &str) -> RunResult<()> {
    if !path.starts_with('/')
        || path.contains(['\0', '\r', '\n'])
        || path
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return Err(message("invalid WSL archive directory"));
    }
    let name = path.rsplit('/').next().unwrap_or_default();
    let mktemp = name.strip_prefix("terax-archive.").is_some_and(|suffix| {
        suffix.len() == 8
            && suffix
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
    });
    let adjacent = name
        .strip_prefix(".terax-archive-")
        .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok());
    if !mktemp && !adjacent {
        return Err(message("invalid WSL archive directory"));
    }
    Ok(())
}

#[cfg(windows)]
async fn capture_wsl(distro: &str, program: &str, args: &[&str]) -> RunResult<String> {
    let distro = distro.to_string();
    let program = program.to_string();
    let args: Vec<String> = args.iter().map(|value| (*value).to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let refs: Vec<_> = args.iter().map(String::as_str).collect();
        crate::modules::workspace::wsl_exec_capture(&distro, &program, &refs)
            .map_err(|error| message(format!("run WSL archive command: {error}")))
    })
    .await
    .map_err(|error| message(format!("join WSL archive command: {error}")))?
}

#[cfg(windows)]
async fn run_wsl_program(
    distro: &str,
    program: &str,
    args: &[&str],
    context: &ExecutionContext,
) -> RunResult<Vec<u8>> {
    crate::modules::workspace::validate_wsl_distro_name(distro)
        .map_err(|error| message(format!("invalid WSL archive environment: {error}")))?;
    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("sh")
        .arg("-c")
        .arg("printf '%s\\n' \"$$\"; exec \"$@\"")
        .arg("terax-wsl-archive")
        .arg(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::modules::proc::hide_console(command.as_std_mut());
    let mut child = command
        .spawn()
        .map_err(|error| message(format!("start WSL archive command: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| message("WSL archive stdout is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| message("WSL archive stderr is unavailable"))?;
    let mut stdout = BufReader::new(stdout);
    let mut pid_line = String::new();
    stdout
        .read_line(&mut pid_line)
        .await
        .map_err(|error| message(format!("read WSL archive process id: {error}")))?;
    let pid = pid_line
        .trim()
        .parse::<u32>()
        .map_err(|_| message("WSL archive process did not report a valid process id"))?;
    let stdout_task = tokio::spawn(read_limited(stdout));
    let stderr_task = tokio::spawn(read_limited(stderr));
    let control = context.control();
    let mut stopped = false;
    let timeout = tokio::time::sleep(COMMAND_TIMEOUT);
    tokio::pin!(timeout);

    let status = loop {
        if control.is_cancelled() {
            let _ = signal_wsl(distro, pid, "KILL").await;
            let _ = child.kill().await;
            return Err(TransferRunError::Canceled);
        }
        let paused = control.is_paused();
        if paused != stopped {
            if let Err(error) = signal_wsl(distro, pid, if paused { "STOP" } else { "CONT" }).await
            {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) => return Err(error),
                    Err(wait_error) => {
                        return Err(message(format!(
                            "inspect WSL archive command: {wait_error}"
                        )));
                    }
                }
            }
            stopped = paused;
        }
        tokio::select! {
            status = child.wait() => {
                break status.map_err(|error| message(format!("wait for WSL archive command: {error}")))?;
            }
            change = control.wait_for_change() => {
                if change.is_err() {
                    let _ = signal_wsl(distro, pid, "KILL").await;
                    let _ = child.kill().await;
                    return Err(TransferRunError::Canceled);
                }
            }
            _ = &mut timeout => {
                let _ = signal_wsl(distro, pid, "KILL").await;
                let _ = child.kill().await;
                return Err(message("WSL archive command timed out"));
            }
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| message(format!("join WSL archive stdout: {error}")))??;
    let stderr = stderr_task
        .await
        .map_err(|error| message(format!("join WSL archive stderr: {error}")))??;
    if status.success() {
        Ok(stdout)
    } else {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(message(format!(
            "WSL archive command failed: {}",
            String::from_utf8_lossy(&detail).trim()
        )))
    }
}

#[cfg(windows)]
async fn signal_wsl(distro: &str, pid: u32, signal: &str) -> RunResult<()> {
    tokio::time::timeout(
        Duration::from_secs(2),
        capture_wsl(
            distro,
            "kill",
            &[&format!("-{signal}"), "--", &pid.to_string()],
        ),
    )
    .await
    .map_err(|_| message("signal WSL archive command timed out"))?
    .map(|_| ())
}

#[cfg(windows)]
async fn read_limited<R>(reader: R) -> RunResult<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    reader
        .take((COMMAND_OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut output)
        .await
        .map_err(|error| message(format!("read WSL archive output: {error}")))?;
    if output.len() > COMMAND_OUTPUT_LIMIT {
        return Err(message("WSL archive command output exceeded the limit"));
    }
    Ok(output)
}

#[cfg(windows)]
async fn publish_upload_staging(
    plan: &LocalPlan,
    distro: &str,
    work_dir: &str,
    context: &ExecutionContext,
) -> RunResult<()> {
    let host_work_dir = resolve_path(
        work_dir,
        &WorkspaceEnv::Wsl {
            distro: distro.to_string(),
        },
    );
    for root in &plan.roots {
        context.checkpoint().await?;
        let name = root
            .stage
            .file_name()
            .ok_or_else(|| message("WSL staging root has no filename"))?;
        commit_local_root(&LocalRoot {
            stage: host_work_dir.join(name),
            final_path: root.stage.clone(),
        })
        .await?;
    }
    Ok(())
}

#[cfg(windows)]
async fn verify_sources(plan: &LocalPlan, context: &ExecutionContext) -> RunResult<()> {
    for file in &plan.files {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&file.source)
            .await
            .map_err(|error| message(format!("verify WSL source: {error}")))?;
        if !metadata.is_file()
            || file
                .source_identity
                .is_some_and(|expected| !expected.matches_metadata(&metadata))
            || metadata.len() != file.size
            || file
                .metadata
                .modified()
                .is_some_and(|expected| metadata.modified().ok() != Some(expected))
        {
            return Err(message(format!(
                "WSL source changed while archiving: {}",
                file.source.display()
            )));
        }
    }
    for directory in &plan.directories {
        context.checkpoint().await?;
        let metadata = tokio::fs::symlink_metadata(&directory.source)
            .await
            .map_err(|error| message(format!("verify WSL directory: {error}")))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || directory
                .source_identity
                .is_some_and(|expected| !expected.matches_metadata(&metadata))
        {
            return Err(message(format!(
                "WSL source changed while archiving: {}",
                directory.source.display()
            )));
        }
    }
    Ok(())
}

fn download_extract_roots(plan: &LocalPlan, sources: &[String]) -> RunResult<Vec<ExtractRoot>> {
    if sources.len() != plan.roots.len() {
        return Err(message("WSL archive root count changed"));
    }
    sources
        .iter()
        .zip(&plan.roots)
        .map(|(source, root)| {
            Ok(ExtractRoot {
                archive_path: archive_source_path(source)?,
                destination: root.stage.clone(),
                kind: if plan.files.iter().any(|file| file.destination == root.stage) {
                    ArchiveEntryKind::File
                } else {
                    ArchiveEntryKind::Directory
                },
            })
        })
        .collect()
}

fn archive_source_path(source: &str) -> RunResult<String> {
    let relative = source
        .strip_prefix('/')
        .filter(|value| !value.is_empty())
        .ok_or_else(|| message(format!("invalid WSL archive source: {source}")))?;
    if relative.contains(['\\', '\0', '\r', '\n'])
        || relative
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(message(format!("invalid WSL archive source: {source}")));
    }
    Ok(relative.to_string())
}

/// 解析 WSL sha256sum 的首个完整十六进制摘要。
fn parse_sha256(output: &[u8]) -> RunResult<String> {
    std::str::from_utf8(output)
        .map_err(|_| message("WSL archive checksum output is not UTF-8"))?
        .split_whitespace()
        .find_map(|value| {
            (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .then(|| value.to_ascii_lowercase())
        })
        .ok_or_else(|| message("WSL archive checksum is invalid"))
}

fn message(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IoFailed, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_sources_must_be_absolute_and_normalized() {
        assert_eq!(
            archive_source_path("/home/user/file.txt").unwrap(),
            "home/user/file.txt"
        );
        for path in [
            "relative",
            "/",
            "/home/../root",
            "/home//file",
            "/home\\file",
        ] {
            assert!(archive_source_path(path).is_err(), "accepted {path:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_is_limited_to_mktemp_shape() {
        assert!(validate_work_dir("/tmp/terax-archive.Ab12Cd34").is_ok());
        assert!(validate_work_dir(
            "/home/user/.terax-archive-550e8400-e29b-41d4-a716-446655440000"
        )
        .is_ok());
        for path in [
            "/tmp/terax-archive.short",
            "/tmp/other.Ab12Cd34",
            "/tmp/../terax-archive.Ab12Cd34",
            "tmp/terax-archive.Ab12Cd34",
        ] {
            assert!(validate_work_dir(path).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn sha256sum_output_requires_a_complete_digest() {
        let digest = "A".repeat(64);
        assert_eq!(
            parse_sha256(format!("{digest}  payload.tar.gz\n").as_bytes()).unwrap(),
            digest.to_lowercase()
        );
        assert!(parse_sha256(b"short payload.tar.gz\n").is_err());
    }
}
