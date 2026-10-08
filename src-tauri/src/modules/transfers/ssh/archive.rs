//! SSH Archive 文件传输数据面。
//!
//! 上传在本地生成 tar.gz，下载在远端任务私有目录生成 tar.gz。归档只通过一个任务
//! 独占 SFTP 流传输，两端以 SHA-256 校验同一归档字节；解包结果仍进入通用 staging
//! 并使用 no-replace 提交。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::modules::remote::session::{join_remote, shell_quote, ExecOutput, RemoteWorkspace};
use crate::modules::transfers::archive::{
    build_upload_archive, extract_download_archive_roots, ArchiveEntryKind, ExtractRoot,
};
use crate::modules::transfers::commit::{
    cleanup_local_staging, commit_local_roots_tracked, commit_remote_roots_tracked,
    ensure_remote_target_available, schedule_local_cleanup,
};
use crate::modules::transfers::diagnostics::PhaseTimer;
use crate::modules::transfers::errors::{io_failure, TransferErrorCode};
use crate::modules::transfers::manager::{TaskControl, TransferRunError};
use crate::modules::transfers::models::TransferStage;
use crate::modules::transfers::planner::{RemoteDownloadPlan, RemoteUploadPlan};
use crate::modules::transfers::progress::ExecutionContext;
use russh::{ChannelMsg, Sig};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const COPY_BUFFER_BYTES: usize = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const COMMAND_OUTPUT_LIMIT: usize = 1024 * 1024;

type RunResult<T> = Result<T, TransferRunError>;

/// 执行本地打包、单流上传、远端校验解包和最终提交。
pub(crate) async fn execute_upload(
    plan: RemoteUploadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let _timer = PhaseTimer::new(context.task_id(), "ssh_upload_total");
    let remote_parent = common_remote_parent(
        plan.roots
            .iter()
            .map(|root| root.stage.as_str())
            .collect::<Vec<_>>()
            .as_slice(),
    )?;
    let cleanup_scope = super::cleanup::RemoteCleanupScope::for_upload(
        &plan.workspace,
        plan.task_id.clone(),
        plan.owner_task_id.clone(),
        plan.roots.iter().map(|root| root.final_path.as_str()),
    );
    let mut remote_work: Option<String> = None;
    let mut pending_cleanup = Vec::new();
    let result = async {
        ensure_archive_capability(&plan.workspace, context, false).await?;
        let archive = build_upload_archive(&plan, &remote_parent, context).await?;
        context.set_archive_size(archive.size).await?;
        context.set_archive_file_count(archive.file_count).await?;

        let work_dir = join_remote(&remote_parent, &format!(".terax-archive-{}", plan.task_id));
        ensure_remote_target_available(&plan.session, &work_dir).await?;
        let command = format!("umask 077; mkdir -- {}", shell_quote(&work_dir));
        run_checked(&plan.workspace, &command, context).await?;
        remote_work = Some(work_dir.clone());
        verify_private_work_dir(&plan.session, &work_dir).await?;

        let archive_path = join_remote(&work_dir, "payload.tar.gz");
        upload_archive(&plan.session, &archive.path, &archive_path, context).await?;

        context.set_stage(TransferStage::Verifying).await;
        verify_and_extract_remote_archive(
            &plan.workspace,
            &archive_path,
            &work_dir,
            archive.size,
            &archive.sha256,
            context,
        )
        .await?;

        for root in &plan.roots {
            context.checkpoint().await?;
            let name = remote_name(&root.stage)?;
            let extracted = join_remote(&work_dir, name);
            ensure_remote_target_available(&plan.session, &root.stage).await?;
            super::io::run(
                format!("publish extracted staging {}", root.stage),
                plan.session.rename(extracted, root.stage.clone()),
            )
            .await?;
        }
        pending_cleanup.extend(
            super::cleanup::remove_now(
                &plan.workspace,
                &cleanup_scope,
                std::slice::from_ref(&work_dir),
            )
            .await,
        );
        remote_work = None;

        context.begin_finalizing().await?;
        context.checkpoint().await?;
        pending_cleanup.extend(
            commit_remote_roots_tracked(&plan.workspace, &plan.roots, &cleanup_scope, context)
                .await?,
        );
        context
            .roots_committed(plan.roots.len() as u64, archive.file_count)
            .await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        pending_cleanup.extend(remote_work);
        pending_cleanup.extend(plan.roots.iter().map(|root| root.stage.clone()));
    }
    if !pending_cleanup.is_empty() && !super::cleanup::should_defer(&result) {
        pending_cleanup =
            super::cleanup::remove_now(&plan.workspace, &cleanup_scope, &pending_cleanup).await;
    }
    super::cleanup::schedule(cleanup_scope, pending_cleanup);
    close_sftp(&plan.session).await;
    log::info!(
        "TERAX_TRANSFER_PERF task={} success={}",
        context.task_id(),
        result.is_ok()
    );
    result
}

