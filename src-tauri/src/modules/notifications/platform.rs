//! 各桌面平台的通知发送与点击适配，不暴露系统回调或应用身份给业务页面。

#[cfg(target_os = "macos")]
pub fn prepare() -> Result<bool, String> {
    mac_usernotifications::check_bundle().map_err(|e| e.to_string())?;
    mac_usernotifications::blocking::request_auth().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn prepare() -> Result<bool, String> {
    Ok(true)
}

#[cfg(windows)]
pub fn send(app: tauri::AppHandle, id: String, title: String, body: String) -> Result<(), String> {
    use tauri_winrt_notification::Toast;

    static IDENTITY_READY: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
    let identifier = &app.config().identifier;
    initialize_identity_once(&IDENTITY_READY, || register_identity(identifier))?;
    Toast::new(identifier)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            super::activate(&app, &id);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

/// 串行初始化进程内共享身份，只缓存成功结果，失败后的下一次发送仍可重试。
#[cfg(windows)]
fn initialize_identity_once(
    ready: &std::sync::Mutex<bool>,
    initialize: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut ready = ready.lock().map_err(|e| e.to_string())?;
    if !*ready {
        initialize()?;
        *ready = true;
    }
    Ok(())
}

#[cfg(windows)]
fn register_identity(identifier: &str) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    // 注册 Terax 自身的发送身份，开发构建也不借用 PowerShell 的名称和图标。
    let directory =
        crate::modules::app_data::directory(crate::modules::app_data::Directory::Shared)?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let icon = directory.join("notification.ico");
    let bytes = include_bytes!("../../../icons/icon.ico");
    if std::fs::read(&icon).ok().as_deref() != Some(bytes.as_slice()) {
        let temporary = directory.join(format!("notification-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        if let Err(error) = std::fs::rename(&temporary, &icon) {
            let _ = std::fs::remove_file(temporary);
            return Err(error.to_string());
        }
    }
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(format!("Software\\Classes\\AppUserModelId\\{identifier}"))
        .map_err(|e| e.to_string())?;
    key.set_value("DisplayName", &"Terax")
        .map_err(|e| e.to_string())?;
    key.set_value("IconUri", &icon.to_string_lossy().as_ref())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::initialize_identity_once;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Barrier, Mutex,
    };

    #[test]
    fn concurrent_senders_initialize_identity_only_once() {
        let ready = Mutex::new(false);
        let calls = AtomicUsize::new(0);
        let barrier = Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    initialize_identity_once(&ready, || {
                        calls.fetch_add(1, Ordering::Relaxed);
                        Ok(())
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn failed_initialization_is_retried_and_success_is_cached() {
        let ready = Mutex::new(false);
        assert_eq!(
            initialize_identity_once(&ready, || Err("registry unavailable".into())),
            Err("registry unavailable".into())
        );
        assert!(!*ready.lock().unwrap());
        initialize_identity_once(&ready, || Ok(())).unwrap();
        initialize_identity_once(&ready, || panic!("must reuse successful initialization"))
            .unwrap();
    }
}

#[cfg(target_os = "linux")]
pub fn send(app: tauri::AppHandle, id: String, title: String, body: String) -> Result<(), String> {
    static OBSERVERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(128);
    let observer = OBSERVERS
        .try_acquire()
        .map_err(|_| "Too many pending system notifications".to_string())?;
    let handle = notify_rust::Notification::new()
        .appname("Terax")
        .summary(&title)
        .body(&body)
        .icon(&app.config().identifier)
        .action("default", "")
        .show()
        .map_err(|e| e.to_string())?;
    // 等待点击不占用阻塞线程；目标过期后放弃监听，不影响业务任务。
    tauri::async_runtime::spawn(async move {
        let _observer = observer;
        let _ = tokio::time::timeout(
            super::TARGET_LIFETIME,
            handle.wait_for_action_async(|action| {
                if matches!(action, notify_rust::NotificationResponse::Default) {
                    super::activate(&app, &id);
                }
            }),
        )
        .await;
    });
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn send(app: tauri::AppHandle, id: String, title: String, body: String) -> Result<(), String> {
    static OBSERVERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(128);
    let observer = OBSERVERS
        .try_acquire()
        .map_err(|_| "Too many pending system notifications".to_string())?;
    let handle = mac_usernotifications::Notification::new()
        .title(&title)
        .message(&body)
        .timeout(super::TARGET_LIFETIME)
        .send_blocking()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        let _observer = observer;
        match handle.response().await {
            Ok(response) if response.is_default_action() => super::activate(&app, &id),
            Err(error) => log::warn!("Notification response failed: {error}"),
            _ => {}
        }
    });
    Ok(())
}
