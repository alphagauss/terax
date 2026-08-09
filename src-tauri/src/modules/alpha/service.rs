//! Alpha 本机单例服务控制。
//!
//! 每次状态查询都以固定本机端口上的受认证健康检查为准。应用启动、手动操作和开发
//! 源码变化统一通过 revision 协调，并由跨进程文件锁保证多个 Terax 窗口只替换一次。

use super::runtime_files;
use crate::modules::proc;
use crate::modules::shared_store;
use crate::modules::storage::{write_atomic, FileLock};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const ALPHA_HOST: &str = "127.0.0.1";
const ALPHA_PORT: u16 = 11123;
const SETTINGS_STORE: &str = "alpha";
const PYTHON_PATH_KEY: &str = "pythonPath";
const AUTO_START_KEY: &str = "autoStart";
const SERVICE_PROTOCOL_VERSION: u32 = 2;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
const LOCK_TIMEOUT: Duration = Duration::from_secs(40);

struct AlphaConfig {
    python_path: Option<String>,
    auto_start: bool,
}

/// 面向前端的共享 Alpha 服务状态快照。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaStatus {
    pub running: bool,
    pub configured: bool,
    pub python_path: Option<String>,
    pub auto_start: bool,
    pub port: u16,
    pub issue: Option<AlphaStatusIssue>,
}

/// 前端可本地化展示的 Alpha 服务状态异常。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AlphaStatusIssue {
    PortConflict,
}

/// Python 解释器版本及运行依赖检查结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonCheck {
    pub path: String,
    pub version: Option<String>,
    pub missing_packages: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeCheck {
    version: String,
    minimum_version: String,
    supported: bool,
    missing_packages: Vec<String>,
    import_errors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ServiceHealth {
    status: String,
    #[serde(alias = "services_ready")]
    ready: bool,
    service: String,
    protocol_version: u32,
    #[serde(default, alias = "archive_hash")]
    runtime_revision: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PresencePlan {
    InspectRunning,
    Spawn,
    LeaveStopped,
    PortConflict,
}

/// 读取所有窗口共享的 Alpha 配置。
fn read_config() -> Result<AlphaConfig, String> {
    let values = shared_store::shared_store_read(SETTINGS_STORE.to_string())?;
    let python_path = values
        .get(PYTHON_PATH_KEY)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let auto_start = values
        .get(AUTO_START_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(AlphaConfig {
        python_path,
        auto_start,
    })
}

/// 保存用户选择的 Python 可执行文件。
///
/// 保存阶段只校验路径是明确存在的绝对文件，版本和依赖由用户主动检查。
pub fn set_python_path(app: AppHandle, path: String) -> Result<(), String> {
    let validated = validate_python_path(&path)?;
    shared_store::shared_store_set(
        app,
        SETTINGS_STORE.to_string(),
        PYTHON_PATH_KEY.to_string(),
        Value::String(validated.to_string_lossy().into_owned()),
    )
}

/// 保存所有窗口共享的 Alpha 自动启动开关。
pub fn set_auto_start(app: AppHandle, enabled: bool) -> Result<(), String> {
    shared_store::shared_store_set(
        app,
        SETTINGS_STORE.to_string(),
        AUTO_START_KEY.to_string(),
        Value::Bool(enabled),
    )
}

/// 检查当前或显式指定的 Python 解释器及 Alpha 运行依赖。
pub async fn check_configured_python(path: Option<String>) -> Result<PythonCheck, String> {
    let path = match path {
        Some(path) => validate_python_path(&path)?,
        None => {
            let configured = read_config()?
                .python_path
                .ok_or_else(|| "尚未配置 Alpha Python 解释器".to_string())?;
            validate_python_path(&configured)?
        }
    };
    let code_root = tokio::task::spawn_blocking(runtime_files::code_root)
        .await
        .map_err(|error| error.to_string())??;
    Ok(check_python(&path, &code_root).await)
}

/// 查询共享 Alpha 服务的当前真实状态。
pub async fn status() -> Result<AlphaStatus, String> {
    let config = read_config()?;
    let token = read_token().ok();
    let service = match token.as_deref() {
        Some(token) => probe_owned_service(token).await,
        None => None,
    };
    let port_open = if service.is_none() {
        port_is_open().await
    } else {
        true
    };
    let issue = if service.is_none() && port_open {
        Some(AlphaStatusIssue::PortConflict)
    } else {
        None
    };
    Ok(AlphaStatus {
        running: service.as_ref().is_some_and(is_usable_service),
        configured: config.python_path.is_some(),
        python_path: config.python_path,
        auto_start: config.auto_start,
        port: ALPHA_PORT,
        issue,
    })
}

/// 幂等启动共享 Alpha 服务。
pub async fn start() -> Result<AlphaStatus, String> {
    let _lock = acquire_operation_lock().await?;
    reconcile_locked(true).await?;
    status().await
}

/// 幂等停止共享 Alpha 服务。
pub async fn stop() -> Result<AlphaStatus, String> {
    let _lock = acquire_operation_lock().await?;
    stop_locked().await?;
    status().await
}

/// 在同一把操作锁内停止并重新启动共享 Alpha 服务。
pub async fn restart() -> Result<AlphaStatus, String> {
    let _lock = acquire_operation_lock().await?;
    stop_locked().await?;
    reconcile_locked(true).await?;
    status().await
}

/// 在应用 Ready 后延迟协调共享服务，已运行的旧 revision 不受自动启动开关限制。
pub fn schedule_delayed_reconcile() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let Ok(config) = read_config() else {
            return;
        };
        let start_if_missing = config.auto_start && config.python_path.is_some();
        if let Err(error) = reconcile(start_if_missing).await {
            log::warn!("Alpha delayed reconciliation failed: {error}");
        }
    });
}