/// 执行远端打包、单流下载、本地安全解包和最终提交。
pub(crate) async fn execute_download(
    plan: RemoteDownloadPlan,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let _timer = PhaseTimer::new(context.task_id(), "ssh_download_total");
    let cleanup_scope = super::cleanup::RemoteCleanupScope::for_download(
        &plan.workspace,
        plan.task_id.clone(),
        plan.owner_task_id.clone(),
    );
    let mut remote_work: Option<String> = None;
    let mut pending_cleanup = Vec::new();
    let result = async {
        ensure_archive_capability(&plan.workspace, context, true).await?;
        context.set_stage(TransferStage::Archiving).await;
        let work_dir = create_remote_work_dir(&plan.workspace, &plan.task_id, context).await?;
        remote_work = Some(work_dir.clone());
        let archive_path = join_remote(&work_dir, "payload.tar.gz");
        let sources = download_root_sources(&plan)?;
        let mut command = format!("tar -czf {} -C / --", shell_quote(&archive_path));
        for source in sources {
            let relative = source
                .strip_prefix('/')
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(format!("invalid remote archive source: {source}")))?;
            command.push(' ');
            command.push_str(&shell_quote(&format!("./{relative}")));
        }
        let (archive_size, archive_sha256) = if let Some(selection) = &plan.sync {
            let mut script = selection.pack_script(&plan.roots[0].source_path, &archive_path);
            script.push_str(&format!(
                "wc -c < {}; {}\n",
                shell_quote(&archive_path),
                remote_checksum_command(&shell_quote(&archive_path))
            ));
            let output = run_sync_script(
                &plan.workspace,
                script,
                context.control(),
                COMMAND_OUTPUT_LIMIT,
            )
            .await?;
            parse_remote_archive_info(&output)?
        } else {
            create_remote_archive(&plan.workspace, &command, &archive_path, context).await?
        };
        context.set_stage(TransferStage::Verifying).await;
        verify_remote_download_sources(&plan, context).await?;
        context.set_archive_size(archive_size).await?;
        context.set_stage(TransferStage::Transferring).await;

        let temporary = tempfile::Builder::new()
            .prefix("terax-archive-")
            .suffix(".tar.gz")
            .tempfile()
            .map_err(|error| {
                TransferRunError::Failed(io_failure("create local archive", &error))
            })?;
        let archive_local_path = temporary.path().to_path_buf();
        let output = temporary
            .reopen()
            .map_err(|error| TransferRunError::Failed(io_failure("open local archive", &error)))?;
        let mut output = tokio::fs::File::from_std(output);
        let raw = super::session::open_raw(&plan.workspace).await?;
        let transfer_timer =
            PhaseTimer::new(context.task_id(), "ssh_download_stream_including_sync_hash");
        let downloaded = super::direct::download_file_into_sha256(
            &raw,
            &archive_path,
            &mut output,
            archive_size,
            context,
        )
        .await;
        let _ = raw.close_session();
        drop(transfer_timer);
        let local_sha256 = downloaded?;
        if local_sha256 != archive_sha256 {
            return Err(integrity("downloaded archive checksum mismatch"));
        }
        pending_cleanup.extend(
            super::cleanup::remove_now(
                &plan.workspace,
                &cleanup_scope,
                std::slice::from_ref(&work_dir),
            )
            .await,
        );
        remote_work = None;

        let roots = download_extract_roots(&plan)?;
        let file_count =
            extract_download_archive_roots(&archive_local_path, roots, context).await?;
        context.set_archive_file_count(file_count).await?;
        context.begin_finalizing().await?;
        context.checkpoint().await?;
        let pending_local_cleanup =
            commit_local_roots_tracked(&plan.roots, &plan.task_id, &plan.owner_task_id, context)
                .await?;
        let progress = context
            .roots_committed(plan.roots.len() as u64, file_count)
            .await;
        schedule_local_cleanup(&plan.owner_task_id, pending_local_cleanup);
        progress?;
        Ok(())
    }
    .await;
    if result.is_err() {
        pending_cleanup.extend(remote_work);
    }
    if result.is_err() {
        cleanup_local_staging(&plan.task_id, &plan.owner_task_id, &plan.roots).await;
    }
    if !pending_cleanup.is_empty() && !super::cleanup::should_defer(&result) {
        pending_cleanup =
            super::cleanup::remove_now(&plan.workspace, &cleanup_scope, &pending_cleanup).await;
    }
    super::cleanup::schedule(cleanup_scope, pending_cleanup);
    close_sftp(&plan.session).await;
    log::info!(
        "TERAX_TRANSFER_PERF task={} success={}",
        context.task_id(),
        result.is_ok()
    );
    result
}

