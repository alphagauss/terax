//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::fs::agent::{self as service, *};
use crate::modules::workspace::WorkspaceRegistry;
use tauri::{AppHandle, State};

/// 读取当前工作区内的普通 UTF-8 文件，并记录聊天级文件版本。
#[tauri::command]
pub async fn agent_file_read(
    state: State<'_, AgentFileState>,
    registry: State<'_, WorkspaceRegistry>,
    request: AgentReadRequest,
) -> Result<AgentReadResponse, String> {
    service::agent_file_read(state.inner(), registry.inner(), request).await
}

/// 统一执行直接目录列举和递归 glob 路径发现。
#[tauri::command]
pub async fn agent_file_find(
    state: State<'_, AgentFileState>,
    registry: State<'_, WorkspaceRegistry>,
    request: AgentFindRequest,
) -> Result<AgentFindResponse, String> {
    service::agent_file_find(state.inner(), registry.inner(), request).await
}

/// 使用共享搜索引擎执行 Agent 正文搜索，并在安全过滤后分页和聚合。
#[tauri::command]
pub async fn agent_file_grep(
    state: State<'_, AgentFileState>,
    registry: State<'_, WorkspaceRegistry>,
    request: AgentGrepRequest,
) -> Result<AgentGrepResponse, String> {
    service::agent_file_grep(state.inner(), registry.inner(), request).await
}

/// 准备全文写入或多文件精确补丁，并缓存审批所见内容。
#[tauri::command]
pub async fn agent_file_prepare_mutation(
    state: State<'_, AgentFileState>,
    registry: State<'_, WorkspaceRegistry>,
    request: AgentPrepareMutationRequest,
) -> Result<AgentMutationPreview, String> {
    service::agent_file_prepare_mutation(state.inner(), registry.inner(), request).await
}

/// 提交已准备的修改；任何基线冲突都会在写入前拒绝。
#[tauri::command]
pub async fn agent_file_commit_mutation(
    state: State<'_, AgentFileState>,
    registry: State<'_, WorkspaceRegistry>,
    app: AppHandle,
    request: AgentMutationKeyRequest,
) -> Result<AgentMutationResult, String> {
    service::agent_file_commit_mutation(state.inner(), registry.inner(), &app, request).await
}

/// 丢弃单个预备快照。
#[tauri::command]
pub async fn agent_file_clear_mutation(
    state: State<'_, AgentFileState>,
    request: AgentMutationKeyRequest,
) -> Result<(), String> {
    service::agent_file_clear_mutation(state.inner(), request).await
}

/// 清理聊天拥有的读取版本和预备快照。
#[tauri::command]
pub async fn agent_file_clear_owner(
    state: State<'_, AgentFileState>,
    owner_session_id: String,
) -> Result<(), String> {
    service::agent_file_clear_owner(state.inner(), owner_session_id).await
}

/// 执行经过审批的结构化路径操作。
#[tauri::command]
pub async fn agent_file_operation(
    state: State<'_, AgentFileState>,
    registry: State<'_, WorkspaceRegistry>,
    app: AppHandle,
    request: AgentFileOperationRequest,
) -> Result<AgentFileOperationResponse, String> {
    service::agent_file_operation(state.inner(), registry.inner(), &app, request).await
}
