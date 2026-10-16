//! 无界面宿主的私有标准输入输出协议。
//!
//! 只接受封闭原生操作，环境固定为启动所在的 Local 系统。请求和并发均有上限，
//! 输入关闭后取消 HTTP、终止受管进程并释放会话锁；不监听网络端口。

use crate::modules::{
    ai_sessions, fs, net, network_proxy, secrets, shared_store, shell, workspace,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

const MAX_REQUEST_BYTES: u64 = 8 * 1024 * 1024;
const OWNER: &str = "terminal";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

struct Host {
    cwd: String,
    files: fs::agent::AgentFileState,
    shell: shell::ShellState,
    sessions: ai_sessions::AiSessionsState,
    registry: workspace::WorkspaceRegistry,
    http: net::HttpState,
    secrets: secrets::SecretsState,
}

type Output = Arc<Mutex<std::io::Stdout>>;

/// 串行写入完整协议帧，防止并发请求交错正文；不输出凭据或请求日志。
fn send(output: &Output, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let mut writer = output.lock().map_err(|_| "host output is poisoned")?;
    writer
        .write_all(&bytes)
        .and_then(|()| writer.flush())
        .map_err(|error| error.to_string())
}

/// 从封闭命令参数中取得有类型的值；缺失的可选参数按 null 解析。
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|_| format!("invalid host parameter: {key}"))
}

fn value<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    serde_json::to_value(result?).map_err(|error| error.to_string())
}

/// 拒绝将客户端声明的远端环境误当作宿主本地路径执行。
fn validate_environment(args: &Value) -> Result<(), String> {
    for candidate in [
        args.get("workspace"),
        args.get("request")
            .and_then(|request| request.get("workspace")),
    ]
    .into_iter()
    .flatten()
    {
        if !candidate.is_null()
            && serde_json::from_value::<workspace::WorkspaceEnv>(candidate.clone())
                .map_err(|_| "invalid workspace")?
                != workspace::WorkspaceEnv::Local
        {
            return Err("terminal host only accepts its local execution environment".into());
        }
    }
    Ok(())
}