async fn upload_archive(
    session: &Arc<SftpSession>,
    local: &Path,
    remote: &str,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    let _timer = PhaseTimer::new(context.task_id(), "ssh_upload_stream_including_sync");
    context.set_stage(TransferStage::Transferring).await;
    let control = context.control();
    let mut reader = tokio::fs::File::open(local)
        .await
        .map_err(|error| TransferRunError::Failed(io_failure("open local archive", &error)))?;
    let mut writer = super::io::run_cancellable(
        "create remote archive",
        session.open_with_flags(
            remote.to_string(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        ),
        control.as_ref(),
    )
    .await?;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        context.checkpoint().await?;
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| TransferRunError::Failed(io_failure("read local archive", &error)))?;
        if read == 0 {
            break;
        }
        super::io::run_cancellable(
            "write remote archive",
            writer.write_all(&buffer[..read]),
            control.as_ref(),
        )
        .await?;
        context.report_bytes(read as u64).await;
    }
    super::io::run_cancellable("flush remote archive", writer.flush(), control.as_ref()).await?;
    super::io::run_cancellable("sync remote archive", writer.sync_all(), control.as_ref()).await?;
    super::io::run_cancellable("close remote archive", writer.shutdown(), control.as_ref()).await
}

async fn ensure_archive_capability(
    workspace: &Arc<RemoteWorkspace>,
    context: &ExecutionContext,
    require_mktemp: bool,
) -> RunResult<()> {
    let command = if require_mktemp {
        "command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1 && command -v mktemp >/dev/null 2>&1 && (command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1)"
    } else {
        "command -v tar >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1 && (command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1)"
    };
    let output = run_remote(
        workspace,
        command,
        context.control(),
        Duration::from_secs(30),
    )
    .await?;
    if output.exit_code != Some(0) {
        return Err(TransferRunError::failed(
            TransferErrorCode::ArchiveUnavailable,
            "remote tar, gzip, checksum tool or mktemp is unavailable",
        ));
    }
    Ok(())
}

async fn create_remote_work_dir(
    workspace: &Arc<RemoteWorkspace>,
    task_id: &str,
    context: &ExecutionContext,
) -> RunResult<String> {
    let template = format!("/tmp/terax-archive.{task_id}.XXXXXXXX");
    let command = format!("umask 077; mktemp -d {}", shell_quote(&template));
    let output = run_remote(
        workspace,
        &command,
        context.control(),
        Duration::from_secs(30),
    )
    .await?;
    if output.exit_code != Some(0) || output.truncated {
        return Err(remote_command_error(
            "create remote archive directory",
            &output,
        ));
    }
    let path = String::from_utf8(output.stdout)
        .map_err(|_| integrity("remote temporary path is not valid UTF-8"))?
        .trim()
        .to_string();
    if !is_task_remote_work_dir(&path, task_id) {
        return Err(integrity("remote mktemp returned an invalid path"));
    }
    Ok(path)
}

