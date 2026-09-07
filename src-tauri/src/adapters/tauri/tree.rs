//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::fs::tree::{self as service, *};
use crate::modules::workspace::WorkspaceEnv;

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn fs_read_dir(
    path: String,
    show_hidden: bool,
    git_decorations: Option<bool>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<DirEntry>, String> {
    service::fs_read_dir(path, show_hidden, git_decorations, workspace).await
}

/// 将桌面参数交给共享服务。
#[tauri::command]
pub async fn list_subdirs(
    path: String,
    show_hidden: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<String>, String> {
    service::list_subdirs(path, show_hidden, workspace).await
}