impl Host {
    /// 路由固定服务集合，所有工具继续经过共享文件策略和受管进程表。
    async fn dispatch(&self, request: &Request, output: &Output) -> Result<Value, String> {
        let a = &request.args;
        validate_environment(a)?;
        let env = Some(workspace::WorkspaceEnv::Local);
        match request.command.as_str() {
            "host_bootstrap" => Ok(
                json!({"cwd": self.cwd, "platform": std::env::consts::OS, "environmentKey": "local", "protocol": 1}),
            ),
            "shell_environment" => value(shell::shell_environment(env).await),
            "workspace_current_dir" => Ok(json!(self.cwd)),
            "workspace_authorize" => {
                value(workspace::workspace_authorize(arg(a, "path")?, env, &self.registry).await)
            }
            "fs_file_version" => value(fs::file::fs_file_version(arg(a, "path")?, env).await),
            "fs_read_file" => {
                value(fs::file::fs_read_file(arg(a, "path")?, env, arg(a, "force")?).await)
            }
            "fs_canonicalize" => value(fs::file::fs_canonicalize(arg(a, "path")?, env).await),
            "agent_file_read" => value(
                fs::agent::agent_file_read(&self.files, &self.registry, arg(a, "request")?).await,
            ),
            "agent_file_find" => value(
                fs::agent::agent_file_find(&self.files, &self.registry, arg(a, "request")?).await,
            ),
            "agent_file_grep" => value(
                fs::agent::agent_file_grep(&self.files, &self.registry, arg(a, "request")?).await,
            ),
            "agent_file_prepare_mutation" => value(
                fs::agent::agent_file_prepare_mutation(
                    &self.files,
                    &self.registry,
                    arg(a, "request")?,
                )
                .await,
            ),
            "agent_file_commit_mutation" => value(
                fs::agent::agent_file_commit_mutation(
                    &self.files,
                    &self.registry,
                    &(),
                    arg(a, "request")?,
                )
                .await,
            ),
            "agent_file_clear_mutation" => {
                value(fs::agent::agent_file_clear_mutation(&self.files, arg(a, "request")?).await)
            }
            "agent_file_clear_owner" => value(
                fs::agent::agent_file_clear_owner(&self.files, arg(a, "ownerSessionId")?).await,
            ),
            "agent_file_operation" => value(
                fs::agent::agent_file_operation(
                    &self.files,
                    &self.registry,
                    &(),
                    arg(a, "request")?,
                )
                .await,
            ),
            "shell_exec" => value(
                shell::shell_exec(
                    &self.shell,
                    &self.registry,
                    arg(a, "ownerSessionId")?,
                    arg(a, "executionId")?,
                    arg(a, "command")?,
                    arg(a, "initialCwd")?,
                    arg(a, "cwd")?,
                    arg(a, "permissionMode")?,
                    arg(a, "timeoutSecs")?,
                    arg(a, "yieldTimeMs")?,
                    arg(a, "maxOutputBytes")?,
                    arg(a, "shell")?,
                    arg(a, "login")?,
                    env,
                )
                .await,
            ),
            "shell_process" => value(
                shell::shell_process(
                    &self.shell,
                    arg(a, "ownerSessionId")?,
                    arg(a, "processId")?,
                    arg(a, "action")?,
                    arg(a, "input")?,
                    arg(a, "closeStdin")?,
                    arg(a, "sinceOffset")?,
                    arg(a, "yieldTimeMs")?,
                    arg(a, "waitFor")?,
                    arg(a, "waitTimeoutMs")?,
                    arg(a, "maxOutputBytes")?,
                    env,
                )
                .await,
            ),
            "shell_list" => value(shell::shell_list(
                &self.shell,
                arg(a, "ownerSessionId")?,
                arg(a, "includeExited")?,
                env,
            )),
            "shell_open_execution" => value(shell::shell_open_execution(
                &self.shell,
                arg(a, "ownerSessionId")?,
                arg(a, "executionId")?,
                arg(a, "taskId")?,
            )),
            "shell_close_execution" => value(
                shell::shell_close_execution(
                    &self.shell,
                    arg(a, "ownerSessionId")?,
                    arg(a, "executionId")?,
                )
                .await,
            ),
            "shell_stop_execution" => value(
                shell::shell_stop_execution(
                    &self.shell,
                    arg(a, "ownerSessionId")?,
                    arg(a, "executionId")?,
                )
                .await,
            ),
            "shell_stop_task" => value(
                shell::shell_stop_task(&self.shell, arg(a, "ownerSessionId")?, arg(a, "taskId")?)
                    .await,
            ),
            "shell_stop_active" => {
                value(shell::shell_stop_active(&self.shell, arg(a, "ownerSessionId")?).await)
            }
            "shell_clear_owner" => {
                value(shell::shell_clear_owner(&self.shell, arg(a, "ownerSessionId")?).await)
            }
            "ai_sessions_list" => value(ai_sessions::ai_sessions_list()),
            "ai_session_read" => value(ai_sessions::ai_session_read(arg(a, "id")?)),
            "ai_sessions_search" => value(ai_sessions::ai_sessions_search(
                arg(a, "query")?,
                arg(a, "sessionIds")?,
            )),
            "ai_session_commit" => value(ai_sessions::commit(
                &self.sessions,
                "local",
                arg(a, "session")?,
            )),
            "ai_session_run_acquire" => value(ai_sessions::acquire(
                &self.sessions,
                &self.registry,
                &arg::<String>(a, "id")?,
                "local",
                &workspace::WorkspaceEnv::Local,
            )),
            "ai_session_run_release" => value(ai_sessions::release(
                &self.sessions,
                &arg::<String>(a, "id")?,
            )),
            "shared_store_read" => value(shared_store::shared_store_read(arg(a, "store")?)),
            "secrets_get" => value(secrets::get_value(
                &self.secrets,
                &arg::<String>(a, "service")?,
                &arg::<String>(a, "account")?,
            )),
            "secrets_get_all" => {
                let service: String = arg(a, "service")?;
                let accounts: Vec<String> = arg(a, "accounts")?;
                if accounts.len() > 256 {
                    return Err("too many credential accounts".into());
                }
                value(secrets::secrets_get_all(&self.secrets, service, accounts).await)
            }
            "http_cancel" => {
                self.http.cancel(OWNER, &arg::<String>(a, "requestId")?);
                Ok(Value::Null)
            }
            "http_request" => {
                let id = request.id;
                value(
                    net::http_request(
                        &self.secrets,
                        OWNER,
                        &self.http,
                        arg(a, "requestId")?,
                        arg(a, "url")?,
                        arg(a, "method")?,
                        arg(a, "redirect")?,
                        arg(a, "headers")?,
                        arg(a, "body")?,
                        arg(a, "allowPrivateNetwork")?,
                        arg::<network_proxy::NetworkTarget>(a, "networkTarget")?,
                        arg(a, "timeoutMs")?,
                        arg(a, "maxResponseBytes")?,
                        |event| send(output, json!({"id": id, "event": event})),
                    )
                    .await,
                )
            }
            _ => Err("unsupported native host operation".into()),
        }
    }
}

