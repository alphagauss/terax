//! Alpha 本机单例服务控制。
//!
//! 每次状态查询都以固定本机端口上的受认证健康检查为准。启动、停止和重启仅通过
//! 一把跨进程文件锁串行化，因此所有 Terax 窗口拥有相同行为且不复制服务状态。

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
const SETTINGS_STORE: &str = "settings";
const PYTHON_PATH_KEY: &str = "alphaPythonPath";
const AUTO_START_KEY: &str = "alphaAutoStart";
const SERVICE_PROTOCOL_VERSION: u32 = 1;
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
    pub archive_hash: String,
    pub service_archive_hash: Option<String>,
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
    services_ready: bool,
    service: String,
    protocol_version: u32,
    archive_hash: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartPlan {
    AlreadyRunning,
    ReplaceRunning,
    Spawn,
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
    let health = match token.as_deref() {
        Some(token) => health(token).await,
        None => None,
    };
    let port_open = if health.is_none() {
        port_is_open().await
    } else {
        true
    };
    let issue = if health.is_none() && port_open {
        Some(AlphaStatusIssue::PortConflict)
    } else {
        None
    };
    Ok(AlphaStatus {
        running: health.is_some(),
        configured: config.python_path.is_some(),
        python_path: config.python_path,
        auto_start: config.auto_start,
        port: ALPHA_PORT,
        archive_hash: runtime_files::ARCHIVE_HASH.to_string(),
        service_archive_hash: health.map(|value| value.archive_hash),
        issue,
    })
}

/// 幂等启动共享 Alpha 服务。
pub async fn start() -> Result<AlphaStatus, String> {
    let _lock = acquire_operation_lock().await?;
    start_locked().await?;
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
    start_locked().await?;
    status().await
}

/// 在应用 Ready 后延迟确保共享服务已启动。
pub fn schedule_delayed_start() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let Ok(config) = read_config() else {
            return;
        };
        if config.auto_start && config.python_path.is_some() {
            if let Err(error) = start().await {
                log::warn!("Alpha delayed startup failed: {error}");
            }
        }
    });
}

async fn start_locked() -> Result<(), String> {
    let token = ensure_token()?;
    let running = health(&token).await;
    let port_open = if running.is_none() {
        port_is_open().await
    } else {
        true
    };
    let replace_running = match plan_start(running.as_ref(), port_open) {
        StartPlan::AlreadyRunning => return Ok(()),
        StartPlan::ReplaceRunning => true,
        StartPlan::Spawn => false,
        StartPlan::PortConflict => {
            return Err(format!(
                "端口 {ALPHA_PORT} 已被其他服务占用，无法启动 Alpha"
            ));
        }
    };
    let config = read_config()?;
    let python = config
        .python_path
        .ok_or_else(|| "尚未配置 Alpha Python 解释器".to_string())?;
    let python = validate_python_path(&python)?;
    let code_root = tokio::task::spawn_blocking(runtime_files::code_root)
        .await
        .map_err(|error| error.to_string())??;
    let data_dir = runtime_files::data_dir()?;
    let logs_dir = runtime_files::logs_dir()?;
    if replace_running {
        // 先完成新服务前置检查，避免解释器或源码无效时停止仍可用的旧实例。
        stop_locked().await?;
    }
    let process_exit = spawn_service(&python, &code_root, &data_dir, &logs_dir, &token)?;
    let log_path = logs_dir.join("service.log");

    let deadline = Instant::now() + OPERATION_TIMEOUT;
    while Instant::now() < deadline {
        if health(&token).await.is_some() {
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

/// 根据探活与端口状态决定幂等启动行为。
fn plan_start(running: Option<&ServiceHealth>, port_open: bool) -> StartPlan {
    match running {
        Some(health) if health.archive_hash == runtime_files::ARCHIVE_HASH => {
            StartPlan::AlreadyRunning
        }
        Some(_) => StartPlan::ReplaceRunning,
        None if port_open => StartPlan::PortConflict,
        None => StartPlan::Spawn,
    }
}

async fn stop_locked() -> Result<(), String> {
    let token = match read_token() {
        Ok(token) => token,
        Err(_) if !port_is_open().await => return Ok(()),
        Err(error) => return Err(error),
    };
    if health(&token).await.is_none() {
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
    data_dir: &Path,
    logs_dir: &Path,
    token: &str,
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
        .env("TERAX_ALPHA_DATA_DIR", data_dir)
        .env("TERAX_ALPHA_LOG_DIR", logs_dir)
        .env("TERAX_ALPHA_ARCHIVE_HASH", runtime_files::ARCHIVE_HASH)
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

async fn health(token: &str) -> Option<ServiceHealth> {
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
    is_compatible_health(&health).then_some(health)
}

/// 校验端口上的响应确实来自已就绪且协议兼容的 Terax Alpha。
fn is_compatible_health(health: &ServiceHealth) -> bool {
    health.status == "ok"
        && health.services_ready
        && health.service == "terax-alpha"
        && health.protocol_version == SERVICE_PROTOCOL_VERSION
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
    fn start_plan_preserves_single_current_service() {
        let current = ServiceHealth {
            status: "ok".to_string(),
            services_ready: true,
            service: "terax-alpha".to_string(),
            protocol_version: SERVICE_PROTOCOL_VERSION,
            archive_hash: runtime_files::ARCHIVE_HASH.to_string(),
        };
        let stale = ServiceHealth {
            archive_hash: "stale".to_string(),
            ..current.clone()
        };

        assert_eq!(plan_start(Some(&current), true), StartPlan::AlreadyRunning);
        assert_eq!(plan_start(Some(&stale), true), StartPlan::ReplaceRunning);
        assert_eq!(plan_start(None, false), StartPlan::Spawn);
        assert_eq!(plan_start(None, true), StartPlan::PortConflict);

        let mut unavailable = current;
        unavailable.services_ready = false;
        assert!(!is_compatible_health(&unavailable));
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