/// 验证下载归档临时目录严格绑定当前任务，避免清理授权扩展到任意 `/tmp` 路径。
fn is_task_remote_work_dir(path: &str, task_id: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or_default();
    let prefix = format!("terax-archive.{task_id}.");
    let suffix = name.strip_prefix(&prefix).unwrap_or_default();
    path.strip_suffix(name) == Some("/tmp/")
        && !path.contains(['\0', '\r', '\n'])
        && !path.split('/').any(|part| matches!(part, "." | ".."))
        && suffix.len() == 8
        && suffix.bytes().all(|value| value.is_ascii_alphanumeric())
}

/// 确认命令通道创建的上传临时目录没有被替换或放宽访问权限。
async fn verify_private_work_dir(session: &Arc<SftpSession>, path: &str) -> RunResult<()> {
    let metadata = super::io::run(
        "stat remote archive directory",
        session.symlink_metadata(path.to_string()),
    )
    .await?;
    let permissions = metadata.permissions.unwrap_or_default() & 0o777;
    if !metadata.file_type().is_dir() || permissions != 0o700 {
        return Err(TransferRunError::failed(
            TransferErrorCode::PermissionDenied,
            format!("remote archive directory is not private: {path}"),
        ));
    }
    Ok(())
}

async fn run_checked(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    context: &ExecutionContext,
) -> RunResult<()> {
    let output = run_remote(workspace, command, context.control(), COMMAND_TIMEOUT).await?;
    if output.exit_code == Some(0) && !output.timed_out && !output.truncated {
        Ok(())
    } else {
        Err(remote_command_error("remote archive command", &output))
    }
}

async fn run_remote(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    control: Arc<TaskControl>,
    timeout: Duration,
) -> RunResult<ExecOutput> {
    run_remote_with_input(
        workspace,
        command,
        control,
        timeout,
        None,
        COMMAND_OUTPUT_LIMIT,
    )
    .await
}

/// 同步脚本复用归档命令控制，不为每个文件新建请求。
pub(crate) async fn run_sync_script(
    workspace: &Arc<RemoteWorkspace>,
    script: String,
    control: Arc<TaskControl>,
    output_limit: usize,
) -> RunResult<Vec<u8>> {
    let output = run_remote_with_input(
        workspace,
        "bash -s",
        control,
        COMMAND_TIMEOUT,
        Some(script.into_bytes()),
        output_limit,
    )
    .await?;
    if output.exit_code != Some(0) || output.timed_out || output.truncated {
        return Err(remote_command_error("sync script", &output));
    }
    Ok(output.stdout)
}