/// 协调运行中的服务 revision；`start_if_missing` 为 false 时不会改变停止状态。
pub(super) async fn reconcile(start_if_missing: bool) -> Result<(), String> {
    let _lock = acquire_operation_lock().await?;
    reconcile_locked(start_if_missing).await
}

/// 在已持有跨进程操作锁时检查服务状态，并按需替换或启动服务。
async fn reconcile_locked(start_if_missing: bool) -> Result<(), String> {
    let existing_token = read_token().ok();
    let running = match existing_token.as_deref() {
        Some(token) => probe_owned_service(token).await,
        None => None,
    };
    let port_open = if running.is_none() {
        port_is_open().await
    } else {
        true
    };
    let replace_running = match plan_presence(running.is_some(), port_open, start_if_missing) {
        PresencePlan::InspectRunning => true,
        PresencePlan::Spawn => false,
        PresencePlan::LeaveStopped => return Ok(()),
        PresencePlan::PortConflict => {
            return Err(format!(
                "端口 {ALPHA_PORT} 已被其他服务占用，无法启动 Alpha"
            ));
        }
    };
    // 停止状态且不需要启动时已提前返回，避免每次开发文件保存都扫描全部源码。
    let runtime = tokio::task::spawn_blocking(runtime_files::runtime_spec)
        .await
        .map_err(|error| error.to_string())??;
    if running
        .as_ref()
        .is_some_and(|health| is_current_runtime(health, &runtime.revision))
    {
        return Ok(());
    }
    let config = read_config()?;
    let python = config
        .python_path
        .ok_or_else(|| "尚未配置 Alpha Python 解释器".to_string())?;
    let python = validate_python_path(&python)?;
    let alpha_home = runtime_files::alpha_home()?;
    let logs_dir = runtime_files::logs_dir()?;
    // 只有确认需要创建服务后才生成凭据，文件监听不会修改停止状态下的本机数据。
    let token = match existing_token {
        Some(token) => token,
        None => ensure_token()?,
    };
    if replace_running {
        // 先完成新服务前置检查，避免解释器或源码无效时停止仍可用的旧实例。
        stop_locked().await?;
    }
    let process_exit = spawn_service(
        &python,
        &runtime.code_root,
        &alpha_home,
        &logs_dir,
        &token,
        &runtime.revision,
    )?;
    let log_path = logs_dir.join("service.log");

    let deadline = Instant::now() + OPERATION_TIMEOUT;
    while Instant::now() < deadline {
        if probe_owned_service(&token)
            .await
            .as_ref()
            .is_some_and(|health| is_current_runtime(health, &runtime.revision))
        {
            return Ok(());
        }
        match process_exit.try_recv() {
            Ok(Ok(status)) => return Err(startup_exit_message(status, &log_path)),
            Ok(Err(error)) => {
                return Err(format!(
                    "等待 Alpha 进程退出状态失败: {error}，请检查 {}",
                    log_path.display()
                ));
            }
            Err(TryRecvError::Disconnected) => {
                return Err(format!(
                    "无法监控 Alpha 启动进程，请检查 {}",
                    log_path.display()
                ));
            }
            Err(TryRecvError::Empty) => {}
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err(format!("Alpha 启动超时，请检查 {}", log_path.display()))
}

/// 根据受管服务、端口和启动意图决定是否需要读取运行源码。
fn plan_presence(owned_service: bool, port_open: bool, start_if_missing: bool) -> PresencePlan {
    match (owned_service, port_open, start_if_missing) {
        (true, _, _) => PresencePlan::InspectRunning,
        (false, true, _) => PresencePlan::PortConflict,
        (false, false, true) => PresencePlan::Spawn,
        (false, false, false) => PresencePlan::LeaveStopped,
    }
}

async fn stop_locked() -> Result<(), String> {
    let token = match read_token() {
        Ok(token) => token,
        Err(_) if !port_is_open().await => return Ok(()),
        Err(error) => return Err(error),
    };
    if probe_owned_service(&token).await.is_none() {
        if port_is_open().await {
            return Err(format!(
                "端口 {ALPHA_PORT} 已被其他服务占用，拒绝停止未知进程"
            ));
        }
        return Ok(());
    }
    let response = client()
        .post(format!("{}/api/alpha/system/shutdown", base_url()))
        .bearer_auth(&token)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format!("请求 Alpha 停止失败: {error}"))?;
    if response.status() != StatusCode::ACCEPTED {
        return Err(format!("Alpha 拒绝停止请求: HTTP {}", response.status()));
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !port_is_open().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("等待 Alpha 服务停止超时".to_string())
}

/// 使用明确解释器路径启动独立于当前 Terax 窗口的 Alpha 进程。
fn spawn_service(
    python: &Path,
    code_root: &Path,
    alpha_home: &Path,
    logs_dir: &Path,
    token: &str,
    runtime_revision: &str,
) -> Result<Receiver<io::Result<ExitStatus>>, String> {
    let log_path = logs_dir.join("service.log");
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(python);
    command
        .current_dir(code_root)
        .args([
            "-E",
            "-m",
            "alpha",
            "--host",
            ALPHA_HOST,
            "--port",
            &ALPHA_PORT.to_string(),
        ])
        .env("TERAX_ALPHA_TOKEN", token)
        .env("TERAX_ALPHA_HOME", alpha_home)
        .env("TERAX_ALPHA_RUNTIME_REVISION", runtime_revision)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    detach_process(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 Python 解释器 {}: {error}",
            python.to_string_lossy()
        )
    })?;
    let (exit_sender, exit_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = exit_sender.send(child.wait());
    });
    Ok(exit_receiver)
}