/// 启动私有管道宿主；EOF 表示调用者退出，不遗留任务或会话锁。
pub async fn run(cwd: String) -> Result<(), String> {
    if !std::path::Path::new(&cwd).is_absolute() || !std::path::Path::new(&cwd).is_dir() {
        return Err("native host working directory must be an existing absolute directory".into());
    }
    let registry = workspace::WorkspaceRegistry::default();
    let cwd = fs::to_canon(
        registry
            .authorize(&cwd)
            .map_err(|error| error.to_string())?,
    );
    workspace::init_launch_cwd(Some(&cwd));
    let host = Arc::new(Host {
        cwd,
        registry,
        files: Default::default(),
        shell: Default::default(),
        sessions: Default::default(),
        http: Default::default(),
        secrets: Default::default(),
    });
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let (sender, mut receiver) = tokio::sync::mpsc::channel(32);
    // 独立读取线程避免 Tokio 的阻塞 stdin 任务在终止信号后阻止运行时退出。
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = Vec::new();
            let result =
                std::io::Read::take(&mut input, MAX_REQUEST_BYTES + 1).read_until(b'\n', &mut line);
            if !matches!(result, Ok(size) if size > 0 && size as u64 <= MAX_REQUEST_BYTES) {
                break;
            }
            if sender.blocking_send(line).is_err() {
                break;
            }
        }
    });
    let permits = Arc::new(tokio::sync::Semaphore::new(32));
    let mut tasks = tokio::task::JoinSet::new();
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let line = tokio::select! {
            line = receiver.recv() => match line { Some(line) => line, None => break },
            _ = &mut shutdown => break,
        };
        let request: Request = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(_) => break,
        };
        let permit = if request.command == "http_cancel" {
            None
        } else {
            match permits.clone().try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    send(
                        &output,
                        json!({"id": request.id, "error": "native host is busy"}),
                    )?;
                    continue;
                }
            }
        };
        let host = host.clone();
        let output = output.clone();
        tasks.spawn(async move {
            let _permit = permit;
            let result = host.dispatch(&request, &output).await;
            let response = match result {
                Ok(result) => json!({"id": request.id, "result": result}),
                Err(error) => json!({"id": request.id, "error": error}),
            };
            let _ = send(&output, response);
        });
        while tasks.try_join_next().is_some() {}
    }
    host.http.cancel_owner(OWNER);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    match tokio::time::timeout(std::time::Duration::from_secs(5), host.shell.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("cannot clean up Agent processes: {error}"),
        Err(_) => log::warn!("Agent process cleanup timed out during exit"),
    }
    drop(host);
    Ok(())
}

/// 进程组中断或系统终止也经过资源清理，避免 Unix 子进程组脱离宿主继续执行。
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = signal.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_requests_cannot_fall_through_to_local_files() {
        assert!(validate_environment(
            &json!({"request": {"workspace": {"kind": "ssh", "profileId": "server"}}})
        )
        .is_err());
        assert!(validate_environment(&json!({"workspace": {"kind": "local"}})).is_ok());
    }
}