async fn run_remote_with_input(
    workspace: &Arc<RemoteWorkspace>,
    command: &str,
    control: Arc<TaskControl>,
    timeout: Duration,
    input: Option<Vec<u8>>,
    output_limit: usize,
) -> RunResult<ExecOutput> {
    let mut channel = workspace
        .handle
        .channel_open_session()
        .await
        .map_err(|error| message(format!("open archive command channel: {error}")))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|error| message(format!("start archive command: {error}")))?;
    let deadline = tokio::time::Instant::now() + timeout;
    if let Some(input) = input {
        let send = async {
            channel
                .data_bytes(input)
                .await
                .map_err(|error| message(format!("write sync input: {error}")))?;
            channel
                .eof()
                .await
                .map_err(|error| message(format!("finish sync input: {error}")))
        };
        let result = tokio::select! {
            result = tokio::time::timeout_at(deadline, send) => result.unwrap_or_else(|_| Err(message("sync input timed out"))),
            _ = control.cancelled() => Err(TransferRunError::Canceled),
        };
        if let Err(error) = result {
            let _ = channel.signal(Sig::KILL).await;
            let _ = channel.close().await;
            return Err(error);
        }
    }
    let mut output = ExecOutput::default();
    let mut remote_paused = false;
    loop {
        let paused = control.is_paused();
        if paused != remote_paused {
            channel
                .signal(Sig::Custom(if paused { "STOP" } else { "CONT" }.into()))
                .await
                .map_err(|error| message(format!("control archive command: {error}")))?;
            remote_paused = paused;
        }
        tokio::select! {
            changed = control.wait_for_change() => {
                if matches!(changed, Err(TransferRunError::Canceled)) {
                    let _ = channel.signal(Sig::KILL).await;
                    let _ = channel.close().await;
                    return Err(TransferRunError::Canceled);
                }
            }
            message = tokio::time::timeout_at(deadline, channel.wait()) => {
                match message {
                    Ok(Some(ChannelMsg::Data { data })) => {
                        append_output(&mut output.stdout, &data, &mut output.truncated, output_limit);
                    }
                    Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                        append_output(&mut output.stderr, &data, &mut output.truncated, COMMAND_OUTPUT_LIMIT);
                    }
                    Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                        output.exit_code = Some(exit_status as i32);
                    }
                    Ok(Some(ChannelMsg::ExitSignal { .. })) => output.exit_code = Some(128),
                    Ok(Some(ChannelMsg::Close)) | Ok(None) => return Ok(output),
                    Ok(_) => {}
                    Err(_) => {
                        let _ = channel.close().await;
                        output.timed_out = true;
                        return Ok(output);
                    }
                }
            }
        }
        if output.truncated {
            let _ = channel.signal(Sig::KILL).await;
            let _ = channel.close().await;
            return Ok(output);
        }
    }
}

/// 用一个远端命令完成打包、大小读取和 SHA-256 计算。
///
/// 文件树只由 tar 遍历一次，后续操作均针对服务器本地归档，不产生按文件的 SSH
/// 往返；大小和摘要通过固定两行输出返回。
async fn create_remote_archive(
    workspace: &Arc<RemoteWorkspace>,
    archive_command: &str,
    archive: &str,
    context: &ExecutionContext,
) -> RunResult<(u64, String)> {
    let _timer = PhaseTimer::new(context.task_id(), "ssh_remote_pack_and_hash");
    let archive = shell_quote(archive);
    let command = format!(
        "set -e; {archive_command}; wc -c < {archive}; {}",
        remote_checksum_command(&archive)
    );
    let output = run_remote(workspace, &command, context.control(), COMMAND_TIMEOUT).await?;
    if output.exit_code != Some(0) || output.timed_out || output.truncated {
        return Err(remote_command_error("create remote archive", &output));
    }
    parse_remote_archive_info(&output.stdout)
}

/// 在同一个远端命令中校验上传归档、解压到私有目录并删除压缩包。
async fn verify_and_extract_remote_archive(
    workspace: &Arc<RemoteWorkspace>,
    archive: &str,
    directory: &str,
    expected_size: u64,
    expected_sha256: &str,
    context: &ExecutionContext,
) -> RunResult<()> {
    let _timer = PhaseTimer::new(context.task_id(), "ssh_verify_extract_remove");
    let archive = shell_quote(archive);
    let directory = shell_quote(directory);
    let command = format!(
        "set -e; size=$(wc -c < {archive}); [ \"$size\" = {expected_size} ] || exit 73; \
         if command -v sha256sum >/dev/null 2>&1; then checksum=$(sha256sum -- {archive}); checksum=${{checksum%% *}}; \
         elif command -v shasum >/dev/null 2>&1; then checksum=$(shasum -a 256 -- {archive}); checksum=${{checksum%% *}}; \
         else checksum=$(openssl dgst -sha256 {archive}); checksum=${{checksum##* }}; fi; \
         [ \"$checksum\" = {expected_sha256} ] || exit 74; \
         tar -xzf {archive} -C {directory}; rm -f -- {archive}",
        expected_sha256 = shell_quote(expected_sha256),
    );
    let output = run_remote(workspace, &command, context.control(), COMMAND_TIMEOUT).await?;
    if output.exit_code == Some(0) && !output.timed_out && !output.truncated {
        return Ok(());
    }
    if matches!(output.exit_code, Some(73 | 74)) {
        return Err(integrity("uploaded archive checksum mismatch"));
    }
    Err(remote_command_error(
        "verify and extract remote archive",
        &output,
    ))
}