/// 构造 Python 子进程提前退出时的可操作错误。
fn startup_exit_message(status: impl std::fmt::Display, log_path: &Path) -> String {
    format!(
        "Alpha 进程启动后退出，状态为 {status}，请检查 {}",
        log_path.display()
    )
}

#[cfg(windows)]
fn detach_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn detach_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: pre_exec 中只调用异步信号安全的 setsid，不访问 Rust 堆或持有的锁。
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// 探测凭据匹配的 Terax Alpha，即使协议已过期也保留其身份用于安全替换。
async fn probe_owned_service(token: &str) -> Option<ServiceHealth> {
    let response = client()
        .get(format!("{}/api/alpha/health", base_url()))
        .bearer_auth(token)
        .timeout(Duration::from_millis(800))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let health: ServiceHealth = serde_json::from_slice(&bytes).ok()?;
    (health.service == "terax-alpha").then_some(health)
}

/// 判断服务是否可供当前客户端使用，不要求运行源码 revision 与当前构建一致。
fn is_usable_service(health: &ServiceHealth) -> bool {
    health.status == "ok" && health.ready && health.protocol_version == SERVICE_PROTOCOL_VERSION
}

/// 判断服务协议、就绪状态和运行源码是否全部与当前期望一致。
fn is_current_runtime(health: &ServiceHealth, expected_revision: &str) -> bool {
    is_usable_service(health) && health.runtime_revision.as_deref() == Some(expected_revision)
}

