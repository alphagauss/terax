//! 轻量辅助窗口的原生创建与复用。
//!
//! 本模块通过封闭请求类型选择受信任页面和窗口定义。辅助窗口在逻辑和生命周期上
//! 从属于当前 Workspace，但保持独立原生层级，不拥有第二套运行时，也不恢复位置或尺寸。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const AUXILIARY_OPEN_EVENT: &str = "terax:auxiliary-open";

const SETTINGS_LABEL: &str = "auxiliary-settings";
const FILE_PROPERTIES_LABEL: &str = "auxiliary-file-properties";
const AUXILIARY_ENTRY: &str = "auxiliary.html";
const SOURCE_POINT_OFFSET: f64 = 16.0;
const MONITOR_EDGE_MARGIN: i32 = 12;

static AUXILIARY_WINDOW_LOCK: Mutex<()> = Mutex::new(());

/// 主 WebView 内的逻辑坐标，仅作为原生窗口首次定位的来源提示。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuxiliarySourcePoint {
    pub x: f64,
    pub y: f64,
}

/// 带单调版本的辅助窗口打开请求。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuxiliaryOpenEnvelope {
    pub revision: u64,
    pub request: OpenAuxiliaryWindowRequest,
}

/// 保存各单例辅助窗口最近一次打开请求，避免页面挂载与复用事件之间丢失目标。
pub struct AuxiliaryWindowState {
    next_revision: AtomicU64,
    latest: Mutex<HashMap<String, AuxiliaryOpenEnvelope>>,
}

impl Default for AuxiliaryWindowState {
    fn default() -> Self {
        Self {
            next_revision: AtomicU64::new(1),
            latest: Mutex::new(HashMap::new()),
        }
    }
}

impl AuxiliaryWindowState {
    fn record(&self, label: &str, request: OpenAuxiliaryWindowRequest) -> AuxiliaryOpenEnvelope {
        let envelope = AuxiliaryOpenEnvelope {
            revision: self.next_revision.fetch_add(1, Ordering::Relaxed),
            request,
        };
        self.latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(label.to_string(), envelope.clone());
        envelope
    }

    fn latest(&self, label: &str) -> Option<AuxiliaryOpenEnvelope> {
        self.latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(label)
            .cloned()
    }
}

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
    /// 个人消息连接管理页。
    Channels,
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
            Self::Channels => "channels",
            Self::Remote => "remote",
            Self::About => "about",
        }
    }
}

/// 受支持的辅助窗口打开请求。
///
/// 枚举同时作为 IPC 和窗口重用事件的协议，未知类型、字段或设置分区会在进入
/// 窗口创建逻辑前被 serde 拒绝。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OpenAuxiliaryWindowRequest {
    Settings {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<SettingsTab>,
    },
    FileProperties {
        path: String,
        #[serde(
            rename = "sourcePoint",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_point: Option<AuxiliarySourcePoint>,
    },
}

/// 辅助窗口首次创建时的位置策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuxiliaryWindowPlacement {
    MainWindowCenter,
    MonitorCenter,
    NearSourcePoint,
}

