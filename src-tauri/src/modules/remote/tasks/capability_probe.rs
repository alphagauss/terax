//! SSH 服务器统一能力探测、协议解析与功能后端映射。
//!
//! 每个连接 epoch 只在前台资源就绪后执行一次固定脚本；探测失败保留 lazy probe，
//! 完整报告才允许替换任务 capability。用户手动重检可以在同一 epoch 重新启用依赖。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::modules::remote::models::{
    SshCapabilitySnapshot, SshCapabilityState, SshCommandCapability, SshCommandCapabilityState,
    SshFeatureCapability,
};
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

use super::{TaskKind, TASK_OUTPUT_LIMIT};

const SOURCE: &str = include_str!("scripts/capability_probe.sh");
const MARKER: &[u8] = b"TERAX_CAPABILITIES_V1";
const TIMEOUT: Duration = Duration::from_secs(20);
const COMMANDS: &[(&str, &str)] = &[
    ("bash", "bash"),
    ("setsid", "setsid --wait"),
    ("find", "find -printf"),
    ("readlink", "readlink -f"),
    ("stat", "stat -c"),
    ("awk", "awk"),
    ("rm", "rm -rf --"),
    ("mktemp", "mktemp -d"),
    ("mkdir", "mkdir -p --"),
    ("chmod", "chmod --"),
    ("dd", "dd conv=fsync"),
    ("mv", "mv -T"),
    ("ln", "ln -T"),
    ("sha256", "SHA-256"),
    ("rg_content", "rg --json"),
    ("rg_files", "rg --files"),
    ("grep", "grep -F"),
];

/// 执行或复用当前 epoch 的统一能力探测。
pub(crate) async fn probe(
    workspace: &Arc<RemoteWorkspace>,
    force: bool,
) -> Result<SshCapabilitySnapshot, String> {
    let _guard = workspace.tasks.probe_lock.lock().await;
    let current = workspace.capability_snapshot();
    if !force && current.state != SshCapabilityState::Unknown {
        return Ok(current);
    }

    workspace
        .tasks
        .set_capability_snapshot(SshCapabilitySnapshot {
            state: SshCapabilityState::Checking,
            ..SshCapabilitySnapshot::default()
        });
    workspace.emit_capability_snapshot();

    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 72; exec bash -c {}",
        shell_quote(SOURCE)
    );
    let output = match workspace
        .tasks
        .run(
            workspace,
            TaskKind::CapabilityProbe,
            &command,
            None,
            TIMEOUT,
            TASK_OUTPUT_LIMIT * 64,
        )
        .await
    {
        Ok(output) => output,
        Err(error) => {
            reset_probe(workspace);
            return Err(error);
        }
    };
    if output.timed_out || output.truncated || output.exit_code != Some(0) {
        reset_probe(workspace);
        return Err(if output.timed_out {
            "remote capability probe timed out".into()
        } else {
            "remote capability probe failed".into()
        });
    }

    let commands = match parse(&output.stdout) {
        Ok(commands) => commands,
        Err(error) => {
            reset_probe(workspace);
            return Err(error);
        }
    };
    let snapshot = build_snapshot(commands);
    apply_task_capabilities(workspace, &snapshot);
    workspace.tasks.mark_available(TaskKind::CapabilityProbe);
    workspace.tasks.set_capability_snapshot(snapshot);
    workspace.emit_capability_snapshot();
    Ok(workspace.capability_snapshot())
}

fn reset_probe(workspace: &RemoteWorkspace) {
    workspace
        .tasks
        .set_capability_snapshot(SshCapabilitySnapshot::default());
    workspace.emit_capability_snapshot();
}

