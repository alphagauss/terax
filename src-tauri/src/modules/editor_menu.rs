//! Windows 编辑菜单的原生命令委托。COM 对象只在 UI 线程访问，按窗口和前端连接隔离。
//! 原生端拥有 deferral；选择、取消、超时、导航和窗口销毁均结束请求。

use serde::Serialize;
use std::{cell::RefCell, collections::HashMap};
use tauri::{Emitter, EventTarget};
use webview2_com::{
    CoTaskMemPWSTR, ContextMenuRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral, ICoreWebView2_11,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    },
    NavigationStartingEventHandler,
};
use windows::core::{Interface, BOOL, PWSTR};

#[derive(Clone, Serialize)]
struct Item {
    id: i32,
    name: String,
    shortcut: String,
    enabled: bool,
}
#[derive(Clone, Serialize)]
struct Menu {
    id: String,
    connection: String,
    items: Vec<Item>,
}
impl Menu {
    fn permits(&self, id: &str, command: Option<i32>) -> bool {
        self.id == id
            && command.is_none_or(|id| self.items.iter().any(|item| item.id == id && item.enabled))
    }
}
struct Pending {
    menu: Menu,
    args: ICoreWebView2ContextMenuRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    timeout_cancel: tokio::sync::oneshot::Sender<()>,
}
struct Connection {
    id: String,
    webview: ICoreWebView2_11,
    menu_token: i64,
    navigation_token: i64,
    pending: Option<Pending>,
}
thread_local! {
    static CONNECTIONS: RefCell<HashMap<String, Connection>> = RefCell::new(HashMap::new());
}

fn check_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" || super::auxiliary_window::is_registered_label(window.label()) {
        Ok(())
    } else {
        Err("window does not support editor menus".into())
    }
}
fn com_string(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut raw = PWSTR::null();
    let result = read(&mut raw);
    let value = CoTaskMemPWSTR::from(raw);
    result?;
    Ok(value.to_string())
}
fn same_document(left: &str, right: &str) -> bool {
    let (Ok(mut left), Ok(mut right)) = (tauri::Url::parse(left), tauri::Url::parse(right)) else {
        return false;
    };
    left.set_fragment(None);
    right.set_fragment(None);
    left == right
}
fn complete(pending: Pending, command: Option<i32>, restore_native: bool) -> Result<(), String> {
    drop(pending.timeout_cancel);
    unsafe {
        let selected = if restore_native {
            pending.args.SetHandled(false)
        } else {
            command
                .map(|id| pending.args.SetSelectedCommandId(id))
                .transpose()
                .map(|_| ())
        };
        let completed = pending.deferral.Complete();
        selected.and(completed).map_err(|error| error.to_string())
    }
}
fn take_pending(label: &str, connection: &str, id: Option<&str>) -> Option<Pending> {
    CONNECTIONS.with(|states| {
        let mut states = states.borrow_mut();
        let state = states.get_mut(label)?;
        if state.id != connection
            || id.is_some_and(|id| {
                state
                    .pending
                    .as_ref()
                    .is_none_or(|pending| pending.menu.id != id)
            })
        {
            return None;
        }
        state.pending.take()
    })
}
fn dismiss(window: &tauri::WebviewWindow, connection: &str, id: Option<&str>) {
    if let Some(pending) = take_pending(window.label(), connection, id) {
        let _ = window.emit_to(
            EventTarget::webview_window(window.label()),
            "editor-menu-closed",
            &pending.menu,
        );
        if let Err(error) = complete(pending, None, false) {
            log::warn!("取消编辑菜单失败: {error}");
        }
    }
}
fn disconnect(label: &str, connection: Option<&str>) -> Result<(), String> {
    let state = CONNECTIONS.with(|states| {
        let mut states = states.borrow_mut();
        if connection.is_some_and(|id| states.get(label).is_none_or(|state| state.id != id)) {
            return None;
        }
        states.remove(label)
    });
    if let Some(state) = state {
        let menu_removed = unsafe { state.webview.remove_ContextMenuRequested(state.menu_token) };
        let navigation_removed = unsafe {
            state
                .webview
                .remove_NavigationStarting(state.navigation_token)
        };
        let completed = state
            .pending
            .map(|pending| complete(pending, None, false))
            .transpose();
        menu_removed.map_err(|error| error.to_string())?;
        navigation_removed.map_err(|error| error.to_string())?;
        completed?;
    }
    Ok(())
}

