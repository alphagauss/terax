//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::ai_sessions::{self as service, *};
use crate::modules::workspace::WorkspaceRegistry;
use tauri::State;

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn ai_sessions_list() -> Result<Vec<SessionMetadata>, String> {
    service::ai_sessions_list()
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn ai_session_read(id: String) -> Result<SessionFile, String> {
    service::ai_session_read(id)
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn ai_sessions_search(
    query: String,
    session_ids: Vec<String>,
) -> Result<Vec<SessionContentMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || service::ai_sessions_search(query, session_ids))
        .await
        .map_err(|error| error.to_string())?
}

/// 将新增记录提交到 AI 会话并返回最新摘要。
///
/// 新会话 cwd 来自已授权的 Explorer 根目录；历史会话仍由不可变校验防止换根。
#[tauri::command]
pub fn ai_session_commit(
    state: State<'_, AiSessionsState>,
    workspace_state: State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
    session: SessionFile,
) -> Result<SessionMetadata, String> {
    service::commit(
        state.inner(),
        &workspace_state.bootstrap().environment_key,
        session,
    )
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn ai_session_delete(
    state: tauri::State<'_, AiSessionsState>,
    id: String,
) -> Result<(), String> {
    service::ai_session_delete(state.inner(), id)
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub fn ai_agent_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AiSessionsState>,
    agent_id: String,
) -> Result<Vec<String>, String> {
    service::ai_agent_delete(&app, state.inner(), agent_id)
}

/// 尝试为一次 AI 运行取得跨进程锁，重复取得同一锁视为成功。
#[tauri::command]
pub fn ai_session_run_acquire(
    state: State<'_, AiSessionsState>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_state: State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
    id: String,
) -> Result<bool, String> {
    let bootstrap = workspace_state.bootstrap();
    service::acquire(
        state.inner(),
        registry.inner(),
        &id,
        &bootstrap.environment_key,
        &bootstrap.env,
    )
}

/// 释放当前进程持有的 AI 会话运行锁。
#[tauri::command]
pub fn ai_session_run_release(state: State<'_, AiSessionsState>, id: String) -> Result<(), String> {
    service::release(state.inner(), &id)
}

/// 编辑或复制已保存的会话前缀。
#[tauri::command]
pub fn ai_session_revise_history(
    state: State<'_, AiSessionsState>,
    workspace_state: State<'_, crate::modules::workspace_process::WorkspaceProcessState>,
    id: String,
    fingerprint: String,
    action: HistoryAction,
    now: String,
) -> Result<HistoryRevision, String> {
    service::revise_history(
        state.inner(),
        &workspace_state.bootstrap().environment_key,
        id,
        fingerprint,
        action,
        now,
    )
}
