//! 异常退出后的任务临时路径清理票据。
//!
//! 票据只保存精确路径和环境身份。Recovery 状态不允许自动删除；只有提交
//! 成功后持久化的 Disposable 状态才会在下次加载时执行一次受限清理。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 持久化清理票据的可删除性。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CleanupTicketState {
    Recovery,
    Disposable,
}

/// 本地或远程 backup 的精确清理授权。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CleanupTicketTarget {
    Local {
        staging_task_id: String,
        owner_task_id: String,
        paths: Vec<String>,
    },
    Ssh {
        profile_id: String,
        endpoint_host: String,
        endpoint_port: u16,
        endpoint_username: String,
        staging_task_id: String,
        owner_task_id: String,
        staging_parents: Vec<String>,
        paths: Vec<String>,
    },
}

/// 一条可独立完成或取消的清理票据。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct CleanupTicket {
    pub(crate) id: String,
    pub(crate) state: CleanupTicketState,
    pub(crate) target: CleanupTicketTarget,
}

impl CleanupTicket {
    /// 创建默认为不可自动删除的 recovery 票据。
    pub(crate) fn recovery(target: CleanupTicketTarget) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            state: CleanupTicketState::Recovery,
            target,
        }
    }

    /// 在提交成功后允许后续进程自动删除票据中的路径。
    pub(crate) fn mark_disposable(&mut self) {
        self.state = CleanupTicketState::Disposable;
    }

    /// 返回应在清理完成前禁止删除历史的聚合任务 ID。
    pub(crate) fn owner_task_id(&self) -> &str {
        match &self.target {
            CleanupTicketTarget::Local { owner_task_id, .. }
            | CleanupTicketTarget::Ssh { owner_task_id, .. } => owner_task_id,
        }
    }
}
