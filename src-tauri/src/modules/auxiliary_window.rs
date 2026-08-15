//! 轻量辅助窗口的原生创建与复用。
//!
//! 本模块通过封闭请求类型选择受信任页面和窗口定义。辅助窗口始终从属于当前
//! Workspace 主窗口，不拥有第二套 Workspace 运行时，也不恢复窗口位置或尺寸。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const AUXILIARY_OPEN_EVENT: &str = "terax:auxiliary-open";

const SETTINGS_LABEL: &str = "auxiliary-settings";
const AUXILIARY_ENTRY: &str = "auxiliary.html";

static AUXILIARY_WINDOW_LOCK: Mutex<()> = Mutex::new(());

/// 允许设置窗口打开的分区。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsTab {
    General,
    Editor,
    Themes,
    Shortcuts,
    Models,
    Agents,
    Remote,
    About,
}

impl SettingsTab {
    fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Editor => "editor",
            Self::Themes => "themes",
            Self::Shortcuts => "shortcuts",
            Self::Models => "models",
            Self::Agents => "agents",
            Self::Remote => "remote",
            Self::About => "about",
        }
    }
}

/// 受支持的辅助窗口打开请求。
///
/// 枚举同时作为 IPC 和窗口重用事件的协议，未知类型、字段或设置分区会在进入
/// 窗口创建逻辑前被 serde 拒绝。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OpenAuxiliaryWindowRequest {
    Settings {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<SettingsTab>,
    },
}

/// 辅助窗口首次创建时的位置策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuxiliaryWindowPlacement {
    ParentCenter,
    MonitorCenter,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct AuxiliaryWindowDefinition {
    label: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    resizable: bool,
    minimizable: bool,
    maximizable: bool,
    placement: AuxiliaryWindowPlacement,
}

impl OpenAuxiliaryWindowRequest {
    fn definition(&self) -> AuxiliaryWindowDefinition {
        match self {
            Self::Settings { .. } => AuxiliaryWindowDefinition {
                label: SETTINGS_LABEL,
                width: 900.0,
                height: 700.0,
                min_width: 820.0,
                min_height: 620.0,
                resizable: true,
                minimizable: false,
                maximizable: false,
                placement: AuxiliaryWindowPlacement::ParentCenter,
            },
        }
    }

    fn initial_url(&self) -> String {
        match self {
            Self::Settings { tab: Some(tab) } => {
                format!("{AUXILIARY_ENTRY}?tab={}", tab.as_str())
            }
            Self::Settings { tab: None } => AUXILIARY_ENTRY.to_string(),
        }
    }
}

/// 打开或复用受支持的辅助窗口。
///
/// 新窗口以隐藏状态创建，由公共前端入口在主题和页面挂载后显示。相同类型已经
/// 存在时只聚焦窗口并发送最新请求，不重新创建 WebView。
///
/// 命令必须保持异步形式，使同步的 WebView 创建不占用 Tauri UI 线程。内部锁只
/// 包围不含 await 的短操作，用于避免快速重复请求同时创建相同 label。
#[tauri::command]
pub async fn open_auxiliary_window(
    app: tauri::AppHandle,
    request: OpenAuxiliaryWindowRequest,
) -> Result<(), String> {
    let _open_guard = AUXILIARY_WINDOW_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let definition = request.definition();

    if let Some(window) = app.get_webview_window(definition.label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        window
            .emit(AUXILIARY_OPEN_EVENT, request)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Workspace 主窗口不存在，无法创建辅助窗口".to_string())?;
    let url = request.initial_url();
    let builder = WebviewWindowBuilder::new(&app, definition.label, WebviewUrl::App(url.into()))
        .title("Terax")
        .inner_size(definition.width, definition.height)
        .min_inner_size(definition.min_width, definition.min_height)
        .resizable(definition.resizable)
        .minimizable(definition.minimizable)
        .maximizable(definition.maximizable)
        .closable(true)
        .visible(false)
        .parent(&main)
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    #[cfg_attr(target_os = "windows", allow(unused_variables))]
    let window = builder.build().map_err(|error| error.to_string())?;

    // 部分 Linux compositor 会忽略 builder 阶段的无边框设置，创建后需要再次确认。
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    place_window(&window, &main, definition.placement);
    Ok(())
}

/// 按静态策略设置辅助窗口的首次位置。
///
/// 父窗口尺寸读取失败时退回显示器居中，避免因定位失败而阻止窗口打开。
fn place_window(window: &WebviewWindow, main: &WebviewWindow, placement: AuxiliaryWindowPlacement) {
    match placement {
        AuxiliaryWindowPlacement::MonitorCenter => {
            let _ = window.center();
        }
        AuxiliaryWindowPlacement::ParentCenter => {
            if let (Ok(main_pos), Ok(main_size), Ok(window_size)) = (
                main.outer_position(),
                main.outer_size(),
                window.outer_size(),
            ) {
                let x = main_pos.x
                    + ((main_size.width as i32).saturating_sub(window_size.width as i32)) / 2;
                let y = main_pos.y
                    + ((main_size.height as i32).saturating_sub(window_size.height as i32)) / 2;
                if window.set_position(PhysicalPosition::new(x, y)).is_err() {
                    let _ = window.center();
                }
            } else {
                let _ = window.center();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_request_uses_singleton_window_definition() {
        let request = OpenAuxiliaryWindowRequest::Settings {
            tab: Some(SettingsTab::Themes),
        };
        let definition = request.definition();

        assert_eq!(definition.label, "auxiliary-settings");
        assert_eq!((definition.width, definition.height), (900.0, 700.0));
        assert_eq!(
            (definition.min_width, definition.min_height),
            (820.0, 620.0)
        );
        assert!(definition.resizable);
        assert!(!definition.minimizable);
        assert!(!definition.maximizable);
        assert_eq!(definition.placement, AuxiliaryWindowPlacement::ParentCenter);
        assert_eq!(request.initial_url(), "auxiliary.html?tab=themes");
    }

    #[test]
    fn settings_request_without_tab_uses_plain_entry_url() {
        let request = OpenAuxiliaryWindowRequest::Settings { tab: None };
        assert_eq!(request.initial_url(), "auxiliary.html");
    }

    #[test]
    fn ipc_request_rejects_unknown_kinds_tabs_and_fields() {
        assert!(serde_json::from_str::<OpenAuxiliaryWindowRequest>(
            r#"{"kind":"settings","tab":"shortcuts"}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<OpenAuxiliaryWindowRequest>(
            r#"{"kind":"settings","tab":"connections"}"#
        )
        .is_err());
        assert!(
            serde_json::from_str::<OpenAuxiliaryWindowRequest>(r#"{"kind":"unknown"}"#).is_err()
        );
        assert!(serde_json::from_str::<OpenAuxiliaryWindowRequest>(
            r#"{"kind":"settings","extra":true}"#
        )
        .is_err());
    }
}
