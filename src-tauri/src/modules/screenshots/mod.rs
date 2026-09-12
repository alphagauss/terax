//! 每个 Workspace 进程拥有独立的本机截图流水线。
//!
//! 默认 Local 进程独占全局快捷键，所有 Workspace 均可手动截图。原生层管理屏幕选择、
//! 会话与导出，截图窗口按需创建并在结束时销毁，WebView 只编辑本进程当前会话的图片。

mod model;

use crate::modules::{
    shared_store, storage, workspace::WorkspaceEnv, workspace_process::WorkspaceProcessState,
};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ImageEncoder,
};
use model::{Config, ConfigPatch, Frame, Session};
use serde::Serialize;
use std::{
    io::Cursor,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Listener, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const LABEL: &str = "screenshot";
const EVENT: &str = "terax:screenshot-changed";
const MAX_PNG_BYTES: usize = 210_000_000;

#[derive(Default)]
struct Runtime {
    registered: Option<Shortcut>,
    // 全局快捷键注册错误与手动截图结果分开，后者由调用页面显示。
    error: Option<String>,
    session: Option<Session>,
    disposing: bool,
    stopped: bool,
    settings_listener: Option<tauri::EventId>,
}

/// 状态只属于当前原生宿主；页面关闭或卸载不会中断已经开始的保存。
#[derive(Default)]
pub struct ScreenshotState(Mutex<Runtime>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    global_shortcut_owner: bool,
    config: Config,
    registered: bool,
    error: Option<String>,
}

fn owns_global_shortcut(app: &tauri::AppHandle) -> bool {
    let process = app.state::<WorkspaceProcessState>();
    let bootstrap = process.bootstrap();
    model::owns_global_shortcut(
        bootstrap.is_primary,
        matches!(bootstrap.env, WorkspaceEnv::Local),
    )
}

fn authorize(window: &WebviewWindow, overlay: bool) -> Result<(), String> {
    let allowed = model::allows_caller(window.label(), overlay);
    if !allowed {
        return Err("SCREENSHOT_UNAVAILABLE".into());
    }
    Ok(())
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit_to("auxiliary-settings", EVENT, ());
}

fn fail(app: &tauri::AppHandle, error: String) {
    log::warn!("screenshot: {error}");
    let message = if language() == "zh-CN" {
        "截图失败，请检查系统屏幕录制权限；全局按键可在快捷键设置中调整。"
    } else {
        "Screenshot failed. Check screen capture permission; the global key binding is in Shortcuts settings."
    };
    app.dialog().message(message).title("Terax").show(|_| {});
}

fn read_config() -> Result<Config, String> {
    shared_store::shared_store_read("settings".into()).map(|values| Config::from_map(&values))
}

/// 复用共享配置通知；仅默认 Local 进程订阅并更新系统快捷键，不创建截图窗口。
pub fn initialize(app: &tauri::AppHandle) {
    if !owns_global_shortcut(app) {
        return;
    }
    let handle = app.clone();
    let listener = app.listen("terax://shared-store-changed", move |event| {
        let settings_changed = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .is_some_and(|value| value["store"] == "settings");
        if settings_changed {
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || refresh_shortcut(&app));
        }
    });
    app.state::<ScreenshotState>()
        .0
        .lock()
        .unwrap()
        .settings_listener = Some(listener);
    refresh_shortcut(app);
}

/// 每次通知都读取最新值，避免两个窗口交错修改时应用过时的配置快照。
fn refresh_shortcut(app: &tauri::AppHandle) {
    let result = read_config().and_then(|config| sync_shortcut(app, &config));
    let error = result.err();
    if let Some(error) = &error {
        log::warn!("screenshot shortcut: {error}");
    }
    app.state::<ScreenshotState>().0.lock().unwrap().error = error;
    changed(app);
}

fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    let shortcut = value
        .parse::<Shortcut>()
        .map_err(|_| "SCREENSHOT_SHORTCUT_INVALID")?;
    if shortcut.mods.is_empty() {
        return Err("SCREENSHOT_SHORTCUT_INVALID".into());
    }
    Ok(shortcut)
}

fn register_shortcut(app: &tauri::AppHandle, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = begin(&app).await {
                        if error != "SCREENSHOT_BUSY" {
                            fail(&app, error);
                        }
                    }
                });
            }
        })
        .map_err(|error| format!("SCREENSHOT_SHORTCUT_FAILED: {error}"))
}

