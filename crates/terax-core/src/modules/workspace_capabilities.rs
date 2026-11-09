//! Workspace 能力报告的共享类型、时间戳和命令探测协议。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

const MARKER: &[u8] = b"TERAX_CAPABILITIES_V1";

#[cfg(any(windows, test))]
mod wsl;
#[cfg(windows)]
pub use wsl::probe_wsl;

pub(crate) const PASTE_COMMANDS: &[&str] = &[
    "bash",
    "python3_renameat2",
    "cp_archive",
    "mktemp",
    "rm",
    "chmod_recursive",
];
pub(crate) const GIT_COMMANDS: &[&str] =
    &["bash", "git", "stat", "mktemp", "rm", "head", "cat", "wc"];
pub(crate) const ARCHIVE_COMMANDS: &[&str] =
    &["bash", "tar_gzip", "gzip", "sha256", "mktemp", "rm", "wc"];
pub(crate) const SYNC_COMMANDS: &[&str] = &[
    "bash", "find", "stat", "tar_gzip", "tar_sync", "gzip", "sha256", "mktemp", "rm", "wc",
];

/// Workspace 能力探测、功能后端和命令检查共用的状态等级。
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    /// 当前环境尚未完成探测。
    #[default]
    Unknown,
    /// 探测正在后台执行。
    Checking,
    /// 首选后端可用。
    Ready,
    /// 功能可用，但正在使用次级或 SFTP 后端。
    Fallback,
    /// 当前环境没有安全可用的实现。
    Unavailable,
}

/// 实际命令及参数组合的就绪状态。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandCapabilityState {
    Ready,
    Missing,
    Unsupported,
}

/// 一个实际命令及所需参数组合的探测结果。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandCapability {
    pub id: String,
    pub command: String,
    pub state: CommandCapabilityState,
    pub detail: Option<String>,
}

/// 一个用户可感知的 Workspace 功能的后端选择结果。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCapability {
    pub id: String,
    pub state: CapabilityState,
    pub backend: Option<String>,
    pub commands: Vec<String>,
}

/// 无连接 epoch 的 Workspace 能力报告。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub state: CapabilityState,
    pub checked_at: u64,
    pub commands: Vec<CommandCapability>,
    pub features: Vec<FeatureCapability>,
}

pub(crate) fn feature(
    commands: &[CommandCapability],
    id: &str,
    required: &[&str],
    backend: &str,
    fallback: Option<&str>,
) -> FeatureCapability {
    let ready = required.iter().all(|id| {
        commands
            .iter()
            .any(|command| command.id == *id && command.state == CommandCapabilityState::Ready)
    });
    let (state, backend) = if ready {
        (CapabilityState::Ready, Some(backend))
    } else if let Some(fallback) = fallback {
        (CapabilityState::Fallback, Some(fallback))
    } else {
        (CapabilityState::Unavailable, None)
    };
    FeatureCapability {
        id: id.into(),
        state,
        backend: backend.map(str::to_owned),
        commands: required.iter().map(|id| (*id).into()).collect(),
    }
}

pub(crate) fn report_state(features: &[FeatureCapability]) -> CapabilityState {
    if features
        .iter()
        .any(|feature| feature.state == CapabilityState::Unavailable)
    {
        CapabilityState::Unavailable
    } else if features
        .iter()
        .any(|feature| feature.state == CapabilityState::Fallback)
    {
        CapabilityState::Fallback
    } else {
        CapabilityState::Ready
    }
}

pub(crate) fn checked_at() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn parse_command_report(
    bytes: &[u8],
    definitions: &[(&str, &str)],
) -> Result<Vec<CommandCapability>, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(MARKER) {
        return Err("capability probe marker is invalid".into());
    }
    let expected: HashMap<_, _> = definitions.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut commands = Vec::with_capacity(definitions.len());
    loop {
        let id = decode(fields.next(), "command id")?;
        if id == "END" {
            break;
        }
        let command = expected
            .get(id.as_str())
            .ok_or_else(|| "capability probe returned an unknown command".to_string())?;
        if !seen.insert(id.clone()) {
            return Err("capability probe returned a duplicate command".into());
        }
        let state = match decode(fields.next(), "command state")?.as_str() {
            "ready" => CommandCapabilityState::Ready,
            "missing" => CommandCapabilityState::Missing,
            "unsupported" => CommandCapabilityState::Unsupported,
            _ => return Err("capability probe command state is invalid".into()),
        };
        let detail = decode(fields.next(), "command detail")?;
        commands.push(CommandCapability {
            id,
            command: (*command).to_string(),
            state,
            detail: (!detail.is_empty()).then_some(detail),
        });
    }
    if seen.len() != definitions.len() {
        return Err("capability probe omitted a required command".into());
    }
    if fields.any(|field| !field.is_empty()) {
        return Err("capability probe returned trailing fields".into());
    }
    commands.sort_by_key(|command| {
        definitions
            .iter()
            .position(|(id, _)| *id == command.id)
            .unwrap_or(usize::MAX)
    });
    Ok(commands)
}

fn decode(field: Option<&[u8]>, name: &str) -> Result<String, String> {
    std::str::from_utf8(field.unwrap_or_default())
        .map(str::to_string)
        .map_err(|_| format!("capability probe {name} is not UTF-8"))
}
