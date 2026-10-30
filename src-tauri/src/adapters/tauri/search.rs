//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::fs::grep::{self as service, *};
use crate::modules::workspace::WorkspaceEnv;

/// 执行 UI 与 AI 共用的工作区内容搜索。
///
/// `cancelPrevious` 只供唯一的搜索面板使用；AI 并发查询不会推进 generation，
/// 因而不会互相取消或被用户输入取消。
#[tauri::command]
pub async fn fs_content_search(
    state: tauri::State<'_, ContentSearchState>,
    request: ContentSearchRequest,
) -> Result<ContentSearchResponse, String> {
    service::fs_content_search(state.inner(), request).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_glob(
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GlobResponse, String> {
    service::fs_glob(pattern, root, max_results, workspace).await
}

/// 将桌面搜索请求交给核心的可取消搜索服务。
#[tauri::command]
pub async fn fs_search(
    state: tauri::State<'_, crate::modules::fs::search::PathSearchState>,
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<crate::modules::fs::search::SearchResult, String> {
    crate::modules::fs::search::fs_search(&state, root, query, limit, workspace, show_hidden).await
}