/// 注册失败保留共享偏好并显示错误，不把另一窗口的设置回滚成旧值。
fn sync_shortcut(app: &tauri::AppHandle, config: &Config) -> Result<(), String> {
    if !owns_global_shortcut(app) {
        return Ok(());
    }
    let desired = if config.global_shortcut_enabled {
        Some(parse_shortcut(&config.shortcut)?)
    } else {
        None
    };
    let state = app.state::<ScreenshotState>();
    let mut runtime = state.0.lock().unwrap();
    if runtime.stopped || runtime.registered == desired {
        return Ok(());
    }
    if let Some(previous) = runtime.registered {
        app.global_shortcut()
            .unregister(previous)
            .map_err(|error| error.to_string())?;
        runtime.registered = None;
    }
    if let Some(shortcut) = desired {
        register_shortcut(app, shortcut)?;
        runtime.registered = Some(shortcut);
    }
    Ok(())
}

/// 窗口操作固定在事件循环线程，避免在快捷键线程同步创建 WebView 导致死锁。
async fn ensure_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        {
            let state = handle.state::<ScreenshotState>();
            let runtime = state.0.lock().unwrap();
            if handle.get_webview_window("main").is_none()
                || runtime.stopped
                || runtime.session.is_none()
            {
                let _ = sender.send(Err("SCREENSHOT_EXPIRED".into()));
                return;
            }
        }
        let result = WebviewWindowBuilder::new(
            &handle,
            LABEL,
            tauri::WebviewUrl::App("screenshot.html".into()),
        )
        .title("Terax")
        .visible(false)
        .focused(false)
        .decorations(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .disable_drag_drop_handler()
        .inner_size(800.0, 600.0)
        .build()
        .map_err(|error| error.to_string());
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Ok(window) = &result {
            if let Err(error) = disable_window_transitions(window) {
                log::warn!("screenshot window transitions: {error}");
            }
        }
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

/// 在首次显示前仅禁用截图窗口的系统过渡，避免冻结桌面随窗口缩放。
#[cfg(target_os = "windows")]
fn disable_window_transitions(window: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let disabled: i32 = 1;
    // DWM 要求传入四字节 BOOL；窗口仍存活，属性值在同步调用期间有效。
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            (&disabled as *const i32).cast(),
            std::mem::size_of_val(&disabled) as u32,
        )
    };
    if result < 0 {
        return Err(format!("DwmSetWindowAttribute failed: {result:#010x}"));
    }
    Ok(())
}

/// 仅在创建窗口的主线程调用，在首次显示前关闭 AppKit 自动进出动画。
#[cfg(target_os = "macos")]
fn disable_window_transitions(window: &WebviewWindow) -> Result<(), String> {
    use objc2::{msg_send, runtime::AnyObject};

    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    // NSWindowAnimationBehaviorNone = 2，底层类型 NSInteger 与 isize 对应。
    const ANIMATION_BEHAVIOR_NONE: isize = 2;
    // Tauri 返回存活的 NSWindow；当前仍在创建窗口的主线程闭包内。
    unsafe {
        let _: () =
            msg_send![ns_window.cast::<AnyObject>(), setAnimationBehavior: ANIMATION_BEHAVIOR_NONE];
    }
    Ok(())
}

fn language() -> String {
    shared_store::shared_store_read("settings".into())
        .ok()
        .and_then(|map| {
            map.get("language")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .filter(|language| language == "zh-CN")
        .unwrap_or_else(|| "en".into())
}

async fn begin(app: &tauri::AppHandle) -> Result<(), String> {
    // Wayland 无法可靠定位全局覆盖窗口，明确关闭这条交互路径。
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Err("SCREENSHOT_WAYLAND_UNSUPPORTED".into());
    }
    let started = Instant::now();
    let token = uuid::Uuid::new_v4().to_string();
    {
        let state = app.state::<ScreenshotState>();
        let mut runtime = state.0.lock().unwrap();
        if runtime.stopped {
            return Err("SCREENSHOT_UNAVAILABLE".into());
        }
        if runtime.session.is_some() || runtime.disposing {
            return Err("SCREENSHOT_BUSY".into());
        }
        runtime.session = Some(Session {
            frame: Frame {
                token: token.clone(),
                width: 0,
                height: 0,
                language: language(),
            },
            png: None,
            started,
            capture_ms: 0,
            encode_ms: 0,
            presented: false,
            exporting: false,
        });
    }
    let result = prepare(app, &token).await;
    if result.is_err() {
        finish(app, &token, false).await?;
    } else {
        // 页面加载失败不能永久占用截图会话。
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let pending = handle
                .state::<ScreenshotState>()
                .0
                .lock()
                .unwrap()
                .session
                .as_ref()
                .is_some_and(|session| session.frame.token == token && !session.presented);
            if pending {
                let _ = finish(&handle, &token, false).await;
                fail(&handle, "SCREENSHOT_LOAD_FAILED".into());
            }
        });
    }
    result
}

