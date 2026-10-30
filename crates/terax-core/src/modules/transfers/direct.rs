//! Direct 传输计划的流式执行与可回滚提交。
//!
//! 本模块只消费已经扫描并持有最终目标 reservation 的计划。失败时仅清理任务私有
//! staging 路径；一个顶层目标提交完成后，后续根的失败不会回滚它。

use super::manager::TransferRunError;
use super::planner::{PreparedTransfer, TransferManifest};
use super::progress::ExecutionContext;

type RunResult<T> = Result<T, TransferRunError>;

/// 执行已经完成扫描和目标 reservation 的 Direct 计划。
pub(crate) async fn execute(
    prepared: PreparedTransfer,
    context: &mut ExecutionContext,
) -> RunResult<()> {
    match prepared.manifest {
        TransferManifest::Local(plan) => super::local::execute(plan, context).await,
        TransferManifest::RemoteUpload(plan) => {
            super::ssh::direct::execute_upload(plan, context).await
        }
        TransferManifest::RemoteDownload(plan) => {
            super::ssh::direct::execute_download(plan, context).await
        }
    }
}
