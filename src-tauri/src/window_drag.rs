//! Windows 拖窗消息的释放校验，避免 WebView 的异步请求在松键后启动系统拖动。

use tauri::{plugin::TauriPlugin, Runtime};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetSystemMetrics, HTCAPTION, SM_SWAPBUTTON, WM_NCDESTROY, WM_NCLBUTTONDOWN,
        },
    },
};

/// 在每个原生窗口的所属线程安装校验，主窗口和辅助窗口共用同一边界。
pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("window-drag")
        .on_window_ready(|window| {
            let target = window.clone();
            if let Err(error) = window.run_on_main_thread(move || {
                let result = target.hwnd().map(|hwnd| unsafe {
                    SetWindowSubclass(hwnd.0, Some(drag_subclass), 0, 0) != 0
                });
                if !matches!(result, Ok(true)) {
                    log::error!("安装窗口拖动校验失败: {result:?}");
                }
            }) {
                log::error!("调度窗口拖动校验失败: {error}");
            }
        })
        .build()
}

fn is_released_drag(message: u32, hit_test: WPARAM, primary_button_state: i16) -> bool {
    // 低位只表示曾经按过；只有高位表示现在仍按住。
    message == WM_NCLBUTTONDOWN && hit_test == HTCAPTION as WPARAM && primary_button_state >= 0
}

unsafe extern "system" fn drag_subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    _reference_data: usize,
) -> LRESULT {
    if message == WM_NCLBUTTONDOWN && wparam == HTCAPTION as WPARAM {
        // GetAsyncKeyState 读取物理按键，需尊重 Windows 的左右键交换设置。
        let primary_button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
            VK_RBUTTON
        } else {
            VK_LBUTTON
        };
        // Tao 通过 PostMessage 排队启动拖窗，必须在消费消息时而非发送 IPC 时校验。
        if is_released_drag(message, wparam, GetAsyncKeyState(primary_button as i32)) {
            return 0;
        }
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(drag_subclass), subclass_id);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HTLEFT, SC_MOVE, WM_NCLBUTTONDBLCLK, WM_SYSCOMMAND,
    };

    #[test]
    fn rejects_drag_delivered_after_button_release() {
        assert!(!is_released_drag(
            WM_NCLBUTTONDOWN,
            HTCAPTION as WPARAM,
            i16::MIN
        ));
        for released in [0, 1] {
            assert!(is_released_drag(
                WM_NCLBUTTONDOWN,
                HTCAPTION as WPARAM,
                released
            ));
        }
    }

    #[test]
    fn preserves_held_drag_and_other_window_interactions() {
        for held in [i16::MIN, i16::MIN | 1] {
            assert!(!is_released_drag(
                WM_NCLBUTTONDOWN,
                HTCAPTION as WPARAM,
                held
            ));
        }
        for (message, hit_test) in [
            (WM_NCLBUTTONDOWN, HTLEFT as WPARAM),
            (WM_NCLBUTTONDBLCLK, HTCAPTION as WPARAM),
            (WM_SYSCOMMAND, SC_MOVE as WPARAM),
        ] {
            assert!(!is_released_drag(message, hit_test, 0));
        }
    }

    #[test]
    #[ignore = "需要交互式 Windows 桌面且鼠标主键处于释放状态"]
    fn released_drag_never_enters_native_move_loop() {
        use std::{cell::Cell, ptr::null_mut};
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardState, SetKeyboardState};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
            PostMessageW, MSG, PM_REMOVE, WM_CANCELMODE, WM_ENTERSIZEMOVE, WS_OVERLAPPEDWINDOW,
            WS_VISIBLE,
        };

        unsafe extern "system" fn record_move_loop(
            hwnd: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
            _id: usize,
            data: usize,
        ) -> LRESULT {
            // STATIC 控件会吞掉系统命令，拖动入口改由默认顶层窗口过程处理。
            if matches!(message, WM_NCLBUTTONDOWN | WM_SYSCOMMAND) {
                return DefWindowProcW(hwnd, message, wparam, lparam);
            }
            if message == WM_ENTERSIZEMOVE {
                let entered = &*(data as *const Cell<usize>);
                entered.set(entered.get() + 1);
                // 未修复的对照会进入系统拖动；立即取消，避免测试挂住或移动窗口。
                PostMessageW(hwnd, WM_CANCELMODE, 0, 0);
            }
            DefSubclassProc(hwnd, message, wparam, lparam)
        }

        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe { DestroyWindow(self.0) };
            }
        }

        unsafe {
            let primary = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
                VK_RBUTTON
            } else {
                VK_LBUTTON
            };
            assert!(
                GetAsyncKeyState(primary as i32) >= 0,
                "测试时请松开鼠标主键"
            );
            let entered = Cell::new(0_usize);
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let window = TestWindow(CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
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
            assert_ne!(
                SetWindowSubclass(
                    window.0,
                    Some(record_move_loop),
                    0,
                    &entered as *const Cell<usize> as usize,
                ),
                0
            );

            let dispatch_queued_drag = || {
                assert_ne!(
                    PostMessageW(
                        window.0,
                        WM_NCLBUTTONDOWN,
                        HTCAPTION as WPARAM,
                        (110 << 16) | 150
                    ),
                    0
                );
                let mut message: MSG = std::mem::zeroed();
                assert_ne!(
                    PeekMessageW(
                        &mut message,
                        window.0,
                        WM_NCLBUTTONDOWN,
                        WM_NCLBUTTONDOWN,
                        PM_REMOVE
                    ),
                    0
                );
                // 模拟已排队的按下状态；仅修改测试线程，物理主键仍已释放。
                let mut previous = [0_u8; 256];
                assert_ne!(GetKeyboardState(previous.as_mut_ptr()), 0);
                let mut queued = previous;
                queued[VK_LBUTTON as usize] = 0x80;
                assert_ne!(SetKeyboardState(queued.as_ptr()), 0);
                DispatchMessageW(&message);
                assert_ne!(SetKeyboardState(previous.as_ptr()), 0);
            };

            // 用真实系统消息验证：松键后消费的旧按下消息仍会启动原生拖动。
            dispatch_queued_drag();
            assert_eq!(entered.get(), 1, "未安装校验的对照应复现过期拖动");
            assert_ne!(SetWindowSubclass(window.0, Some(drag_subclass), 0, 0), 0);
            dispatch_queued_drag();
            assert_eq!(entered.get(), 1, "校验应阻止第二次进入原生拖动");
        }
    }
}