async fn prepare(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    // Tao 的 macOS 光标按主屏比例返回物理坐标，CoreGraphics 选屏使用全局逻辑坐标。
    #[cfg(target_os = "macos")]
    let cursor = cursor.to_logical::<f64>(
        app.primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or("SCREENSHOT_MONITOR_MISSING")?
            .scale_factor(),
    );
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(|error| error.to_string())?
        .ok_or("SCREENSHOT_MONITOR_MISSING")?;
    let position = *monitor.position();
    let size = *monitor.size();
    // macOS 按窗口当前屏幕比例解释物理坐标，跨不同缩放屏幕时直接使用目标屏逻辑坐标。
    #[cfg(target_os = "macos")]
    let (position, size) = (
        position.to_logical::<f64>(monitor.scale_factor()),
        size.to_logical::<f64>(monitor.scale_factor()),
    );
    let capture_point = (cursor.x as i32, cursor.y as i32);
    let (png, width, height, capture_ms, encode_ms) =
        tauri::async_runtime::spawn_blocking(move || {
            let started = Instant::now();
            let screen = xcap::Monitor::from_point(capture_point.0, capture_point.1)
                .map_err(|error| error.to_string())?;
            model::validate_dimensions(
                screen.width().map_err(|e| e.to_string())?,
                screen.height().map_err(|e| e.to_string())?,
                (u32::MAX, u32::MAX),
            )?;
            let image = screen.capture_image().map_err(|error| error.to_string())?;
            let capture_ms = started.elapsed().as_millis() as u64;
            let encoding = Instant::now();
            let (width, height) = image.dimensions();
            model::validate_dimensions(width, height, (u32::MAX, u32::MAX))?;
            let mut png = Vec::new();
            // 固定 Sub 滤波避免每行尝试五种预测器，降低高分辨率截图的编码延迟。
            PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
                .write_image(
                    image.as_raw(),
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((
                png,
                width,
                height,
                capture_ms,
                encoding.elapsed().as_millis() as u64,
            ))
        })
        .await
        .map_err(|error| error.to_string())??;
    let window = ensure_window(app).await?;
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    window.set_size(size).map_err(|error| error.to_string())?;
    {
        let state = app.state::<ScreenshotState>();
        let mut runtime = state.0.lock().unwrap();
        let session = runtime.session.as_mut().ok_or("SCREENSHOT_EXPIRED")?;
        session.check_token(token)?;
        session.frame.width = width;
        session.frame.height = height;
        session.png = Some(png);
        session.capture_ms = capture_ms;
        session.encode_ms = encode_ms;
    }
    window.emit(EVENT, ()).map_err(|error| error.to_string())?;
    Ok(())
}

/// 在事件循环线程销毁窗口，销毁回调执行期间不持有运行时锁。
async fn finish(app: &tauri::AppHandle, token: &str, exporting: bool) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let token = token.to_owned();
    app.run_on_main_thread(move || {
        let result = finish_session(
            &handle.state::<ScreenshotState>(),
            &token,
            exporting,
            || {
                if let Some(window) = handle.get_webview_window(LABEL) {
                    window.destroy().map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        );
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

/// 先移除会话并封闭重复启动，再释放锁调用可能重入的原生窗口销毁。
fn finish_session(
    state: &ScreenshotState,
    token: &str,
    exporting: bool,
    destroy: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut runtime = state.0.lock().unwrap();
    let session = runtime.session.as_ref().ok_or("SCREENSHOT_EXPIRED")?;
    session.check_token(token)?;
    if session.exporting && !exporting {
        return Err("SCREENSHOT_BUSY".into());
    }
    let session = runtime.session.take();
    runtime.disposing = true;
    drop(runtime);
    let result = destroy();
    let mut runtime = state.0.lock().unwrap();
    if result.is_err() && !runtime.stopped {
        // 原生销毁失败时保留编辑内容，并允许用户再次取消或导出。
        runtime.session = session.map(|mut session| {
            session.exporting = false;
            session
        });
    }
    runtime.disposing = false;
    result
}

#[tauri::command]
pub fn screenshot_status(window: WebviewWindow) -> Result<Status, String> {
    authorize(&window, false)?;
    let config = read_config()?;
    let state = window.state::<ScreenshotState>();
    let runtime = state.0.lock().unwrap();
    Ok(Status {
        global_shortcut_owner: owns_global_shortcut(window.app_handle()),
        config,
        registered: runtime.registered.is_some(),
        error: runtime.error.clone(),
    })
}

/// 所有 Workspace 都可修改共享偏好，只写请求中明确变更的字段。
#[tauri::command]
pub async fn screenshot_configure(window: WebviewWindow, patch: ConfigPatch) -> Result<(), String> {
    authorize(&window, false)?;
    if let Some(shortcut) = &patch.shortcut {
        parse_shortcut(shortcut)?;
    }
    shared_store::shared_store_mutate(
        window.app_handle().clone(),
        "settings".into(),
        patch.into_mutations(),
    )
}

#[tauri::command]
pub async fn screenshot_start(window: WebviewWindow) -> Result<(), String> {
    authorize(&window, false)?;
    begin(window.app_handle()).await
}

/// 页面先订阅再读取，避免窗口加载与采集完成的先后顺序导致漏读。
#[tauri::command]
pub fn screenshot_frame(window: WebviewWindow) -> Result<Option<Frame>, String> {
    authorize(&window, true)?;
    let state = window.state::<ScreenshotState>();
    let runtime = state.0.lock().unwrap();
    Ok(runtime
        .session
        .as_ref()
        .filter(|session| session.frame.width > 0)
        .map(|session| session.frame.clone()))
}

#[tauri::command]
pub fn screenshot_image(
    window: WebviewWindow,
    token: String,
) -> Result<tauri::ipc::Response, String> {
    authorize(&window, true)?;
    let state = window.state::<ScreenshotState>();
    let mut runtime = state.0.lock().unwrap();
    let session = runtime.session.as_mut().ok_or("SCREENSHOT_EXPIRED")?;
    session.check_token(&token)?;
    Ok(tauri::ipc::Response::new(
        session.png.take().ok_or("SCREENSHOT_EXPIRED")?,
    ))
}

/// 编辑器报告图片已加载后才显示覆盖窗口；计时包含原生显示与聚焦调用。
#[tauri::command]
pub fn screenshot_present(window: WebviewWindow, token: String) -> Result<(), String> {
    authorize(&window, true)?;
    let state = window.state::<ScreenshotState>();
    let mut runtime = state.0.lock().unwrap();
    let session = runtime.session.as_mut().ok_or("SCREENSHOT_EXPIRED")?;
    session.check_token(&token)?;
    if session.presented {
        return Ok(());
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    session.presented = true;
    log::debug!(
        "screenshot ready: capture={}ms encode={}ms total={}ms",
        session.capture_ms,
        session.encode_ms,
        session.started.elapsed().as_millis()
    );
    Ok(())
}

#[tauri::command]
pub async fn screenshot_cancel(window: WebviewWindow, token: String) -> Result<(), String> {
    authorize(&window, true)?;
    finish(window.app_handle(), &token, false).await
}

/// PNG 通过二进制请求传入；原生验证会话和像素上界，保存路径只能来自系统对话框。
#[tauri::command]
pub async fn screenshot_export(
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    authorize(&window, true)?;
    let token = request
        .headers()
        .get("x-screenshot-token")
        .and_then(|v| v.to_str().ok())
        .ok_or("SCREENSHOT_EXPIRED")?
        .to_owned();
    let action = request
        .headers()
        .get("x-screenshot-action")
        .and_then(|v| v.to_str().ok())
        .ok_or("SCREENSHOT_IMAGE_INVALID")?
        .to_owned();
    if !matches!(action.as_str(), "copy" | "save") {
        return Err("SCREENSHOT_IMAGE_INVALID".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("SCREENSHOT_IMAGE_INVALID".into());
    };
    if bytes.len() > MAX_PNG_BYTES {
        return Err("SCREENSHOT_IMAGE_INVALID".into());
    }
    let bytes = bytes.clone();
    let (source, language) = {
        let state = window.state::<ScreenshotState>();
        let mut runtime = state.0.lock().unwrap();
        let session = runtime.session.as_mut().ok_or("SCREENSHOT_EXPIRED")?;
        session.check_token(&token)?;
        if !session.presented || session.exporting {
            return Err("SCREENSHOT_BUSY".into());
        }
        session.exporting = true;
        (
            (session.frame.width, session.frame.height),
            session.frame.language.clone(),
        )
    };
    let target = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let dimensions =
            image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png)
                .into_dimensions()
                .map_err(|_| "SCREENSHOT_IMAGE_INVALID")?;
        model::validate_dimensions(dimensions.0, dimensions.1, source)?;
        if action == "copy" {
            let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                .map_err(|_| "SCREENSHOT_IMAGE_INVALID")?
                .into_rgba8();
            target
                .clipboard()
                .write_image(&tauri::image::Image::new_owned(
                    image.into_raw(),
                    dimensions.0,
                    dimensions.1,
                ))
                .map_err(|error| error.to_string())?;
        } else {
            let title = if language == "zh-CN" {
                "保存截图"
            } else {
                "Save screenshot"
            };
            let Some(path) = target
                .dialog()
                .file()
                .set_parent(&target)
                .set_title(title)
                .add_filter("PNG", &["png"])
                .set_file_name("screenshot.png")
                .blocking_save_file()
            else {
                return Ok(false);
            };
            let path = path.into_path().map_err(|error| error.to_string())?;
            storage::write_atomic(&path, &bytes).map_err(|error| error.to_string())?;
        }
        Ok::<_, String>(true)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if matches!(result, Ok(true)) {
        finish(window.app_handle(), &token, true).await?;
    } else {
        let state = window.state::<ScreenshotState>();
        let mut runtime = state.0.lock().unwrap();
        if let Some(session) = runtime
            .session
            .as_mut()
            .filter(|session| session.frame.token == token)
        {
            session.exporting = false;
        }
    }
    result
}

/// 所属 Workspace 销毁时关闭截图窗口并解除原生订阅。
pub fn shutdown(app: &tauri::AppHandle) {
    {
        let state = app.state::<ScreenshotState>();
        let mut runtime = state.0.lock().unwrap();
        runtime.stopped = true;
        runtime.session = None;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    let listener = app
        .state::<ScreenshotState>()
        .0
        .lock()
        .unwrap()
        .settings_listener
        .take();
    if let Some(listener) = listener {
        app.unlisten(listener);
    }
    if owns_global_shortcut(app) {
        let _ = app.global_shortcut().unregister_all();
    }
}

pub fn window_destroyed(app: &tauri::AppHandle) {
    let state = app.state::<ScreenshotState>();
    let mut runtime = state.0.lock().unwrap();
    runtime.session = None;
}

/// 系统关闭请求按取消处理；保存对话框未结束时保持会话，避免丢失失败重试的编辑内容。
pub fn close_requested(app: &tauri::AppHandle) {
    let token = app
        .state::<ScreenshotState>()
        .0
        .lock()
        .unwrap()
        .session
        .as_ref()
        .filter(|session| !session.exporting)
        .map(|session| session.frame.token.clone());
    if let Some(token) = token {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = finish(&app, &token, false).await;
        });
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn active_state(exporting: bool) -> ScreenshotState {
        ScreenshotState(Mutex::new(Runtime {
            session: Some(Session {
                frame: Frame {
                    token: "current".into(),
                    width: 1,
                    height: 1,
                    language: "en".into(),
                },
                png: Some(vec![1]),
                started: Instant::now(),
                capture_ms: 0,
                encode_ms: 0,
                presented: true,
                exporting,
            }),
            ..Default::default()
        }))
    }

    #[test]
    fn completion_destroys_window_without_locking_out_reentrant_callbacks() {
        let state = active_state(false);
        finish_session(&state, "current", false, || {
            let runtime = state
                .0
                .try_lock()
                .expect("window callbacks must acquire state lock");
            assert!(runtime.disposing);
            assert!(runtime.session.is_none());
            Ok(())
        })
        .unwrap();
        assert!(!state.0.lock().unwrap().disposing);
    }

    #[test]
    fn stale_or_busy_cancellation_does_not_destroy_current_editor() {
        let state = active_state(true);
        assert!(finish_session(&state, "old", false, || panic!("stale session")).is_err());
        assert!(finish_session(&state, "current", false, || panic!("saving session")).is_err());
        assert!(state.0.lock().unwrap().session.is_some());
        finish_session(&state, "current", true, || Ok(())).unwrap();
        assert!(state.0.lock().unwrap().session.is_none());
    }

    #[test]
    fn failed_destruction_preserves_session_for_retry() {
        let state = active_state(true);
        assert!(finish_session(&state, "current", true, || Err("destroy failed".into())).is_err());
        {
            let runtime = state.0.lock().unwrap();
            assert!(!runtime.disposing);
            let session = runtime.session.as_ref().unwrap();
            assert_eq!(session.frame.token, "current");
            assert!(!session.exporting);
        }
        finish_session(&state, "current", false, || Ok(())).unwrap();
        assert!(state.0.lock().unwrap().session.is_none());
    }
}
