//! SSH 内部封闭任务的连接级运行时。
//!
//! 本模块集中管理任务 capability 与高 RTT 预开 channel。具体脚本、协议解析、业务
//! 回退和结果收敛仍由所属 service 负责，运行时不会接受来自前端的任意命令。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::Msg;
use russh::Channel;
use tokio::sync::Mutex as AsyncMutex;

use super::session::{ExecOutput, RemoteWorkspace};

/// 高 RTT 连接才维持一个内部任务预开 channel，避免低延迟连接长期占用服务端资源。
pub(crate) const TASK_PREHEAT_RTT_MS: u64 = 100;

/// 允许通过封闭任务运行时执行的内部操作。
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(crate) enum TaskKind {
    /// 条件文件写入。
    FileWrite,
    /// 递归目录属性汇总。
    TreeSummary,
    /// ripgrep 内容搜索与文件枚举。
    Ripgrep,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum Capability {
    #[default]
    Unknown,
    Available,
    Unavailable(String),
}

/// 当前 SSH epoch 的封闭任务 capability 与共享预热资源。
#[derive(Default)]
pub(crate) struct RemoteTaskRuntime {
    capabilities: Mutex<HashMap<TaskKind, Capability>>,
    prepared_channel: AsyncMutex<Option<Channel<Msg>>>,
    channel_preparing: AtomicBool,
}

impl RemoteTaskRuntime {
    /// 在统一任务 channel 上执行一次固定命令，并按调用方上限收集输出。
    pub(crate) async fn run(
        self: &Arc<Self>,
        workspace: &Arc<RemoteWorkspace>,
        task: TaskKind,
        command: &str,
        input: Option<Vec<u8>>,
        timeout: Duration,
        max_output: usize,
    ) -> Result<ExecOutput, String> {
        let channel = self.take_channel(workspace, task).await?;
        workspace
            .exec_on_channel_with_input(
                channel,
                command,
                input.unwrap_or_default(),
                timeout,
                max_output,
            )
            .await
    }

    /// 返回当前任务是否仍可尝试 Bash 主路径。
    pub(crate) fn should_attempt(&self, task: TaskKind) -> bool {
        !matches!(self.capability(task), Capability::Unavailable(_))
    }

    /// 标记任务在当前连接可用。
    pub(crate) fn mark_available(&self, task: TaskKind) {
        self.capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(task, Capability::Available);
    }

    /// 标记任务在当前连接不可用，并返回状态是否首次发生变化。
    pub(crate) fn mark_unavailable(&self, task: TaskKind, reason: impl Into<String>) -> bool {
        let mut capabilities = self
            .capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let changed = !matches!(capabilities.get(&task), Some(Capability::Unavailable(_)));
        capabilities.insert(task, Capability::Unavailable(reason.into()));
        changed
    }

    /// 返回任务是否已经永久降级到传统后端。
    pub(crate) fn is_unavailable(&self, task: TaskKind) -> bool {
        matches!(self.capability(task), Capability::Unavailable(_))
    }

    fn capability(&self, task: TaskKind) -> Capability {
        self.capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&task)
            .cloned()
            .unwrap_or_default()
    }

    /// 取得一个内部任务 channel，并在高 RTT 时异步补充单槽预热资源。
    pub(crate) async fn take_channel(
        self: &Arc<Self>,
        workspace: &Arc<RemoteWorkspace>,
        task: TaskKind,
    ) -> Result<Channel<Msg>, String> {
        if !self.should_attempt(task) {
            return Err("remote Bash task is unavailable".into());
        }
        let prepared = self.prepared_channel.lock().await.take();
        if !self.should_attempt(task) {
            if let Some(channel) = prepared {
                let _ = channel.close().await;
            }
            return Err("remote Bash task is unavailable".into());
        }
        if let Some(channel) = prepared {
            self.prepare_channel(workspace);
            return Ok(channel);
        }
        let channel = workspace.open_exec_channel().await?;
        if !self.should_attempt(task) {
            let _ = channel.close().await;
            return Err("remote Bash task is unavailable".into());
        }
        self.prepare_channel(workspace);
        Ok(channel)
    }

    /// 根据已有 RTT 样本后台维持一个内部任务预开 channel。
    pub(crate) fn prepare_channel(self: &Arc<Self>, workspace: &Arc<RemoteWorkspace>) {
        let runtime = self.clone();
        let workspace = workspace.clone();
        tauri::async_runtime::spawn(async move {
            if !workspace.task_preheat_eligible() {
                let channel = runtime.prepared_channel.lock().await.take();
                if let Some(channel) = channel {
                    let _ = channel.close().await;
                }
                return;
            }
            if runtime.prepared_channel.lock().await.is_some() {
                return;
            }
            if runtime.channel_preparing.swap(true, Ordering::AcqRel) {
                return;
            }
            let opened = workspace.open_exec_channel().await;
            runtime.channel_preparing.store(false, Ordering::Release);
            if let Ok(channel) = opened {
                if workspace.task_preheat_eligible() {
                    let close = {
                        let mut slot = runtime.prepared_channel.lock().await;
                        if slot.is_none() {
                            *slot = Some(channel);
                            None
                        } else {
                            Some(channel)
                        }
                    };
                    if let Some(channel) = close {
                        let _ = channel.close().await;
                    }
                } else {
                    let _ = channel.close().await;
                }
            }
        });
    }

    /// 关闭当前连接拥有的预热 channel。
    pub(crate) async fn close(&self) {
        if let Some(channel) = self.prepared_channel.lock().await.take() {
            let _ = channel.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RemoteTaskRuntime, TaskKind};

    #[test]
    fn task_capabilities_are_isolated() {
        let runtime = RemoteTaskRuntime::default();
        assert!(runtime.should_attempt(TaskKind::FileWrite));
        assert!(runtime.should_attempt(TaskKind::TreeSummary));

        assert!(runtime.mark_unavailable(TaskKind::FileWrite, "missing sha256sum"));
        assert!(!runtime.should_attempt(TaskKind::FileWrite));
        assert!(runtime.should_attempt(TaskKind::TreeSummary));
        assert!(!runtime.mark_unavailable(TaskKind::FileWrite, "still unavailable"));

        runtime.mark_available(TaskKind::FileWrite);
        assert!(runtime.should_attempt(TaskKind::FileWrite));
    }
}