async fn port_is_open() -> bool {
    tokio::time::timeout(
        Duration::from_millis(300),
        tokio::net::TcpStream::connect((ALPHA_HOST, ALPHA_PORT)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn acquire_operation_lock() -> Result<FileLock, String> {
    let path = runtime_files::service_lock_path()?;
    // 重启最长包含一次停止和一次启动，等待锁的窗口必须覆盖完整操作时限。
    let deadline = Instant::now() + LOCK_TIMEOUT;
    loop {
        if let Some(lock) = FileLock::try_acquire(&path).map_err(|error| error.to_string())? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err("等待其他 Terax 窗口完成 Alpha 操作超时".to_string());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn ensure_token() -> Result<String, String> {
    if let Ok(token) = read_token() {
        return Ok(token);
    }
    let path = runtime_files::token_path()?;
    let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    write_atomic(&path, token.as_bytes()).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(token)
}

pub(super) fn read_token() -> Result<String, String> {
    let path = runtime_files::token_path()?;
    let token = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 Alpha 服务凭据 {}: {error}", path.display()))?;
    let token = token.trim();
    if token.len() < 32 {
        return Err("Alpha 服务凭据无效".to_string());
    }
    Ok(token.to_string())
}

fn validate_python_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err("Python 解释器必须使用绝对路径".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("无法访问 Python 解释器 {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Python 解释器不是文件: {}", path.display()));
    }
    // macOS 和 Linux 的虚拟环境解释器通常是符号链接，解析链接会丢失虚拟环境身份。
    Ok(path)
}

async fn check_python(path: &Path, code_root: &Path) -> PythonCheck {
    let mut command = tokio::process::Command::new(path);
    command
        .current_dir(code_root)
        .args(["-E", "-m", "alpha.runtime_check"])
        .kill_on_drop(true);
    proc::hide_console(command.as_std_mut());
    let result = tokio::time::timeout(Duration::from_secs(10), command.output()).await;
    let path_text = path.to_string_lossy().into_owned();
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return PythonCheck {
                path: path_text,
                version: None,
                missing_packages: Vec::new(),
                error: Some(error.to_string()),
            };
        }
        Err(_) => {
            return PythonCheck {
                path: path_text,
                version: None,
                missing_packages: Vec::new(),
                error: Some("Python 检查超时".to_string()),
            };
        }
    };
    if !output.status.success() {
        return PythonCheck {
            path: path_text,
            version: None,
            missing_packages: Vec::new(),
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        };
    }
    let result: RuntimeCheck = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(error) => {
            return PythonCheck {
                path: path_text,
                version: None,
                missing_packages: Vec::new(),
                error: Some(format!("无法解析 Python 检查结果: {error}")),
            };
        }
    };
    python_check_from_runtime(path_text, result)
}