fn remote_checksum_command(archive: &str) -> String {
    format!(
        "if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {archive}; \
         elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {archive}; \
         else openssl dgst -sha256 {archive}; fi"
    )
}

/// 解析远端 checksum 命令的稳定两行输出，兼容 sha256sum、shasum 与 openssl。
fn parse_remote_archive_info(output: &[u8]) -> RunResult<(u64, String)> {
    let output = std::str::from_utf8(output)
        .map_err(|_| integrity("remote archive checksum output is not UTF-8"))?;
    let mut lines = output.lines();
    let size = lines
        .next()
        .map(str::trim)
        .ok_or_else(|| integrity("remote archive size is unavailable"))?
        .parse::<u64>()
        .map_err(|_| integrity("remote archive size is invalid"))?;
    let sha256 = lines
        .flat_map(str::split_whitespace)
        .find_map(normalize_sha256)
        .ok_or_else(|| integrity("remote archive checksum is invalid"))?;
    Ok((size, sha256))
}

/// 只接受完整的十六进制 SHA-256，并统一为小写便于跨工具比对。
fn normalize_sha256(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

/// 打包完成后只复验顶层来源，保持来源身份不变量而不恢复对子树的逐项 SFTP 扫描。
async fn verify_remote_download_sources(
    plan: &RemoteDownloadPlan,
    context: &ExecutionContext,
) -> RunResult<()> {
    for file in &plan.files {
        context.checkpoint().await?;
        let metadata = super::io::run(
            "verify remote archive source",
            plan.session.symlink_metadata(file.source.clone()),
        )
        .await?;
        if !metadata.file_type().is_file()
            || metadata.size != Some(file.size)
            || file
                .metadata
                .modified()
                .is_some_and(|expected| metadata.modified().ok() != Some(expected))
        {
            return Err(source_changed(format!(
                "remote source changed while archiving: {}",
                file.source
            )));
        }
    }
    for directory in &plan.directories {
        context.checkpoint().await?;
        let metadata = super::io::run(
            "verify remote archive source directory",
            plan.session.symlink_metadata(directory.source.clone()),
        )
        .await?;
        if !metadata.file_type().is_dir() {
            return Err(source_changed(format!(
                "remote source changed while archiving: {}",
                directory.source
            )));
        }
    }
    Ok(())
}

fn download_root_sources(plan: &RemoteDownloadPlan) -> RunResult<Vec<String>> {
    let mut sources = Vec::with_capacity(plan.roots.len());
    for root in &plan.roots {
        let source = plan
            .files
            .iter()
            .find(|file| file.destination == root.stage)
            .map(|file| file.source.clone())
            .or_else(|| {
                plan.directories
                    .iter()
                    .find(|directory| directory.destination == root.stage)
                    .map(|directory| directory.source.clone())
            })
            .ok_or_else(|| internal("archive root is missing from the manifest"))?;
        sources.push(source);
    }
    Ok(sources)
}

/// 将归档内的远端绝对路径根映射到任务私有本地 staging。
fn download_extract_roots(plan: &RemoteDownloadPlan) -> RunResult<Vec<ExtractRoot>> {
    let sources = download_root_sources(plan)?;
    if sources.len() != plan.roots.len() {
        return Err(internal("archive root count changed"));
    }
    sources
        .into_iter()
        .zip(&plan.roots)
        .map(|(source, root)| {
            Ok(ExtractRoot {
                archive_path: archive_source_path(&source)?,
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
    source
        .strip_prefix('/')
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| invalid(format!("invalid remote archive source: {source}")))
}

fn common_remote_parent(paths: &[&str]) -> RunResult<String> {
    let first = paths
        .first()
        .ok_or_else(|| internal("archive manifest has no roots"))?;
    let parent = remote_parent(first)?;
    if paths
        .iter()
        .skip(1)
        .any(|path| remote_parent(path).ok().as_deref() != Some(parent.as_str()))
    {
        return Err(internal("archive roots do not share one destination"));
    }
    Ok(parent)
}

fn remote_parent(path: &str) -> RunResult<String> {
    let (parent, name) = path
        .trim_end_matches('/')
        .rsplit_once('/')
        .ok_or_else(|| internal(format!("invalid remote path: {path}")))?;
    if name.is_empty() {
        return Err(internal(format!("invalid remote path: {path}")));
    }
    Ok(if parent.is_empty() {
        "/".to_string()
    } else {
        parent.to_string()
    })
}

fn remote_name(path: &str) -> RunResult<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| internal(format!("invalid remote path: {path}")))
}

fn remote_command_error(action: &str, output: &ExecOutput) -> TransferRunError {
    let detail = if output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    };
    let reason = if output.timed_out {
        "timed out".to_string()
    } else if output.truncated {
        "output exceeded the safety limit".to_string()
    } else if detail.is_empty() {
        format!("exit {:?}", output.exit_code)
    } else {
        detail
    };
    let code = if output.timed_out {
        TransferErrorCode::ConnectionLost
    } else {
        TransferErrorCode::IntegrityCheckFailed
    };
    TransferRunError::failed(code, format!("{action}: {reason}"))
}

fn append_output(target: &mut Vec<u8>, data: &[u8], truncated: &mut bool, limit: usize) {
    let remaining = limit.saturating_sub(target.len());
    if remaining < data.len() {
        *truncated = true;
    }
    target.extend_from_slice(&data[..data.len().min(remaining)]);
}

async fn close_sftp(session: &Arc<SftpSession>) {
    let _ = tokio::time::timeout(Duration::from_secs(1), session.close()).await;
}

fn message(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::ConnectionLost, value)
}

