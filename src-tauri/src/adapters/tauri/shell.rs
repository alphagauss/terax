//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::fs::agent::AgentPermissionMode;
use crate::modules::shell::{self as service, *};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

/// 读取实际执行环境的 Shell 快照。
#[tauri::command]
pub async fn shell_environment(
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<ShellIdentity>, String> {
    service::shell_environment(workspace).await
}

/// 运行非 AI 模块使用的一次性命令，输出有界且超时后终止进程树。
#[tauri::command]
pub async fn shell_run_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<CommandOutput, String> {
    service::shell_run_command(command, cwd, timeout_secs, workspace, registry.inner()).await
}

/// 启动统一 Agent 进程，并等待首轮时限或终态。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn shell_exec(
    state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    owner_session_id: String,
    command: String,
    initial_cwd: String,
    cwd: Option<String>,
    permission_mode: AgentPermissionMode,
    timeout_secs: u64,
    yield_time_ms: u64,
    max_output_bytes: usize,
    shell: ShellKind,
    login: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<ProcessResponse, String> {
    service::shell_exec(
        state.inner(),
        registry.inner(),
        owner_session_id,
        command,
        initial_cwd,
        cwd,
        permission_mode,
        timeout_secs,
        yield_time_ms,
        max_output_bytes,
        shell,
        login,
        workspace,
    )
    .await
}

/// 轮询、写入、关闭 stdin 或终止一个已登记的 Agent 进程。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn shell_process(
    state: tauri::State<'_, ShellState>,
    owner_session_id: String,
    process_id: String,
    action: ProcessAction,
    input: Option<String>,
    close_stdin: bool,
    since_offset: Option<u64>,
    yield_time_ms: Option<u64>,
    wait_for: Option<String>,
    wait_timeout_ms: Option<u64>,
    max_output_bytes: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<ProcessResponse, String> {
    service::shell_process(
        state.inner(),
        owner_session_id,
        process_id,
        action,
        input,
        close_stdin,
        since_offset,
        yield_time_ms,
        wait_for,
        wait_timeout_ms,
        max_output_bytes,
        workspace,
    )
    .await
}

/// 列出当前 Workspace 中运行中或最近结束的 Agent 进程。
#[tauri::command]
pub fn shell_list(
    state: tauri::State<'_, ShellState>,
    owner_session_id: String,
    include_exited: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<ProcessInfo>, String> {
    service::shell_list(state.inner(), owner_session_id, include_exited, workspace)
}

/// 删除聊天时终止并清理该 owner 的全部 Agent 进程。
#[tauri::command]
pub async fn shell_clear_owner(
    state: tauri::State<'_, ShellState>,
    owner_session_id: String,
) -> Result<(), String> {
    service::shell_clear_owner(state.inner(), owner_session_id).await
}
