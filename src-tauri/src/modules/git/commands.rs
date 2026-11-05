//! Git Tauri command 的薄适配层。
//!
//! 本模块只负责把阻塞 Git 操作移出异步运行时，并传递当前工作区环境。

use tauri::{AppHandle, Manager};

use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
use terax_git::operations;
use terax_git::types::{
    DiscardEntry, GitBranchListResult, GitCommitFileChange, GitCommitResult, GitDiffContentResult,
    GitDiffResult, GitDiffSide, GitFileHistoryEntry, GitLogEntry, GitPanelDiffStats,
    GitPanelSnapshot, GitPushResult, GitQuickDiffBaseline, GitRepoInfo, GitStatusSnapshot,
};

async fn blocking<F, T>(app: AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&WorkspaceRegistry) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        f(&registry)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_resolve_repo(
    cwd: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<GitRepoInfo>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::resolve_repo(r, &cwd, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_panel_snapshot(
    cwd: String,
    include_graph: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPanelSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::panel_snapshot(r, &cwd, &workspace, include_graph).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_panel_diff_stats(
    repo_root: String,
    status: GitStatusSnapshot,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPanelDiffStats, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::panel_diff_stats(r, &repo_root, &workspace, &status).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_status(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitStatusSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::status(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

/// 读取指定 Git side 的 unified diff。
#[tauri::command]
pub async fn git_diff(
    repo_root: String,
    path: Option<String>,
    side: GitDiffSide,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff(r, &repo_root, path.as_deref(), side, &workspace).map_err(Into::into)
    })
    .await
}

/// 读取指定工作区文件在当前 HEAD 中的有界文本基线。
#[tauri::command]
pub async fn git_quick_diff_baseline(
    path: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitQuickDiffBaseline, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::quick_diff_baseline(r, &path, &workspace).map_err(Into::into)
    })
    .await
}

/// 读取指定 Git side 的两侧文件内容。
#[tauri::command]
pub async fn git_diff_content(
    repo_root: String,
    path: String,
    side: GitDiffSide,
    original_path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffContentResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff_content(
            r,
            &repo_root,
            &path,
            side,
            original_path.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(
    repo_root: String,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stage(r, &repo_root, &paths, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    repo_root: String,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::unstage(r, &repo_root, &paths, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_discard(
    repo_root: String,
    entries: Vec<DiscardEntry>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::discard(r, &repo_root, &entries, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    repo_root: String,
    message: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitCommitResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit(r, &repo_root, &message, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_undo_commit(
    repo_root: String,
    expected_head: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::undo_commit(r, &repo_root, &expected_head, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(
    repo_root: String,
    operation_id: Option<String>,
    on_progress: Option<tauri::ipc::JavaScriptChannelId>,
    webview: tauri::Webview,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::fetch(
            r,
            &repo_root,
            &workspace,
            operation_id.as_deref(),
            on_progress.map(|id| crate::adapters::tauri::host::output(id.channel_on(webview))),
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_pull_ff_only(
    repo_root: String,
    operation_id: Option<String>,
    on_progress: Option<tauri::ipc::JavaScriptChannelId>,
    webview: tauri::Webview,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::pull_ff_only(
            r,
            &repo_root,
            &workspace,
            operation_id.as_deref(),
            on_progress.map(|id| crate::adapters::tauri::host::output(id.channel_on(webview))),
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    repo_root: String,
    operation_id: Option<String>,
    on_progress: Option<tauri::ipc::JavaScriptChannelId>,
    webview: tauri::Webview,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPushResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::push(
            r,
            &repo_root,
            &workspace,
            operation_id.as_deref(),
            on_progress.map(|id| crate::adapters::tauri::host::output(id.channel_on(webview))),
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    repo_root: String,
    limit: Option<u32>,
    skip: Option<u32>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitLogEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::log(
            r,
            &repo_root,
            limit.unwrap_or(30),
            skip.unwrap_or(0),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_file_history(
    repo_root: String,
    path: String,
    head_sha: String,
    limit: Option<u32>,
    skip: Option<u32>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitFileHistoryEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::file_history(
            r,
            &repo_root,
            &path,
            &head_sha,
            limit.unwrap_or(40),
            skip.unwrap_or(0),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_show_commit(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::show_commit_diff(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_message(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_message(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitCommitFileChange>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_files(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_file_diff(
    repo_root: String,
    sha: String,
    path: String,
    original_path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffContentResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_file_diff(
            r,
            &repo_root,
            &sha,
            &path,
            original_path.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_url(
    repo_root: String,
    name: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_url(r, &repo_root, &remote, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_list_branches(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitBranchListResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::list_branches(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(
    repo_root: String,
    branch: String,
    track_remote: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::checkout_branch(r, &repo_root, &branch, track_remote, &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_tag(
    repo_root: String,
    tag: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::checkout_tag(r, &repo_root, &tag, &workspace).map_err(Into::into)
    })
    .await
}

/// 请求终止指定联网操作；实际结束仍由原调用返回，取消失败允许重试。
#[tauri::command]
pub async fn git_cancel_remote_operation(
    operation_id: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<bool, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |_| {
        terax_git::network::cancel(&workspace, &operation_id).map_err(Into::into)
    })
    .await
}
