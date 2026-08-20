//! 原生窗口全屏切换与 Windows 最大化样式协调。
//!
//! 本模块保持 Tauri 负责窗口 placement，仅在 Windows 全屏边界静默调整
//! `WS_MAXIMIZE`，避免任务栏残留和额外的还原、最大化动画。

#[cfg(windows)]
use std::{collections::HashSet, sync::Mutex};
use tauri::State;

/// 记录进入全屏前处于最大化状态的 Windows 窗口。
///
/// 状态按窗口标签隔离，辅助窗口不会消费主窗口的恢复标记。
#[derive(Default)]
pub(crate) struct FullscreenState {
    #[cfg(windows)]
    restore_maximized: Mutex<HashSet<String>>,
}

#[cfg(windows)]
impl FullscreenState {
    /// 更新指定窗口退出全屏时是否需要恢复最大化样式。
    fn set_restore_maximized(&self, label: &str, restore: bool) -> Result<(), String> {
        let mut windows = self
            .restore_maximized
            .lock()
            .map_err(|_| "fullscreen state mutex poisoned".to_string())?;
        if restore {
            windows.insert(label.to_string());
        } else {
            windows.remove(label);
        }
        Ok(())
    }

    /// 查询指定窗口是否需要恢复最大化样式。
    fn should_restore_maximized(&self, label: &str) -> Result<bool, String> {
        Ok(self
            .restore_maximized
            .lock()
            .map_err(|_| "fullscreen state mutex poisoned".to_string())?
            .contains(label))
    }
}

/// 切换触发命令的当前窗口全屏状态。
///
/// 读取和写入均在原生端完成，避免两次 IPC 之间的状态竞争。
#[tauri::command]
pub(crate) fn toggle_fullscreen(
    window: tauri::Window,
    state: State<'_, FullscreenState>,
) -> Result<(), String> {
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    set_window_fullscreen(&window, &state, !fullscreen)
}

/// 将触发命令的当前窗口设置为指定全屏状态。
///
/// 显式目标值供禅模式恢复进入前状态，并安全处理重复请求。
#[tauri::command]
pub(crate) fn set_fullscreen(
    window: tauri::Window,
    state: State<'_, FullscreenState>,
    fullscreen: bool,
) -> Result<(), String> {
    set_window_fullscreen(&window, &state, fullscreen)
}

/// 设置窗口全屏状态，并修正 Windows 最大化样式对任务栏判定的干扰。
///
/// 最大化窗口进入全屏后静默清除 `WS_MAXIMIZE`，退出前再恢复该样式。
/// Tauri 继续负责原 placement，不调用会触发还原或最大化动画的窗口 API。
fn set_window_fullscreen(
    window: &tauri::Window,
    state: &FullscreenState,
    fullscreen: bool,
) -> Result<(), String> {
    let current = window.is_fullscreen().map_err(|error| error.to_string())?;
    if current == fullscreen {
        #[cfg(windows)]
        if fullscreen && state.should_restore_maximized(window.label())? {
            // 前一次调用可能已进入全屏但未完成样式刷新，重复请求负责收敛。
            set_windows_maximized_style(window, false)?;
        }
        #[cfg(windows)]
        if !fullscreen {
            // 系统层退出全屏后，丢弃不再需要的恢复标记。
            state.set_restore_maximized(window.label(), false)?;
        }
        return Ok(());
    }

    #[cfg(windows)]
    if fullscreen {
        let was_maximized = windows_has_maximized_style(window)?;
        state.set_restore_maximized(window.label(), was_maximized)?;
        if let Err(error) = window.set_fullscreen(true) {
            let _ = state.set_restore_maximized(window.label(), false);
            return Err(error.to_string());
        }
        if was_maximized {
            set_windows_maximized_style(window, false)?;
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        let restore_maximized = state.should_restore_maximized(window.label())?;
        if restore_maximized {
            set_windows_maximized_style(window, true)?;
        }
        if let Err(error) = window.set_fullscreen(false) {
            if restore_maximized {
                let _ = set_windows_maximized_style(window, false);
            }
            return Err(error.to_string());
        }
        state.set_restore_maximized(window.label(), false)?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = state;
        window
            .set_fullscreen(fullscreen)
            .map_err(|error| error.to_string())
    }
}

/// 设置原生最大化位，保留全屏切换已经配置的其他窗口样式。
#[cfg(windows)]
fn windows_style_with_maximized(style: i32, maximized: bool) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::WS_MAXIMIZE;

    if maximized {
        style | WS_MAXIMIZE as i32
    } else {
        style & !(WS_MAXIMIZE as i32)
    }
}

/// 查询 Windows 窗口是否携带原生最大化样式。
#[cfg(windows)]
fn windows_has_maximized_style(window: &tauri::Window) -> Result<bool, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_STYLE, WS_MAXIMIZE};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    Ok(unsafe { GetWindowLongW(hwnd, GWL_STYLE) & WS_MAXIMIZE as i32 != 0 })
}

/// 静默设置 Windows 最大化样式，不改变当前窗口尺寸或 placement。
#[cfg(windows)]
fn set_windows_maximized_style(window: &tauri::Window, maximized: bool) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError, ERROR_SUCCESS};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let next_style = windows_style_with_maximized(style, maximized);
        if next_style == style {
            return Ok(());
        }

        SetLastError(ERROR_SUCCESS);
        if SetWindowLongW(hwnd, GWL_STYLE, next_style) == 0 && GetLastError() != ERROR_SUCCESS {
            return Err(std::io::Error::last_os_error().to_string());
        }

        if SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::{windows_style_with_maximized, FullscreenState};
    use windows_sys::Win32::UI::WindowsAndMessaging::{WS_CAPTION, WS_MAXIMIZE, WS_VISIBLE};

    #[test]
    fn changes_only_the_maximized_style() {
        let style = (WS_CAPTION | WS_MAXIMIZE | WS_VISIBLE) as i32;

        assert_eq!(
            windows_style_with_maximized(style, false),
            (WS_CAPTION | WS_VISIBLE) as i32
        );
        assert_eq!(
            windows_style_with_maximized((WS_CAPTION | WS_VISIBLE) as i32, true),
            style
        );
    }

    #[test]
    fn restore_markers_are_isolated_by_window() {
        let state = FullscreenState::default();

        state.set_restore_maximized("main", true).unwrap();
        assert!(state.should_restore_maximized("main").unwrap());
        assert!(!state.should_restore_maximized("settings").unwrap());

        state.set_restore_maximized("main", false).unwrap();
        assert!(!state.should_restore_maximized("main").unwrap());
    }
}