/// 在主事件循环销毁窗口时释放该窗口的 COM 监听与未完成菜单。
pub fn window_destroyed(label: &str) {
    if let Err(error) = disconnect(label, None) {
        log::warn!("释放编辑菜单失败: {error}");
    }
}

unsafe fn requested(
    window: &tauri::WebviewWindow,
    connection: &str,
    args: ICoreWebView2ContextMenuRequestedEventArgs,
) -> windows::core::Result<()> {
    let target = args.ContextMenuTarget()?;
    let page = com_string(|value| target.PageUri(value))?;
    let frame = com_string(|value| target.FrameUri(value))?;
    let app = window.url().map(|url| url.to_string()).unwrap_or_default();
    // WebView2 对顶层输入框也可能将 IsRequestedForMainFrame 报为 false，使用实际文档地址。
    if !same_document(&page, &app) || !same_document(&frame, &app) {
        return Ok(());
    }
    let collection = args.MenuItems()?;
    let mut count = 0;
    collection.Count(&mut count)?;
    let mut items = Vec::new();
    for index in 0..count {
        let item = collection.GetValueAtIndex(index)?;
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND;
        item.Kind(&mut kind)?;
        if kind != COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND {
            continue;
        }
        let name = com_string(|value| item.Name(value))?;
        if !matches!(
            name.as_str(),
            "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
        ) {
            continue;
        }
        let mut id = 0;
        let mut enabled = BOOL::default();
        item.CommandId(&mut id)?;
        item.IsEnabled(&mut enabled)?;
        items.push(Item {
            id,
            name,
            enabled: enabled.as_bool(),
            shortcut: com_string(|value| item.ShortcutKeyDescription(value))?,
        });
    }
    if items.is_empty() {
        return Ok(());
    }
    dismiss(window, connection, None);
    let menu = Menu {
        id: uuid::Uuid::new_v4().to_string(),
        connection: connection.to_owned(),
        items,
    };
    let deferral = args.GetDeferral()?;
    if let Err(error) = args.SetHandled(true) {
        let _ = deferral.Complete();
        return Err(error);
    }
    let (timeout_cancel, cancelled) = tokio::sync::oneshot::channel();
    let pending = Pending {
        menu: menu.clone(),
        args,
        deferral,
        timeout_cancel,
    };
    let unused = CONNECTIONS.with(|states| {
        let mut states = states.borrow_mut();
        if let Some(state) = states
            .get_mut(window.label())
            .filter(|state| state.id == connection)
        {
            state.pending = Some(pending);
            None
        } else {
            Some(pending)
        }
    });
    if let Some(pending) = unused {
        let _ = complete(pending, None, true);
        return Ok(());
    }
    if window
        .emit_to(
            EventTarget::webview_window(window.label()),
            "editor-menu-requested",
            &menu,
        )
        .is_err()
    {
        if let Some(pending) = take_pending(window.label(), connection, Some(&menu.id)) {
            let _ = complete(pending, None, true);
        }
        return Ok(());
    }
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = cancelled => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                let target = window.clone();
                let _ = window.run_on_main_thread(move || dismiss(&target, &menu.connection, Some(&menu.id)));
            }
        }
    });
    Ok(())
}

