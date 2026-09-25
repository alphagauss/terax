//! External Agent CLI 的封闭启动、目标环境探测和输出事件桥接。
//!
//! 本模块只接受内置 Agent 标识，命令由 Rust 构造；进程生命周期复用 ShellState，
//! 因而 Local、WSL 与 SSH 共享 Workspace 授权、owner 隔离和完整进程树终止。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::modules::shell::{self, ProcessStatus, ShellState};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_SESSION_ID_BYTES: usize = 512;
const EVENT_OUTPUT_BYTES: usize = 64 * 1024;
const STDERR_TAIL_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalAgentId {
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalAgentPermissionMode {
    Ask,
    FullAccess,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentAvailability {
    pub agent_id: ExternalAgentId,
    pub installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExternalAgentProcessEvent {
    Output {
        stdout: String,
    },
    Done {
        status: ProcessStatus,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        stderr: String,
    },
}

/// 在当前 Workspace 后端批量探测支持的 CLI，不访问宿主机的其他环境。
#[tauri::command]
pub async fn external_agent_list(
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<ExternalAgentAvailability>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let command = probe_command(&workspace);
    let output = tauri::async_runtime::spawn_blocking({
        let workspace = workspace.clone();
        move || shell::run_blocking_inner(command, None, workspace, Duration::from_secs(10))
    })
    .await
    .map_err(|error| error.to_string())??;
    let installed: std::collections::HashSet<_> = output.stdout.lines().collect();
    Ok([ExternalAgentId::Claude, ExternalAgentId::Codex]
        .into_iter()
        .map(|agent_id| ExternalAgentAvailability {
            installed: installed.contains(agent_name(agent_id)),
            agent_id,
        })
        .collect())
}

/// 启动一次非交互 External Agent turn，并通过 Channel 推送结构化 stdout 与终态。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn external_agent_run(
    shell_state: tauri::State<'_, ShellState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    owner_session_id: String,
    agent_id: ExternalAgentId,
    prompt: String,
    external_session_id: Option<String>,
    cwd: String,
    permission_mode: ExternalAgentPermissionMode,
    workspace: Option<WorkspaceEnv>,
    on_event: Channel<ExternalAgentProcessEvent>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("External Agent prompt is empty".into());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("External Agent prompt exceeds the size limit".into());
    }
    let session_id = external_session_id
        .as_deref()
        .map(validate_session_id)
        .transpose()?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let command = launch_command(agent_id, permission_mode, session_id, &workspace);
    let process = shell_state
        .spawn_external_agent(registry.inner(), owner_session_id, command, cwd, workspace)
        .await?;
    let process_id = process.id.clone();

    if let Err(error) = process.write(prompt).await {
        let _ = process.terminate_as(ProcessStatus::Terminated).await;
        return Err(error);
    }
    if let Err(error) = process.close_stdin().await {
        let _ = process.terminate_as(ProcessStatus::Terminated).await;
        return Err(error);
    }

    tauri::async_runtime::spawn(async move {
        let mut offset = 0;
        let mut stderr_tail = String::new();
        loop {
            let waited = process.clone();
            let response = match tauri::async_runtime::spawn_blocking(move || {
                waited.wait_for_change(offset, Duration::from_secs(30), EVENT_OUTPUT_BYTES)
            })
            .await
            {
                Ok(response) => response,
                Err(error) => {
                    append_tail(&mut stderr_tail, &error.to_string(), STDERR_TAIL_BYTES);
                    let _ = process.terminate_as(ProcessStatus::Terminated).await;
                    break;
                }
            };
            offset = response.next_offset;
            append_tail(&mut stderr_tail, &response.stderr, STDERR_TAIL_BYTES);
            if !response.stdout.is_empty()
                && on_event
                    .send(ExternalAgentProcessEvent::Output {
                        stdout: response.stdout,
                    })
                    .is_err()
            {
                let _ = process.terminate_as(ProcessStatus::Terminated).await;
                return;
            }
            if response.status != ProcessStatus::Running {
                let _ = on_event.send(ExternalAgentProcessEvent::Done {
                    status: response.status,
                    exit_code: response.exit_code,
                    stderr: stderr_tail,
                });
                return;
            }
        }
        let response = process.response(offset, EVENT_OUTPUT_BYTES);
        let _ = on_event.send(ExternalAgentProcessEvent::Done {
            status: response.status,
            exit_code: response.exit_code,
            stderr: stderr_tail,
        });
    });

    Ok(process_id)
}

/// 终止当前聊天在同一 Workspace 中启动的指定 External Agent 进程。
#[tauri::command]
pub async fn external_agent_cancel(
    shell_state: tauri::State<'_, ShellState>,
    owner_session_id: String,
    process_id: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    shell_state
        .owned_external_agent(&process_id, &owner_session_id, &workspace)?
        .terminate_as(ProcessStatus::Terminated)
        .await
}

fn agent_name(agent: ExternalAgentId) -> &'static str {
    match agent {
        ExternalAgentId::Claude => "claude",
        ExternalAgentId::Codex => "codex",
    }
}

