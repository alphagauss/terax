//! 当前 Workspace 进程的统一桌面通知服务。
//! 原生持有有界目标表，系统只回传不透明 ID；窗口及模块目标不得指定进程、URL 或命令。

mod platform;

use super::auxiliary_window::{self, OpenAuxiliaryWindowRequest};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const ACTIVATION_EVENT: &str = "terax:notification-activate";
const MAX_TARGETS: usize = 128;
const TARGET_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// 主窗口业务目标只携带身份，不携带派生展示数据或可执行参数。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "module", rename_all = "kebab-case", deny_unknown_fields)]
pub enum MainTarget {
    Workspace,
    Terminal {
        #[serde(rename = "tabId")]
        tab_id: u32,
    },
    Ai {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

/// 进程身份由发送服务隐式绑定，辅助窗口复用既有封闭打开协议。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "window", rename_all = "kebab-case", deny_unknown_fields)]
pub enum NotificationTarget {
    Main { target: MainTarget },
    Auxiliary { request: OpenAuxiliaryWindowRequest },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationRequest {
    title: String,
    body: String,
    target: NotificationTarget,
}

#[derive(Default)]
struct TargetRegistry {
    targets: VecDeque<(String, Instant, NotificationTarget)>,
    pending: Option<NotificationActivation>,
}

/// 主窗口确认处理后才清除，避免 WebView 重挂载期间丢失点击。
#[derive(Clone, Serialize)]
pub struct NotificationActivation {
    id: String,
    target: MainTarget,
}

impl TargetRegistry {
    fn acknowledge(&mut self, id: &str) {
        if self
            .pending
            .as_ref()
            .is_some_and(|activation| activation.id == id)
        {
            self.pending = None;
        }
    }
    fn insert(&mut self, target: NotificationTarget) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.targets
            .retain(|(_, at, _)| at.elapsed() < TARGET_LIFETIME);
        if self.targets.len() >= MAX_TARGETS {
            self.targets.pop_front();
        }
        self.targets.push_back((id.clone(), Instant::now(), target));
        id
    }

    fn take(&mut self, id: &str) -> Option<NotificationTarget> {
        self.take_at(id, Instant::now())
    }

    fn take_at(&mut self, id: &str, now: Instant) -> Option<NotificationTarget> {
        let index = self.targets.iter().position(|(key, _, _)| key == id)?;
        let (_, at, target) = self.targets.remove(index)?;
        (now.duration_since(at) < TARGET_LIFETIME).then_some(target)
    }
}

/// 状态随应用进程存活，页面重挂载不会取消通知或错失最新点击目标。
#[derive(Default)]
pub struct NotificationState(Mutex<TargetRegistry>);

fn validate_caller(label: &str) -> Result<(), String> {
    if label == "main" || auxiliary_window::is_registered_label(label) {
        Ok(())
    } else {
        Err("Notification caller is not a registered application window".into())
    }
}

/// 桌面权限准备由同一原生服务负责，前端无需自行调用通知插件。
#[tauri::command]
pub async fn notification_prepare(window: tauri::WebviewWindow) -> Result<bool, String> {
    validate_caller(window.label())?;
    tauri::async_runtime::spawn_blocking(platform::prepare)
        .await
        .map_err(|e| e.to_string())?
}

/// 等待系统发送 API 返回，并保留其错误；不宣称通知已经显示。
#[tauri::command]
pub async fn notification_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: NotificationRequest,
) -> Result<(), String> {
    validate_caller(window.label())?;
    if request.title.trim().is_empty() || request.title.len() > 1024 || request.body.len() > 8192 {
        return Err("Notification text is empty or too long".into());
    }
    match &request.target {
        NotificationTarget::Main {
            target: MainTarget::Terminal { tab_id: 0 },
        } => return Err("Invalid terminal identity".into()),
        NotificationTarget::Main {
            target: MainTarget::Ai { session_id },
        } if session_id.is_empty() || session_id.len() > 256 => {
            return Err("Invalid session identity".into())
        }
        _ => {}
    }
    let id = app
        .state::<NotificationState>()
        .0
        .lock()
        .unwrap()
        .insert(request.target);
    let send_app = app.clone();
    let send_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        platform::send(send_app, send_id, request.title, request.body)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    if result.is_err() {
        app.state::<NotificationState>().0.lock().unwrap().take(&id);
    }
    result
}

/// 主窗口先监听事件再读取目标，处理成功后按身份确认。
#[tauri::command]
pub fn notification_get_activation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NotificationState>,
) -> Result<Option<NotificationActivation>, String> {
    if window.label() != "main" {
        return Err("Only the main window may consume module navigation".into());
    }
    Ok(state.0.lock().unwrap().pending.clone())
}

