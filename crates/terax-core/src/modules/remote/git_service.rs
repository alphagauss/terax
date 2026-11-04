//! Git 面板的封闭 SSH 采集入口，只接受固定读取类型，不接收任意命令。

use super::manager::global_manager;
use super::session::validate_remote_path;
use super::tasks::git_read;

/// 同一远端阶段需要读取的数据，业务解析仍由 Git 模块负责。
pub enum GitReadKind {
    Snapshot { include_graph: bool },
    Statistics { untracked: Vec<String> },
}

/// 保留各命令的独立结果，避免一个可选查询失败掩盖基础状态。
pub struct GitReadOutput {
    pub name: String,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

/// 一次 channel 完成固定 Git 读取批次，超时和输出上限覆盖整个阶段。
pub async fn read(
    profile_id: &str,
    path: &str,
    kind: GitReadKind,
) -> Result<Vec<GitReadOutput>, String> {
    validate_remote_path(path)?;
    if !path.starts_with('/') {
        return Err("Git read requires an absolute remote directory".into());
    }
    let workspace = global_manager()?.workspace(profile_id).await?;
    git_read::read(&workspace, path, kind).await
}
