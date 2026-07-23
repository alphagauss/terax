//! Direct 传输计划的流式执行与原子提交。
//!
//! 本模块只消费已经扫描并持有最终目标 reservation 的计划。失败时仅清理任务私有
//! staging 路径，已经原子提交的顶层目标不会被回滚删除。

use super::manager::TransferRunError;
use super::planner::{DirectPlan, PreparedTransfer};
use super::progress::ExecutionContext;

type RunResult<T> = Result<T, TransferRunError>;

/// 执行已经完成扫描和目标 reservation 的 Direct 计划。
pub(crate) async fn execute(
    prepared: PreparedTransfer,
    context: &mut ExecutionContext,
) -> RunResult<Vec<String>> {
    let result = match prepared.plan {
        DirectPlan::Local(plan) => super::local::execute(plan, context).await,
        DirectPlan::RemoteUpload(plan) => super::ssh::direct::execute_upload(plan, context).await,
        DirectPlan::RemoteDownload(plan) => {
            super::ssh::direct::execute_download(plan, context).await
        }
    };
    result?;
    Ok(prepared.changed_paths)
}