/// 把 Python 侧的环境报告转换成前端稳定模型。
fn python_check_from_runtime(path: String, result: RuntimeCheck) -> PythonCheck {
    let error = if !result.supported {
        Some(format!(
            "Alpha 需要 Python {} 或更高版本，当前为 {}",
            result.minimum_version, result.version
        ))
    } else if result.import_errors.is_empty() {
        None
    } else {
        Some(format!(
            "Alpha Python 依赖无法加载: {}",
            result.import_errors.join("; ")
        ))
    };
    PythonCheck {
        path,
        version: Some(result.version),
        missing_packages: result.missing_packages,
        error,
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

pub(super) fn base_url() -> String {
    format!("http://{ALPHA_HOST}:{ALPHA_PORT}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_path_must_be_absolute_and_existing_file() {
        assert!(validate_python_path("python").is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_python_path(dir.path().to_string_lossy().as_ref()).is_err());
        let file = dir.path().join("python");
        fs::write(&file, b"").unwrap();
        assert!(validate_python_path(file.to_string_lossy().as_ref()).is_ok());
    }

    #[test]
    fn base_url_is_fixed_to_loopback() {
        assert_eq!(base_url(), "http://127.0.0.1:11123");
    }

    #[cfg(unix)]
    #[test]
    fn python_path_preserves_virtual_environment_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("python-real");
        let selected = dir.path().join("python");
        fs::write(&target, b"").unwrap();
        symlink(&target, &selected).unwrap();

        assert_eq!(
            validate_python_path(selected.to_string_lossy().as_ref()).unwrap(),
            selected
        );
    }

    #[test]
    fn reconciliation_plan_preserves_stopped_and_owned_service_states() {
        let current = ServiceHealth {
            status: "ok".to_string(),
            ready: true,
            service: "terax-alpha".to_string(),
            protocol_version: SERVICE_PROTOCOL_VERSION,
            runtime_revision: Some("dev:current".to_string()),
        };
        assert_eq!(
            plan_presence(true, true, false),
            PresencePlan::InspectRunning
        );
        assert_eq!(
            plan_presence(false, false, false),
            PresencePlan::LeaveStopped
        );
        assert_eq!(plan_presence(false, false, true), PresencePlan::Spawn);
        assert_eq!(
            plan_presence(false, true, false),
            PresencePlan::PortConflict
        );
        assert!(is_current_runtime(&current, "dev:current"));
        assert!(!is_current_runtime(&current, "dev:stale"));

        let mut unavailable = current;
        unavailable.ready = false;
        assert!(!is_usable_service(&unavailable));
    }

    #[test]
    fn old_protocol_service_is_owned_but_requires_replacement() {
        let old: ServiceHealth = serde_json::from_value(serde_json::json!({
            "status": "ok",
            "services_ready": true,
            "service": "terax-alpha",
            "protocol_version": 1,
            "archive_hash": "old"
        }))
        .unwrap();

        assert!(!is_usable_service(&old));
        assert_eq!(old.runtime_revision.as_deref(), Some("old"));
        assert!(!is_current_runtime(&old, "release:new"));
        assert_eq!(
            plan_presence(true, true, false),
            PresencePlan::InspectRunning
        );
    }

    #[test]
    fn current_health_response_deserializes_with_runtime_revision() {
        let current: ServiceHealth = serde_json::from_value(serde_json::json!({
            "status": "ok",
            "ready": true,
            "service": "terax-alpha",
            "protocol_version": 2,
            "runtime_revision": "release:current"
        }))
        .unwrap();

        assert!(is_current_runtime(&current, "release:current"));
    }

    #[test]
    fn runtime_check_rejects_old_python_and_preserves_missing_packages() {
        let check = python_check_from_runtime(
            "C:/Python/python.exe".to_string(),
            RuntimeCheck {
                version: "3.10.14".to_string(),
                minimum_version: "3.11".to_string(),
                supported: false,
                missing_packages: vec!["fastapi".to_string()],
                import_errors: Vec::new(),
            },
        );

        assert!(check.error.unwrap().contains("Python 3.11"));
        assert_eq!(check.missing_packages, ["fastapi"]);
    }

    #[test]
    fn runtime_check_reports_broken_native_dependency() {
        let check = python_check_from_runtime(
            "C:/Python/python.exe".to_string(),
            RuntimeCheck {
                version: "3.11.9".to_string(),
                minimum_version: "3.11".to_string(),
                supported: true,
                missing_packages: Vec::new(),
                import_errors: vec!["ta-lib: OSError: missing DLL".to_string()],
            },
        );

        assert!(check.error.unwrap().contains("ta-lib"));
    }

    #[test]
    fn startup_exit_message_points_to_service_log() {
        let message = startup_exit_message(7, Path::new("logs/alpha/service.log"));

        assert!(message.contains("状态为 7"));
        assert!(message.contains("logs/alpha/service.log"));
    }
}
