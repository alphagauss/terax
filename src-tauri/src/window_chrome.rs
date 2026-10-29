//! Windows 使用 WebView2 原生拖窗；这里只转发标题栏右键，不合成拖动或双击消息。

use tauri::{plugin::TauriPlugin, Emitter, EventTarget, Runtime};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetClientRect, HTCAPTION, SC_MOUSEMENU, WM_CONTEXTMENU, WM_NCDESTROY, WM_NCRBUTTONUP,
            WM_SYSCOMMAND,
        },
    },
};

#[derive(Clone, serde::Serialize)]
struct ContextMenuPoint {
    x: i32,
    y: i32,
}

struct ChromeState {
    context_menu: Box<dyn Fn(ContextMenuPoint)>,
}

/// 在主窗口及辅助窗口安装原生右键桥接，生命周期与 HWND 一致。
pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("window-chrome")
        .on_window_ready(|window| {
            let target = window.clone();
            if let Err(error) = window.run_on_main_thread(move || {
                let result = target.hwnd().map(|hwnd| unsafe {
                    install(hwnd.0, move |point| {
                        if let Err(error) = target.emit_to(
                            EventTarget::webview_window(target.label()),
                            "window-chrome-context-menu",
                            point,
                        ) {
                            log::error!("转发原生标题栏右键失败: {error}");
                        }
                    })
                });
                if !matches!(result, Ok(true)) {
                    log::error!("安装原生标题栏右键桥接失败: {result:?}");
                }
            }) {
                log::error!("调度原生标题栏右键桥接失败: {error}");
            }
        })
        .build()
}

unsafe fn install(hwnd: HWND, context_menu: impl Fn(ContextMenuPoint) + 'static) -> bool {
    let state = Box::into_raw(Box::new(ChromeState {
        context_menu: Box::new(context_menu),
    }));
    if SetWindowSubclass(hwnd, Some(chrome_subclass), 0, state as usize) == 0 {
        drop(Box::from_raw(state));
        false
    } else {
        true
    }
}

fn is_mouse_context_menu(message: u32, wparam: WPARAM, lparam: LPARAM) -> bool {
    // WebView 子窗口的菜单请求可由 DefWindowProc 转发给宿主，键盘请求没有鼠标坐标。
    (message == WM_CONTEXTMENU && lparam != -1)
        || (message == WM_NCRBUTTONUP && wparam == HTCAPTION as WPARAM)
        || (message == WM_SYSCOMMAND && wparam & 0xfff0 == SC_MOUSEMENU as WPARAM)
}

fn screen_point(lparam: LPARAM) -> POINT {
    // 屏幕坐标允许为负，不能用无符号 LOWORD/HIWORD 解码多显示器位置。
    POINT {
        x: lparam as i16 as i32,
        y: (lparam >> 16) as i16 as i32,
    }
}

unsafe extern "system" fn chrome_subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    reference_data: usize,
) -> LRESULT {
    if is_mouse_context_menu(message, wparam, lparam) {
        let mut point = screen_point(lparam);
        let mut bounds = std::mem::zeroed();
        // 只处理 WebView 所在客户区，系统边框与任务栏菜单仍交给 Windows。
        if ScreenToClient(hwnd, &mut point) != 0
            && GetClientRect(hwnd, &mut bounds) != 0
            && point.x >= bounds.left
            && point.x < bounds.right
            && point.y >= bounds.top
            && point.y < bounds.bottom
        {
            let state = &*(reference_data as *const ChromeState);
            (state.context_menu)(ContextMenuPoint {
                x: point.x,
                y: point.y,
            });
            return 0;
        }
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(chrome_subclass), subclass_id);
        drop(Box::from_raw(reference_data as *mut ChromeState));
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HTLEFT, SC_KEYMENU, SC_MAXIMIZE, SC_MOVE, WM_LBUTTONDOWN, WM_NCLBUTTONDBLCLK,
        WM_NCLBUTTONDOWN,
    };

    #[test]
    fn forwards_mouse_menus_without_intercepting_keyboard_or_window_actions() {
        assert!(is_mouse_context_menu(WM_CONTEXTMENU, 0, 0));
        assert!(!is_mouse_context_menu(WM_CONTEXTMENU, 0, -1));
        assert!(is_mouse_context_menu(
            WM_NCRBUTTONUP,
            HTCAPTION as WPARAM,
            0
        ));
        assert!(is_mouse_context_menu(
            WM_SYSCOMMAND,
            SC_MOUSEMENU as WPARAM | 3,
            0
        ));
        for (message, wparam) in [
            (WM_NCRBUTTONUP, HTLEFT as WPARAM),
            (WM_LBUTTONDOWN, 0),
            (WM_NCLBUTTONDOWN, HTCAPTION as WPARAM),
            (WM_NCLBUTTONDBLCLK, HTCAPTION as WPARAM),
            (WM_SYSCOMMAND, SC_MOVE as WPARAM),
            (WM_SYSCOMMAND, SC_MAXIMIZE as WPARAM),
            (WM_SYSCOMMAND, SC_KEYMENU as WPARAM),
        ] {
            assert!(!is_mouse_context_menu(message, wparam, 0));
        }
    }

    #[test]
    fn decodes_signed_screen_coordinates() {
        for (x, y) in [(-1920_i16, -200_i16), (300, 240)] {
            let packed = ((y as u16 as u32) << 16 | x as u16 as u32) as LPARAM;
            let point = screen_point(packed);
            assert_eq!((point.x, point.y), (x as i32, y as i32));
        }
    }

    #[test]
    fn native_context_menu_messages_reach_the_menu_bridge() {
        use std::{cell::RefCell, ptr::null_mut, rc::Rc};
        use windows_sys::Win32::{
            Graphics::Gdi::ClientToScreen,
            UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, SendMessageW, WS_CHILD, WS_OVERLAPPEDWINDOW,
            },
        };

        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe { DestroyWindow(self.0) };
            }
        }

        unsafe {
            // 隐藏窗口只验证真实消息路由，不显示 UI，也不进入拖动或菜单循环。
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let window = TestWindow(CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                100,
                100,
                300,
                200,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            ));
            assert!(!window.0.is_null());
            let received = Rc::new(RefCell::new(Vec::new()));
            let sink = received.clone();
            assert!(install(window.0, move |point| sink
                .borrow_mut()
                .push((point.x, point.y))));
            let mut point = POINT { x: 20, y: 30 };
            assert_ne!(ClientToScreen(window.0, &mut point), 0);
            let packed = ((point.y as u16 as u32) << 16 | point.x as u16 as u32) as LPARAM;
            SendMessageW(window.0, WM_NCRBUTTONUP, HTCAPTION as WPARAM, packed);
            SendMessageW(window.0, WM_SYSCOMMAND, SC_MOUSEMENU as WPARAM | 3, packed);
            let child = TestWindow(CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_CHILD,
                0,
                0,
                100,
                100,
                window.0,
                null_mut(),
                null_mut(),
                null_mut(),
            ));
            assert!(!child.0.is_null());
            // 子窗口通过默认过程把标准菜单请求转发给宿主，不能只覆盖直接发送的标题栏消息。
            SendMessageW(child.0, WM_CONTEXTMENU, child.0 as WPARAM, packed);
            assert_eq!(*received.borrow(), [(20, 30), (20, 30), (20, 30)]);
        }
    }
}
