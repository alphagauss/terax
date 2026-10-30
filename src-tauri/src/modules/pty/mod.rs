//! PTY 桌面适配，状态和进程清理由原生核心持有。

use crate::adapters::tauri::host;
use crate::modules::remote::RemoteState;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
pub use terax_core::modules::pty::PtyState;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    remote: tauri::State<'_, RemoteState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    on_data: tauri::ipc::Channel<tauri::ipc::Response>,
    on_exit: tauri::ipc::Channel<i32>,
) -> Result<u32, String> {
    terax_core::modules::pty::pty_open(
        host::events(&app),
        &state,
        &remote,
        &registry,
        cols,
        rows,
        cwd,
        workspace,
        blocks,
        shell,
        host::bytes(on_data),
        host::output(on_exit),
    )
    .await
}

#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-pty-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pty_write: expected raw body".to_string());
    };
    terax_core::modules::pty::pty_write(&state, id, bytes).await
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terax_core::modules::pty::pty_resize(&state, id, cols, rows)
}

#[tauri::command]
pub fn pty_close(
    state: tauri::State<PtyState>,
    id: u32,
    reclaimed: Option<bool>,
) -> Result<(), String> {
    terax_core::modules::pty::pty_close(&state, id, reclaimed)
}

#[tauri::command]
pub async fn pty_has_running_tasks(
    state: tauri::State<'_, PtyState>,
    id: u32,
    shell_pid: Option<u32>,
    background_pids: Option<Vec<u32>>,
) -> Result<Option<bool>, String> {
    terax_core::modules::pty::pty_has_running_tasks(&state, id, shell_pid, background_pids).await
}

#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    terax_core::modules::pty::pty_has_foreground_job(&state, id)
}

#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    terax_core::modules::pty::pty_close_all(&state)
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    terax_core::modules::pty::pty_shell_name()
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<terax_core::modules::shell::init::ShellInfo> {
    terax_core::modules::pty::pty_list_shells()
}
