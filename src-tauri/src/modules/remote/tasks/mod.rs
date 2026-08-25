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
use tokio_util::sync::CancellationToken;

use super::models::SshCapabilitySnapshot;
use super::session::{ExecOutput, RemoteWorkspace};

pub(crate) mod background;
pub(crate) mod capability_probe;
pub(crate) mod create_directory;
pub(crate) mod delete;
pub(crate) mod file_version;
pub(crate) mod file_write;
pub(crate) mod grep;
pub(crate) mod ripgrep;
pub(crate) mod sftp_fallback;
pub(crate) mod tree_list;
pub(crate) mod tree_summary;

/// 高 RTT 连接才维持一个内部任务预开 channel，避免低延迟连接长期占用服务端资源。
pub(crate) const TASK_PREHEAT_RTT_MS: u64 = 100;
pub(crate) const TASK_OUTPUT_LIMIT: usize = 1024;

/// 允许通过封闭任务运行时执行的内部操作。
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(crate) enum TaskKind {
    /// 按版本条件写入文件。
    FileWriteChecked,
    /// 仅在目标缺失时创建文件。
    FileWriteMissing,
    /// 无条件覆盖文件。
    FileWriteOverwrite,
    /// 递归目录属性汇总。
    TreeSummary,
    /// 递归目录与文件枚举。
    TreeList,
    /// ripgrep 内容搜索。
    RipgrepContent,
    /// ripgrep 文件枚举。
    RipgrepFiles,
    /// GNU grep 字面量内容搜索。
    GrepContent,
    /// 稳定文件版本读取。
    FileVersion,
    /// 递归创建目录。
    CreateDirectory,
    /// 批量进程状态。
    BackgroundList,
    /// 递归删除目录。
    RecursiveDelete,
    /// SFTP 写入回退的摘要计算。
    SftpHash,
    /// SFTP 无条件原子替换。
    SftpReplace,
    /// SFTP 缺失目标原子创建。
    SftpCommitMissing,
    /// SFTP 按版本条件提交。
    SftpCommitChecked,
    /// 当前 epoch 的统一命令能力探测。
    CapabilityProbe,
}

impl TaskKind {
    fn name(self) -> &'static str {
        match self {
            Self::FileWriteChecked => "file_write_checked",
            Self::FileWriteMissing => "file_write_missing",
            Self::FileWriteOverwrite => "file_write_overwrite",
            Self::TreeSummary => "tree_summary",
            Self::TreeList => "tree_list",
            Self::RipgrepContent => "ripgrep_content",
            Self::RipgrepFiles => "ripgrep_files",
            Self::GrepContent => "grep_content",
            Self::FileVersion => "file_version",
            Self::CreateDirectory => "create_directory",
            Self::BackgroundList => "background_list",
            Self::RecursiveDelete => "recursive_delete",
            Self::SftpHash => "sftp_hash",
            Self::SftpReplace => "sftp_replace",
            Self::SftpCommitMissing => "sftp_commit_missing",
            Self::SftpCommitChecked => "sftp_commit_checked",
            Self::CapabilityProbe => "capability_probe",
        }
    }
}

/// 内部任务命令失败时是否已经进入可能执行的阶段。
#[derive(Debug)]
pub(super) enum TaskRunError {
    /// 尚未取得 channel，服务器不可能观察到任务命令。
    BeforeDispatch(String),
    /// 已取得 channel 并尝试发送命令，调用方必须按可能已执行处理。
    AfterDispatch(String),
}

impl TaskRunError {
    /// 丢弃执行阶段，仅保留只读任务需要的错误文本。
    pub(super) fn into_message(self) -> String {
        match self {
            Self::BeforeDispatch(message) | Self::AfterDispatch(message) => message,
        }
    }
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
    capability_snapshot: Mutex<SshCapabilitySnapshot>,
    prepared_channel: AsyncMutex<Option<Channel<Msg>>>,
    pub(super) probe_lock: AsyncMutex<()>,
    channel_preparing: AtomicBool,
}

impl RemoteTaskRuntime {
    /// 在统一任务 channel 上执行一次固定命令，并按调用方上限收集输出。
    async fn run_classified(
        self: &Arc<Self>,
        workspace: &Arc<RemoteWorkspace>,
        task: TaskKind,
        command: &str,
        input: Option<Vec<u8>>,
        timeout: Duration,
        max_output: usize,
    ) -> Result<ExecOutput, TaskRunError> {
        let channel = self
            .take_channel(workspace, task)
            .await
            .map_err(TaskRunError::BeforeDispatch)?;
        workspace
            .exec_on_channel_with_input(
                channel,
                command,
                input.unwrap_or_default(),
                timeout,
                max_output,
            )
            .await
            .map_err(TaskRunError::AfterDispatch)
    }