/// 辅助窗口与 Workspace 主窗口之间的原生层级关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuxiliaryWindowLevel {
    Independent,
    AboveWorkspace,
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
    level: AuxiliaryWindowLevel,
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
                placement: AuxiliaryWindowPlacement::MainWindowCenter,
                level: AuxiliaryWindowLevel::AboveWorkspace,
            },
            Self::FileProperties { .. } => AuxiliaryWindowDefinition {
                label: FILE_PROPERTIES_LABEL,
                width: 420.0,
                height: 520.0,
                min_width: 400.0,
                min_height: 480.0,
                resizable: true,
                minimizable: false,
                maximizable: false,
                placement: AuxiliaryWindowPlacement::NearSourcePoint,
                level: AuxiliaryWindowLevel::Independent,
            },
        }
    }

    fn initial_url(&self) -> String {
        match self {
            Self::Settings { tab: Some(tab) } => {
                format!("{AUXILIARY_ENTRY}?tab={}", tab.as_str())
            }
            Self::Settings { tab: None } => AUXILIARY_ENTRY.to_string(),
            Self::FileProperties { .. } => AUXILIARY_ENTRY.to_string(),
        }
    }

    fn source_point(&self) -> Option<AuxiliarySourcePoint> {
        match self {
            Self::FileProperties { source_point, .. } => *source_point,
            Self::Settings { .. } => None,
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
    state: tauri::State<'_, AuxiliaryWindowState>,
) -> Result<(), String> {
    let _open_guard = AUXILIARY_WINDOW_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let definition = request.definition();
    let source_point = request.source_point();
    let envelope = state.record(definition.label, request.clone());

    if let Some(window) = app.get_webview_window(definition.label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        window
            .emit(AUXILIARY_OPEN_EVENT, envelope)
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
        .visible(false);
    let builder = match definition.level {
        AuxiliaryWindowLevel::Independent => builder,
        AuxiliaryWindowLevel::AboveWorkspace => {
            builder.parent(&main).map_err(|error| error.to_string())?
        }
    };

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

    place_window(&window, &main, definition.placement, source_point);
    Ok(())
}

/// 返回当前辅助窗口最近一次经过原生层验证的打开请求。
#[tauri::command]
pub fn get_auxiliary_window_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AuxiliaryWindowState>,
) -> Result<AuxiliaryOpenEnvelope, String> {
    let label = window.label();
    if !label.starts_with("auxiliary-") {
        return Err("当前窗口不是辅助窗口".into());
    }
    state
        .latest(label)
        .ok_or_else(|| format!("辅助窗口 {label} 尚无打开请求"))
}

/// 主窗口销毁后关闭本进程的所有辅助窗口，避免独立原生窗口阻止进程退出。
pub fn destroy_all_auxiliary_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("auxiliary-") {
            if let Err(error) = window.destroy() {
                log::warn!("cannot destroy auxiliary window {label}: {error}");
            }
        }
    }
}