fn invalid(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::InvalidRequest, value)
}

fn source_changed(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::SourceChanged, value)
}

fn integrity(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::IntegrityCheckFailed, value)
}

fn internal(value: impl Into<String>) -> TransferRunError {
    TransferRunError::failed(TransferErrorCode::Internal, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_archive_paths_are_relative_and_parents_are_stable() {
        assert_eq!(
            archive_source_path("/home/user/file.txt").unwrap(),
            "home/user/file.txt"
        );
        assert_eq!(remote_parent("/home/user/file.txt").unwrap(), "/home/user");
        assert_eq!(remote_parent("/file.txt").unwrap(), "/");
        assert_eq!(remote_name("/home/user/file.txt").unwrap(), "file.txt");
    }

    #[test]
    fn remote_archive_info_accepts_sha256sum_and_openssl_output() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_remote_archive_info(format!("42\n{digest}  payload.tar.gz\n").as_bytes())
                .unwrap(),
            (42, digest.clone())
        );
        assert_eq!(
            parse_remote_archive_info(
                format!("7\nSHA2-256(payload.tar.gz)= {digest}\n").as_bytes()
            )
            .unwrap(),
            (7, digest)
        );
    }

    #[test]
    fn remote_work_directory_is_bound_to_the_exact_task() {
        let task = uuid::Uuid::new_v4();
        assert!(is_task_remote_work_dir(
            &format!("/tmp/terax-archive.{task}.a1B2c3D4"),
            &task.to_string()
        ));
        assert!(!is_task_remote_work_dir(
            &format!("/tmp/terax-archive.{}.a1B2c3D4", uuid::Uuid::new_v4()),
            &task.to_string()
        ));
        assert!(!is_task_remote_work_dir(
            &format!("/var/tmp/terax-archive.{task}.a1B2c3D4"),
            &task.to_string()
        ));
        assert!(!is_task_remote_work_dir(
            &format!("/tmp/terax-archive.{task}.too-short"),
            &task.to_string()
        ));
    }
}