    /// 为具体 task 适配器执行命令；任意命令字符串不会暴露到 tasks 模块之外。
    async fn run(
        self: &Arc<Self>,
        workspace: &Arc<RemoteWorkspace>,
        task: TaskKind,
        command: &str,
        input: Option<Vec<u8>>,
        timeout: Duration,
        max_output: usize,
    ) -> Result<ExecOutput, String> {
        self.run_classified(workspace, task, command, input, timeout, max_output)
            .await
            .map_err(TaskRunError::into_message)
    }

    /// 执行可取消的只读任务；取消会关闭当前 SSH channel。
    async fn run_cancellable(
        self: &Arc<Self>,
        workspace: &Arc<RemoteWorkspace>,
        task: TaskKind,
        command: &str,
        timeout: Duration,
        max_output: usize,
        cancellation: &CancellationToken,
    ) -> Result<ExecOutput, String> {
        let channel = self.take_channel(workspace, task).await?;
        workspace
            .exec_task_on_channel_cancellable(
                channel,
                command,
                Vec::new(),
                timeout,
                max_output,
                cancellation,
            )
            .await
    }

    /// 返回当前任务是否仍可尝试 Bash 主路径。
    pub(crate) fn should_attempt(&self, task: TaskKind) -> bool {
        !matches!(self.capability(task), Capability::Unavailable(_))
    }

    /// 仅在当前 epoch 尚未成功执行过任务时探测远端依赖参数能力。
    pub(crate) fn should_probe(&self, task: TaskKind) -> bool {
        matches!(self.capability(task), Capability::Unknown)
    }

    /// 标记任务在当前连接可用。
    pub(crate) fn mark_available(&self, task: TaskKind) {
        let mut capabilities = self
            .capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !matches!(capabilities.get(&task), Some(Capability::Unavailable(_))) {
            capabilities.insert(task, Capability::Available);
        }
    }

    /// 由一次完整统一探测替换任务状态，允许用户安装依赖后在同一 epoch 重新启用。
    pub(super) fn replace_capability(
        &self,
        task: TaskKind,
        available: bool,
        reason: impl Into<String>,
    ) {
        self.capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                task,
                if available {
                    Capability::Available
                } else {
                    Capability::Unavailable(reason.into())
                },
            );
    }

    /// 保存不含连接 epoch 的最新能力明细。
    pub(super) fn set_capability_snapshot(&self, snapshot: SshCapabilitySnapshot) {
        *self
            .capability_snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot;
    }

    /// 返回绑定调用方 epoch 的统一能力快照。
    pub(crate) fn capability_snapshot(&self, epoch: u64) -> SshCapabilitySnapshot {
        let mut snapshot = self
            .capability_snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        snapshot.epoch = (epoch != 0).then_some(epoch);
        snapshot
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

    /// 返回当前 epoch 已知的任务降级及缺失原因。
    pub(crate) fn unavailable_tasks(&self) -> Vec<(String, String)> {
        let capabilities = self
            .capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut tasks: Vec<_> = capabilities
            .iter()
            .filter_map(|(task, capability)| match capability {
                Capability::Unavailable(reason) => Some((task.name().to_string(), reason.clone())),
                Capability::Unknown | Capability::Available => None,
            })
            .collect();
        tasks.sort_by(|left, right| left.0.cmp(&right.0));
        tasks
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
    async fn take_channel(
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
        assert!(runtime.should_attempt(TaskKind::FileWriteChecked));
        assert!(runtime.should_attempt(TaskKind::TreeSummary));

        assert!(runtime.mark_unavailable(TaskKind::FileWriteChecked, "missing sha256sum"));
        assert!(!runtime.should_attempt(TaskKind::FileWriteChecked));
        assert!(runtime.should_attempt(TaskKind::TreeSummary));
        assert!(!runtime.mark_unavailable(TaskKind::FileWriteChecked, "still unavailable"));
        assert_eq!(
            runtime.unavailable_tasks(),
            vec![("file_write_checked".into(), "still unavailable".into())]
        );

        runtime.mark_available(TaskKind::FileWriteChecked);
        assert!(!runtime.should_attempt(TaskKind::FileWriteChecked));
        assert_eq!(
            runtime.unavailable_tasks(),
            vec![("file_write_checked".into(), "still unavailable".into())]
        );
    }

    #[test]
    fn sftp_write_capabilities_do_not_cross_disable() {
        let runtime = RemoteTaskRuntime::default();
        runtime.mark_unavailable(TaskKind::SftpHash, "missing hash provider");

        assert!(!runtime.should_attempt(TaskKind::SftpHash));
        assert!(runtime.should_attempt(TaskKind::SftpReplace));
        assert!(runtime.should_attempt(TaskKind::SftpCommitMissing));
        assert!(runtime.should_attempt(TaskKind::SftpCommitChecked));
    }
}