/// 前端事件订阅就绪后建立窗口连接；连接 ID 隔离卸载或热更新的过期清理。
#[tauri::command]
pub async fn editor_menu_connect(
    window: tauri::WebviewWindow,
    connection: String,
) -> Result<(), String> {
    check_window(&window)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .with_webview(move |webview| {
            let result = (|| -> Result<(), String> {
                disconnect(target.label(), None)?;
                unsafe {
                    let core: ICoreWebView2_11 = webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| core.cast())
                        .map_err(|error| error.to_string())?;
                    let mut menu_token = 0;
                    let owner = target.clone();
                    let owner_id = connection.clone();
                    core.add_ContextMenuRequested(
                        &ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                            if let Some(args) = args {
                                requested(&owner, &owner_id, args)?;
                            }
                            Ok(())
                        })),
                        &mut menu_token,
                    )
                    .map_err(|error| error.to_string())?;
                    let mut navigation_token = 0;
                    let label = target.label().to_owned();
                    let owner_id = connection.clone();
                    if let Err(error) = core.add_NavigationStarting(
                        &NavigationStartingEventHandler::create(Box::new(move |_, _| {
                            let _ = disconnect(&label, Some(&owner_id));
                            Ok(())
                        })),
                        &mut navigation_token,
                    ) {
                        let _ = core.remove_ContextMenuRequested(menu_token);
                        return Err(error.to_string());
                    }
                    CONNECTIONS.with(|states| {
                        states.borrow_mut().insert(
                            target.label().to_owned(),
                            Connection {
                                id: connection,
                                webview: core,
                                menu_token,
                                navigation_token,
                                pending: None,
                            },
                        )
                    });
                }
                Ok(())
            })();
            let _ = send.send(result);
        })
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

/// 只清理该前端连接，不能移除同窗口后续挂载建立的新连接。
#[tauri::command]
pub async fn editor_menu_disconnect(
    window: tauri::WebviewWindow,
    connection: String,
) -> Result<(), String> {
    check_window(&window)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let label = window.label().to_owned();
    window
        .run_on_main_thread(move || {
            let _ = send.send(disconnect(&label, Some(&connection)));
        })
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

/// 仅执行当前窗口、连接和菜单提供的启用命令；过期请求返回 false，不执行任何动作。
#[tauri::command]
pub async fn editor_menu_finish(
    window: tauri::WebviewWindow,
    connection: String,
    id: String,
    command: Option<i32>,
    restore_native: bool,
) -> Result<bool, String> {
    check_window(&window)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let label = window.label().to_owned();
    window
        .run_on_main_thread(move || {
            let result = match take_pending(&label, &connection, Some(&id)) {
                Some(pending)
                    if pending.menu.permits(&id, command)
                        && !(restore_native && command.is_some()) =>
                {
                    complete(pending, command, restore_native).map(|_| true)
                }
                Some(pending) => {
                    let _ = complete(pending, None, false);
                    Err("command is not enabled in this menu".into())
                }
                None => Ok(false),
            };
            let _ = send.send(result);
        })
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_match_ignores_fragment_but_not_other_document() {
        assert!(same_document(
            "http://localhost:1420/#editor",
            "http://localhost:1420/"
        ));
        assert!(!same_document(
            "http://localhost:1420/preview.html",
            "http://localhost:1420/"
        ));
        assert!(!same_document(
            "https://example.com/",
            "http://localhost:1420/"
        ));
        assert!(!same_document("", "http://localhost:1420/"));
    }
    #[test]
    fn only_current_menu_enabled_commands_can_execute() {
        let menu = Menu {
            id: "current".into(),
            connection: "owner".into(),
            items: vec![
                Item {
                    id: 10,
                    name: "copy".into(),
                    shortcut: String::new(),
                    enabled: true,
                },
                Item {
                    id: 11,
                    name: "cut".into(),
                    shortcut: String::new(),
                    enabled: false,
                },
            ],
        };
        assert!(menu.permits("current", Some(10)));
        assert!(menu.permits("current", None));
        assert!(!menu.permits("previous", Some(10)));
        assert!(!menu.permits("current", Some(11)));
        assert!(!menu.permits("current", Some(99)));
    }
}