/// 按静态策略设置辅助窗口的首次位置。
///
/// 主窗口尺寸读取失败时退回显示器居中，避免因定位失败而阻止窗口打开。
fn place_window(
    window: &WebviewWindow,
    main: &WebviewWindow,
    placement: AuxiliaryWindowPlacement,
    source_point: Option<AuxiliarySourcePoint>,
) {
    match placement {
        AuxiliaryWindowPlacement::MonitorCenter => {
            let _ = window.center();
        }
        AuxiliaryWindowPlacement::MainWindowCenter => {
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
        AuxiliaryWindowPlacement::NearSourcePoint => {
            if place_near_source(window, main, source_point).is_err() {
                place_window(
                    window,
                    main,
                    AuxiliaryWindowPlacement::MainWindowCenter,
                    None,
                );
            }
        }
    }
}

/// 将来源点转换到屏幕物理坐标，并把窗口限制在对应显示器工作区内。
fn place_near_source(
    window: &WebviewWindow,
    main: &WebviewWindow,
    source_point: Option<AuxiliarySourcePoint>,
) -> Result<(), String> {
    let point = source_point.ok_or_else(|| "missing source point".to_string())?;
    if !point.x.is_finite() || !point.y.is_finite() || point.x < 0.0 || point.y < 0.0 {
        return Err("invalid source point".into());
    }
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let main_size = main.inner_size().map_err(|error| error.to_string())?;
    let max_x = main_size.width as f64 / scale;
    let max_y = main_size.height as f64 / scale;
    if point.x > max_x || point.y > max_y {
        return Err("source point is outside the main window".into());
    }
    let main_position = main.inner_position().map_err(|error| error.to_string())?;
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let anchor_x = main_position.x + (point.x * scale).round() as i32;
    let anchor_y = main_position.y + (point.y * scale).round() as i32;
    let offset = (SOURCE_POINT_OFFSET * scale).round() as i32;
    let monitors = main
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            anchor_x >= area.position.x
                && anchor_y >= area.position.y
                && anchor_x < area.position.x.saturating_add_unsigned(area.size.width)
                && anchor_y < area.position.y.saturating_add_unsigned(area.size.height)
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitor is available".to_string())?;
    let area = monitor.work_area();
    let min_x = area.position.x.saturating_add(MONITOR_EDGE_MARGIN);
    let min_y = area.position.y.saturating_add(MONITOR_EDGE_MARGIN);
    let max_x = area
        .position
        .x
        .saturating_add_unsigned(area.size.width)
        .saturating_sub(window_size.width as i32)
        .saturating_sub(MONITOR_EDGE_MARGIN);
    let max_y = area
        .position
        .y
        .saturating_add_unsigned(area.size.height)
        .saturating_sub(window_size.height as i32)
        .saturating_sub(MONITOR_EDGE_MARGIN);
    let x = anchor_x
        .saturating_add(offset)
        .clamp(min_x, max_x.max(min_x));
    let y = anchor_y
        .saturating_add(offset)
        .clamp(min_y, max_y.max(min_y));
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auxiliary_capability_allows_focus_and_window_close_lifecycle() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/auxiliary.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();

        assert!(permissions
            .iter()
            .any(|value| value == "core:window:allow-close"));
        assert!(permissions
            .iter()
            .any(|value| value == "core:window:allow-destroy"));
        assert!(permissions
            .iter()
            .any(|value| value == "core:window:allow-set-focus"));
    }

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
        assert_eq!(
            definition.placement,
            AuxiliaryWindowPlacement::MainWindowCenter
        );
        assert_eq!(definition.level, AuxiliaryWindowLevel::AboveWorkspace);
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
        assert!(serde_json::from_str::<OpenAuxiliaryWindowRequest>(
            r#"{"kind":"file-properties","path":"/work/file","sourcePoint":{"x":12,"y":24}}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<OpenAuxiliaryWindowRequest>(
            r#"{"kind":"file-properties","path":"/work/file","source_point":{"x":12,"y":24}}"#
        )
        .is_err());
    }

    #[test]
    fn file_properties_uses_singleton_near_source_definition() {
        let request = OpenAuxiliaryWindowRequest::FileProperties {
            path: "/workspace/src/main.rs".into(),
            source_point: Some(AuxiliarySourcePoint { x: 42.0, y: 84.0 }),
        };
        let definition = request.definition();

        assert_eq!(definition.label, "auxiliary-file-properties");
        assert_eq!((definition.width, definition.height), (420.0, 520.0));
        assert_eq!(
            (definition.min_width, definition.min_height),
            (400.0, 480.0)
        );
        assert_eq!(
            definition.placement,
            AuxiliaryWindowPlacement::NearSourcePoint
        );
        assert_eq!(definition.level, AuxiliaryWindowLevel::Independent);
        assert_eq!(request.initial_url(), "auxiliary.html");
        assert_eq!(
            request.source_point(),
            Some(AuxiliarySourcePoint { x: 42.0, y: 84.0 })
        );
    }

    #[test]
    fn latest_request_uses_monotonic_revisions_per_window() {
        let state = AuxiliaryWindowState::default();
        let first = state.record(
            FILE_PROPERTIES_LABEL,
            OpenAuxiliaryWindowRequest::FileProperties {
                path: "/first".into(),
                source_point: None,
            },
        );
        let second = state.record(
            FILE_PROPERTIES_LABEL,
            OpenAuxiliaryWindowRequest::FileProperties {
                path: "/second".into(),
                source_point: None,
            },
        );

        assert!(second.revision > first.revision);
        assert_eq!(state.latest(FILE_PROPERTIES_LABEL), Some(second));
    }
}
