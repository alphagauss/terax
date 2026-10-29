//! 桌面宿主命令映射。
//!
//! 只转换 Tauri 上下文与输出通道，业务规则由共享服务负责。

use crate::modules::fs::file::{self as service, *};
use crate::modules::workspace::WorkspaceEnv;
use serde::Serialize;
use tauri::Emitter;

/// 统一检查 Local、WSL 与 SSH 文件，只返回与上一检查点不同的字节区间。
#[tauri::command]
pub async fn fs_sync_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    checkpoint: Option<crate::modules::fs::sync::FileCheckpoint>,
    force: bool,
    verify: bool,
) -> Result<crate::modules::fs::sync::FileSyncResult, String> {
    crate::modules::fs::sync::sync_file(path, workspace, checkpoint, force, verify).await
}

/// 读取文件并为文本内容返回基于原始字节的稳定版本。
#[tauri::command]
pub async fn fs_read_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
) -> Result<ReadResult, String> {
    service::fs_read_file(path, workspace, force).await
}

/// 将桌面上下文交给共享服务。
#[tauri::command]
pub async fn fs_read_binary(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<BinaryReadResult, String> {
    service::fs_read_binary(path, workspace).await
}

/// 在数据源端计算当前文件版本，不传输文件正文。
#[tauri::command]
pub async fn fs_file_version(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Option<FileVersion>, String> {
    service::fs_file_version(path, workspace).await
}

/// 无条件原子写入文件，供创建文件、主题和已审批的工具操作使用。
#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    service::fs_write_file(path, content, workspace, source, &app).await
}

/// 按内容版本或缺失条件写入编辑器与 AI 工具文件。
///
/// 普通保存必须显式匹配最近读取或成功写入的版本；新文件和覆盖也必须显式声明。
#[tauri::command]
pub async fn fs_write_file_checked(
    path: String,
    content: String,
    condition: WriteCondition,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<CheckedWriteResult, String> {
    service::fs_write_file_checked(path, content, condition, workspace, source, &app).await
}

/// 将桌面上下文交给共享服务。
#[tauri::command]
pub async fn fs_canonicalize(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    service::fs_canonicalize(path, workspace).await
}

/// 将桌面上下文交给共享服务。
#[tauri::command]
pub async fn fs_stat(
    path: String,
    workspace: Option<WorkspaceEnv>,
    missing_ok: Option<bool>,
) -> Result<Option<FileStat>, String> {
    service::fs_stat(path, workspace, missing_ok.unwrap_or(false)).await
}

impl FileEvents for tauri::AppHandle {
    fn file_written(&self, path: &str, source: Option<String>) {
        let _ = self.emit(
            "fs:file-written",
            FileWrittenEvent {
                path: path.to_string(),
                source,
            },
        );
    }
}

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}
