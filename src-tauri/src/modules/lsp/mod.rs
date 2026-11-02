//! 将桌面 LSP 命令和二进制通道映射到进程级服务器宿主。

use crate::adapters::tauri::host;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::{Channel, Response};
pub use terax_lsp::LspState;

#[tauri::command]
pub fn lsp_host_pid() -> u32 {
    std::process::id()
}

#[tauri::command]
pub async fn lsp_detect(command: String) -> Option<String> {
    terax_lsp::detect(command).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_spawn(
    state: tauri::State<'_, Arc<LspState>>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    root: String,
    max_rss_mb: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    on_message: Channel<Response>,
    on_exit: Channel<terax_lsp::LspExit>,
) -> Result<u32, String> {
    state
        .spawn(
            &registry,
            terax_lsp::LspLaunch {
                command,
                args,
                env: env.unwrap_or_default(),
                root,
                max_rss_mb,
                workspace: WorkspaceEnv::from_option(workspace),
            },
            host::bytes(on_message),
            host::output(on_exit),
        )
        .await
}

#[tauri::command]
pub async fn lsp_resolve_root(path: String, markers: Vec<String>) -> Option<String> {
    terax_lsp::project_root(path, markers).await
}

#[tauri::command]
pub async fn lsp_send(
    state: tauri::State<'_, Arc<LspState>>,
    id: u32,
    message: String,
) -> Result<(), String> {
    state.send(id, message).await
}

#[tauri::command]
pub fn lsp_kill(state: tauri::State<'_, Arc<LspState>>, id: u32) {
    state.kill(id);
}