fn probe_command(_workspace: &WorkspaceEnv) -> String {
    #[cfg(windows)]
    if matches!(_workspace, WorkspaceEnv::Local) {
        return "if (Get-Command claude -ErrorAction SilentlyContinue) { 'claude' }; if (Get-Command codex -ErrorAction SilentlyContinue) { 'codex' }".into();
    }
    let script = "command -v claude >/dev/null 2>&1 && printf 'claude\\n'; command -v codex >/dev/null 2>&1 && printf 'codex\\n'";
    format!(
        "/bin/bash -lc {}",
        crate::modules::remote::session::shell_quote(script)
    )
}

fn launch_command(
    agent: ExternalAgentId,
    permission: ExternalAgentPermissionMode,
    session_id: Option<&str>,
    workspace: &WorkspaceEnv,
) -> String {
    let mut args: Vec<&str> = match agent {
        ExternalAgentId::Claude => vec!["-p", "--output-format", "stream-json", "--verbose"],
        // Terax Workspace 可以不是 Git 仓库；cwd 已经过授权，写入范围仍由 sandbox 参数约束。
        ExternalAgentId::Codex => vec!["exec", "--json", "--skip-git-repo-check"],
    };
    match (agent, permission) {
        (ExternalAgentId::Claude, ExternalAgentPermissionMode::Ask) => {
            args.extend(["--permission-mode", "plan"]);
        }
        (ExternalAgentId::Claude, ExternalAgentPermissionMode::FullAccess) => {
            args.extend(["--permission-mode", "acceptEdits"]);
        }
        (ExternalAgentId::Codex, ExternalAgentPermissionMode::Ask) => {
            args.extend(["--sandbox", "read-only"]);
        }
        (ExternalAgentId::Codex, ExternalAgentPermissionMode::FullAccess) => {
            args.extend(["--sandbox", "workspace-write"]);
        }
    }
    if let Some(id) = session_id {
        match agent {
            ExternalAgentId::Claude => args.extend(["--resume", id]),
            ExternalAgentId::Codex => args.extend(["resume", id]),
        }
    }
    if agent == ExternalAgentId::Codex {
        args.push("-");
    }
    command_with_args(agent_name(agent), &args, workspace)
}

fn command_with_args(program: &str, args: &[&str], _workspace: &WorkspaceEnv) -> String {
    #[cfg(windows)]
    if matches!(_workspace, WorkspaceEnv::Local) {
        let mut command = format!("& {}", powershell_quote(program));
        for arg in args {
            command.push(' ');
            command.push_str(&powershell_quote(arg));
        }
        return command;
    }
    std::iter::once(program)
        .chain(args.iter().copied())
        .map(crate::modules::remote::session::shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn validate_session_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > MAX_SESSION_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("External Agent session id is invalid".into());
    }
    Ok(value)
}

fn append_tail(target: &mut String, value: &str, limit: usize) {
    target.push_str(value);
    if target.len() <= limit {
        return;
    }
    let mut cut = target.len() - limit;
    while !target.is_char_boundary(cut) {
        cut += 1;
    }
    target.drain(..cut);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_command_keeps_prompt_out_and_quotes_resume_id() {
        let command = launch_command(
            ExternalAgentId::Codex,
            ExternalAgentPermissionMode::FullAccess,
            Some("0199a213-81c0-7800-8aa1-bbab2a035a53"),
            &WorkspaceEnv::Ssh {
                profile_id: "server".into(),
            },
        );
        assert!(command.contains("workspace-write"));
        assert!(command.contains("resume"));
        assert!(command.ends_with(" '-'"));
    }

    #[test]
    fn rejects_session_ids_that_could_change_the_command() {
        assert!(validate_session_id("abc-123").is_ok());
        assert!(validate_session_id("abc; rm -rf x").is_err());
        assert!(validate_session_id("").is_err());
    }

    #[test]
    fn permission_modes_never_enable_unbounded_bypass() {
        let workspace = WorkspaceEnv::Ssh {
            profile_id: "server".into(),
        };
        let claude = launch_command(
            ExternalAgentId::Claude,
            ExternalAgentPermissionMode::FullAccess,
            None,
            &workspace,
        );
        let codex = launch_command(
            ExternalAgentId::Codex,
            ExternalAgentPermissionMode::Ask,
            None,
            &workspace,
        );
        assert!(claude.contains("acceptEdits"));
        assert!(!claude.contains("bypassPermissions"));
        assert!(codex.contains("read-only"));
        assert!(!codex.contains("danger-full-access"));
    }

    #[test]
    fn process_done_event_uses_the_frontend_field_name() {
        let value = serde_json::to_value(ExternalAgentProcessEvent::Done {
            status: ProcessStatus::Exited,
            exit_code: Some(0),
            stderr: String::new(),
        })
        .unwrap();
        assert_eq!(value["exitCode"], 0);
        assert!(value.get("exit_code").is_none());
    }
}