fn checked_at() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse(bytes: &[u8]) -> Result<Vec<SshCommandCapability>, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    if fields.next() != Some(MARKER) {
        return Err("capability probe marker is invalid".into());
    }
    let expected: HashMap<_, _> = COMMANDS.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut commands = Vec::with_capacity(COMMANDS.len());
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
            "ready" => SshCommandCapabilityState::Ready,
            "missing" => SshCommandCapabilityState::Missing,
            "unsupported" => SshCommandCapabilityState::Unsupported,
            _ => return Err("capability probe command state is invalid".into()),
        };
        let detail = decode(fields.next(), "command detail")?;
        commands.push(SshCommandCapability {
            id,
            command: (*command).to_string(),
            state,
            detail: (!detail.is_empty()).then_some(detail),
        });
    }
    if seen.len() != COMMANDS.len() {
        return Err("capability probe omitted a required command".into());
    }
    if fields.any(|field| !field.is_empty()) {
        return Err("capability probe returned trailing fields".into());
    }
    commands.sort_by_key(|command| {
        COMMANDS
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

fn build_snapshot(commands: Vec<SshCommandCapability>) -> SshCapabilitySnapshot {
    let ready = |id: &str| {
        commands
            .iter()
            .any(|command| command.id == id && command.state == SshCommandCapabilityState::Ready)
    };
    let all = |ids: &[&str]| ids.iter().all(|id| ready(id));
    let mut features = Vec::new();
    let mut push =
        |id: &str, state: SshCapabilityState, backend: Option<&str>, command_ids: &[&str]| {
            features.push(SshFeatureCapability {
                id: id.into(),
                state,
                backend: backend.map(str::to_string),
                commands: command_ids.iter().map(|id| (*id).to_string()).collect(),
            });
        };

    let file_version = ["readlink", "stat", "sha256"];
    let file_version_state = if all(&file_version) {
        SshCapabilityState::Ready
    } else if ready("sha256") {
        SshCapabilityState::Fallback
    } else {
        SshCapabilityState::Unavailable
    };
    push(
        "file_version",
        file_version_state,
        match file_version_state {
            SshCapabilityState::Ready => Some("bash"),
            SshCapabilityState::Fallback => Some("sftp"),
            SshCapabilityState::Unavailable
            | SshCapabilityState::Unknown
            | SshCapabilityState::Checking => None,
        },
        &file_version,
    );
    let tree = ["find", "readlink"];
    push(
        "tree_listing",
        if all(&tree) {
            SshCapabilityState::Ready
        } else {
            SshCapabilityState::Fallback
        },
        Some(if all(&tree) { "find" } else { "sftp" }),
        &tree,
    );
    let summary = ["find", "awk"];
    push(
        "directory_summary",
        if all(&summary) {
            SshCapabilityState::Ready
        } else {
            SshCapabilityState::Fallback
        },
        Some(if all(&summary) { "find+awk" } else { "sftp" }),
        &summary,
    );
    let file_write = [
        "mktemp", "stat", "readlink", "dd", "chmod", "rm", "mv", "sha256", "ln",
    ];
    push(
        "file_write",
        if all(&file_write) {
            SshCapabilityState::Ready
        } else {
            SshCapabilityState::Fallback
        },
        Some(if all(&file_write) { "bash" } else { "sftp" }),
        &file_write,
    );
    let create = ["mkdir", "readlink", "mktemp", "rm"];
    push(
        "create_directory",
        if all(&create) {
            SshCapabilityState::Ready
        } else {
            SshCapabilityState::Fallback
        },
        Some(if all(&create) { "bash" } else { "sftp" }),
        &create,
    );
    push(
        "agent_processes",
        if ready("setsid") {
            SshCapabilityState::Ready
        } else {
            SshCapabilityState::Unavailable
        },
        ready("setsid").then_some("ssh-channel"),
        &["bash", "setsid"],
    );
    push(
        "recursive_delete",
        if ready("rm") {
            SshCapabilityState::Ready
        } else {
            SshCapabilityState::Unavailable
        },
        ready("rm").then_some("bash"),
        &["rm"],
    );
    let (search_state, search_backend, search_commands) = if ready("rg_content") {
        (SshCapabilityState::Ready, "rg", vec!["rg_content"])
    } else if ready("grep") && ready("find") && ready("readlink") {
        (
            SshCapabilityState::Fallback,
            "grep",
            vec!["rg_content", "grep", "find", "readlink"],
        )
    } else {
        (
            SshCapabilityState::Fallback,
            "sftp",
            vec!["rg_content", "grep", "find", "readlink"],
        )
    };
    push(
        "content_search",
        search_state,
        Some(search_backend),
        &search_commands,
    );
    let (files_state, files_backend) = if ready("rg_files") {
        (SshCapabilityState::Ready, "rg")
    } else if all(&tree) {
        (SshCapabilityState::Fallback, "find")
    } else {
        (SshCapabilityState::Fallback, "sftp")
    };
    push(
        "file_listing",
        files_state,
        Some(files_backend),
        &["rg_files", "find", "readlink"],
    );

    let state = if features
        .iter()
        .any(|feature| feature.state == SshCapabilityState::Unavailable)
    {
        SshCapabilityState::Unavailable
    } else if features
        .iter()
        .any(|feature| feature.state == SshCapabilityState::Fallback)
    {
        SshCapabilityState::Fallback
    } else {
        SshCapabilityState::Ready
    };
    SshCapabilitySnapshot {
        epoch: None,
        state,
        checked_at: Some(checked_at()),
        commands,
        features,
    }
}

fn apply_task_capabilities(workspace: &RemoteWorkspace, snapshot: &SshCapabilitySnapshot) {
    let ready = |id: &str| {
        snapshot
            .commands
            .iter()
            .any(|command| command.id == id && command.state == SshCommandCapabilityState::Ready)
    };
    let all = |ids: &[&str]| ids.iter().all(|id| ready(id));
    let set = |task, available, reason| workspace.tasks.replace_capability(task, available, reason);
    set(
        TaskKind::FileVersion,
        all(&["readlink", "stat", "sha256"]),
        "missing file-version dependencies",
    );
    set(
        TaskKind::TreeList,
        all(&["find", "readlink"]),
        "missing GNU find or readlink",
    );
    set(
        TaskKind::TreeSummary,
        all(&["find", "awk"]),
        "missing GNU find or awk",
    );
    set(
        TaskKind::CreateDirectory,
        all(&["mkdir", "readlink", "mktemp", "rm"]),
        "missing directory-creation dependencies",
    );
    set(TaskKind::RecursiveDelete, ready("rm"), "missing rm");
    set(
        TaskKind::RipgrepContent,
        ready("rg_content"),
        "ripgrep content-search options are unavailable",
    );
    set(
        TaskKind::RipgrepFiles,
        ready("rg_files"),
        "ripgrep file-list options are unavailable",
    );
    set(
        TaskKind::GrepContent,
        ready("grep") && ready("find") && ready("readlink"),
        "GNU grep literal-search options are unavailable",
    );
    let write = all(&[
        "mktemp", "stat", "readlink", "dd", "chmod", "rm", "mv", "sha256",
    ]);
    set(
        TaskKind::FileWriteChecked,
        write,
        "missing checked-write dependencies",
    );
    set(
        TaskKind::FileWriteOverwrite,
        write,
        "missing overwrite dependencies",
    );
    set(
        TaskKind::FileWriteMissing,
        write && ready("ln"),
        "missing create-only write dependencies",
    );
}

/// 将业务执行阶段确认的永久任务降级覆盖到统一功能快照。
pub(crate) fn overlay_runtime_fallbacks(
    snapshot: &mut SshCapabilitySnapshot,
    unavailable_tasks: &[(String, String)],
) {
    if snapshot.features.is_empty() {
        return;
    }
    let unavailable: HashSet<&str> = unavailable_tasks
        .iter()
        .map(|(task, _)| task.as_str())
        .collect();
    let fallback = |snapshot: &mut SshCapabilitySnapshot, id: &str, backend: &str| {
        if let Some(feature) = snapshot
            .features
            .iter_mut()
            .find(|feature| feature.id == id)
        {
            if feature.state != SshCapabilityState::Unavailable {
                feature.state = SshCapabilityState::Fallback;
                feature.backend = Some(backend.into());
            }
        }
    };
    if unavailable.iter().any(|task| {
        matches!(
            *task,
            "file_write_checked" | "file_write_missing" | "file_write_overwrite"
        )
    }) {
        fallback(snapshot, "file_write", "sftp");
    }
    for (task, feature) in [
        ("file_version", "file_version"),
        ("tree_list", "tree_listing"),
        ("tree_summary", "directory_summary"),
        ("create_directory", "create_directory"),
    ] {
        if unavailable.contains(task) {
            fallback(snapshot, feature, "sftp");
        }
    }
    if unavailable.contains("ripgrep_content") {
        let grep_ready = ["grep", "find", "readlink"].iter().all(|id| {
            snapshot.commands.iter().any(|command| {
                command.id == *id && command.state == SshCommandCapabilityState::Ready
            })
        }) && !unavailable.contains("grep_content");
        fallback(
            snapshot,
            "content_search",
            if grep_ready { "grep" } else { "sftp" },
        );
    }
    if unavailable.contains("grep_content") && unavailable.contains("ripgrep_content") {
        fallback(snapshot, "content_search", "sftp");
    }
    if unavailable.contains("ripgrep_files") {
        let find_ready = snapshot.commands.iter().any(|command| {
            command.id == "find" && command.state == SshCommandCapabilityState::Ready
        });
        fallback(
            snapshot,
            "file_listing",
            if find_ready { "find" } else { "sftp" },
        );
    }
    if unavailable.contains("recursive_delete") {
        if let Some(feature) = snapshot
            .features
            .iter_mut()
            .find(|feature| feature.id == "recursive_delete")
        {
            feature.state = SshCapabilityState::Unavailable;
            feature.backend = None;
        }
    }
    snapshot.state = if snapshot
        .features
        .iter()
        .any(|feature| feature.state == SshCapabilityState::Unavailable)
    {
        SshCapabilityState::Unavailable
    } else if snapshot
        .features
        .iter()
        .any(|feature| feature.state == SshCapabilityState::Fallback)
    {
        SshCapabilityState::Fallback
    } else {
        SshCapabilityState::Ready
    };
}

#[cfg(test)]
mod tests {
    use super::{build_snapshot, overlay_runtime_fallbacks, parse, COMMANDS};
    use crate::modules::remote::models::{
        SshCapabilityState, SshCommandCapability, SshCommandCapabilityState,
    };

    #[test]
    fn parses_complete_capability_protocol() {
        let mut bytes = b"TERAX_CAPABILITIES_V1\0".to_vec();
        for (id, _) in COMMANDS {
            bytes.extend_from_slice(id.as_bytes());
            bytes.extend_from_slice(b"\0ready\0\0");
        }
        bytes.extend_from_slice(b"END\0");
        let commands = parse(&bytes).unwrap();
        assert_eq!(commands.len(), COMMANDS.len());
        assert!(commands
            .iter()
            .all(|command| command.state == SshCommandCapabilityState::Ready));
    }

    #[test]
    fn missing_rg_selects_grep_compatibility_backend() {
        let commands = COMMANDS
            .iter()
            .map(|(id, command)| SshCommandCapability {
                id: (*id).into(),
                command: (*command).into(),
                state: if id.starts_with("rg_") {
                    SshCommandCapabilityState::Missing
                } else {
                    SshCommandCapabilityState::Ready
                },
                detail: None,
            })
            .collect();
        let snapshot = build_snapshot(commands);
        let search = snapshot
            .features
            .iter()
            .find(|feature| feature.id == "content_search")
            .unwrap();
        assert_eq!(search.state, SshCapabilityState::Fallback);
        assert_eq!(search.backend.as_deref(), Some("grep"));
        assert_eq!(snapshot.state, SshCapabilityState::Fallback);
    }

    #[test]
    fn runtime_task_failure_updates_the_user_facing_feature() {
        let commands = COMMANDS
            .iter()
            .map(|(id, command)| SshCommandCapability {
                id: (*id).into(),
                command: (*command).into(),
                state: SshCommandCapabilityState::Ready,
                detail: None,
            })
            .collect();
        let mut snapshot = build_snapshot(commands);
        overlay_runtime_fallbacks(
            &mut snapshot,
            &[("file_write_checked".into(), "protocol mismatch".into())],
        );

        let file_write = snapshot
            .features
            .iter()
            .find(|feature| feature.id == "file_write")
            .unwrap();
        assert_eq!(file_write.state, SshCapabilityState::Fallback);
        assert_eq!(file_write.backend.as_deref(), Some("sftp"));
        assert_eq!(snapshot.state, SshCapabilityState::Fallback);
    }
}