#[tauri::command]
pub fn notification_ack_activation(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NotificationState>,
    id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window may acknowledge module navigation".into());
    }
    state.0.lock().unwrap().acknowledge(&id);
    Ok(())
}

fn activate(app: &tauri::AppHandle, id: &str) {
    let target = app.state::<NotificationState>().0.lock().unwrap().take(id);
    let Some(target) = target else {
        return;
    };
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let main = app
                .get_webview_window("main")
                .ok_or("Workspace window no longer exists")?;
            main.unminimize().map_err(|e| e.to_string())?;
            main.show().map_err(|e| e.to_string())?;
            match target {
                NotificationTarget::Main { target } => {
                    app.state::<NotificationState>().0.lock().unwrap().pending =
                        Some(NotificationActivation { id, target });
                    main.set_focus().map_err(|e| e.to_string())?;
                    main.emit(ACTIVATION_EVENT, ()).map_err(|e| e.to_string())?;
                }
                NotificationTarget::Auxiliary { request } => {
                    auxiliary_window::open_auxiliary_window(app.clone(), request, app.state())
                        .await?;
                }
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            log::warn!("Notification activation failed: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_acknowledgement_cannot_remove_new_activation() {
        let mut registry = TargetRegistry {
            pending: Some(NotificationActivation {
                id: "new".into(),
                target: MainTarget::Workspace,
            }),
            ..Default::default()
        };
        registry.acknowledge("old");
        assert!(registry.pending.is_some());
        registry.acknowledge("new");
        assert!(registry.pending.is_none());
    }

    #[test]
    fn targets_are_process_local_bounded_and_consumed_once() {
        let mut registry = TargetRegistry::default();
        let target = NotificationTarget::Main {
            target: MainTarget::Terminal { tab_id: 7 },
        };
        let old = registry.insert(target.clone());
        for _ in 0..MAX_TARGETS {
            registry.insert(target.clone());
        }
        assert_eq!(registry.targets.len(), MAX_TARGETS);
        assert!(registry.take(&old).is_none());
        let id = registry.insert(target.clone());
        assert_eq!(registry.take(&id), Some(target));
        assert!(registry.take(&id).is_none());
        assert!(TargetRegistry::default().take(&id).is_none());
    }

    #[test]
    fn expired_targets_cannot_activate_and_auxiliary_protocol_is_reused() {
        let target: NotificationTarget = serde_json::from_str(
            r#"{"window":"auxiliary","request":{"kind":"settings","tab":"general"}}"#,
        )
        .unwrap();
        // 从创建时刻向前推进，避免系统运行不足一天时回拨 Instant 导致下溢。
        for (elapsed, valid) in [
            (TARGET_LIFETIME - Duration::from_nanos(1), true),
            (TARGET_LIFETIME, false),
            (TARGET_LIFETIME + Duration::from_secs(1), false),
        ] {
            let mut registry = TargetRegistry::default();
            let id = registry.insert(target.clone());
            let now = registry.targets[0].1 + elapsed;
            assert_eq!(
                registry.take_at(&id, now),
                valid.then(|| target.clone()),
                "通知经过 {elapsed:?} 后的有效性不符"
            );
            assert!(registry.take_at(&id, now).is_none());
        }
        assert!(serde_json::from_str::<NotificationTarget>(
            r#"{"window":"auxiliary","request":{"kind":"settings","tab":"unknown"}}"#
        )
        .is_err());
    }

    #[test]
    fn rejects_unregistered_windows_and_arbitrary_navigation() {
        assert!(validate_caller("main").is_ok());
        assert!(validate_caller("auxiliary-settings").is_ok());
        assert!(validate_caller("auxiliary-unknown").is_err());
        for json in [
            r#"{"window":"other"}"#,
            r#"{"window":"main","target":{"module":"shell","command":"pwd"}}"#,
            r#"{"window":"main","target":{"module":"workspace"},"process":1}"#,
        ] {
            assert!(serde_json::from_str::<NotificationTarget>(json).is_err());
        }
    }
}
