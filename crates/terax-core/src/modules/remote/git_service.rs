//! Git 的封闭批次协议与 SSH 入口，WSL 复用相同的脚本和长度帧。
//! 只接受固定业务请求，不接收任意命令；结果解析由 Git 模块负责。

use super::manager::global_manager;
use super::session::validate_remote_path;
use super::tasks::git_batch;

/// 封闭 Git 请求；只读采集与显式联网操作使用独立分支，业务解析仍由 Git 模块负责。
pub enum GitBatchKind {
    Snapshot { include_graph: bool },
    Statistics { untracked: Vec<String> },
    History { limit: u32, skip: u32 },
    RemoteAction { action: GitRemoteAction },
}

/// 联网操作只执行一次，不在传输失败后自动重放。
#[derive(Clone, Copy)]
pub enum GitRemoteAction {
    Fetch,
    Pull,
    Push,
}

impl GitBatchKind {
    /// 联网操作保留原有较长预算，只读批次共享一个较短预算。
    pub fn timeout_secs(&self) -> u64 {
        if matches!(self, Self::RemoteAction { .. }) {
            120
        } else {
            30
        }
    }
}

/// 每页历史只读取提交头，文件统计在打开详情时读取。
pub const HISTORY_FORMAT: &str = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s";

/// 生成固定批次脚本，供 WSL 和 SSH 使用同一份执行协议。
pub fn batch_script(path: &str, kind: GitBatchKind) -> Result<String, String> {
    git_batch::script(path, kind)
}

/// 解码固定批次，保留各命令的原始字节和退出状态。
pub fn parse_batch(bytes: &[u8]) -> Result<Vec<GitBatchOutput>, String> {
    git_batch::parse(bytes)
}

/// 保留各命令的独立结果，避免一个可选查询失败掩盖基础状态。
pub struct GitBatchOutput {
    pub name: String,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

/// 一次 channel 完成固定 Git 批次，超时和输出上限覆盖整个阶段。
pub async fn execute(
    profile_id: &str,
    path: &str,
    kind: GitBatchKind,
) -> Result<Vec<GitBatchOutput>, String> {
    validate_remote_path(path)?;
    if !path.starts_with('/') {
        return Err("Git batch requires an absolute remote directory".into());
    }
    let workspace = global_manager()?.workspace(profile_id).await?;
    git_batch::execute(&workspace, path, kind).await
}
