//! 跨宿主进程启动约束与系统 Shell 定位。
//! Windows 隐藏控制台和 Job Object 规则由桌面与终端宿主共用。

#[cfg(windows)]
pub mod job;

pub mod cancellation;
pub mod group;

use std::process::Command;

#[cfg(windows)]
pub fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
#[inline]
pub fn hide_console(_cmd: &mut Command) {}

#[cfg(windows)]
use std::path::PathBuf;

/// 按当前平台既有优先级定位 PowerShell 或系统命令解释器。
#[cfg(windows)]
pub fn windows_shell_path() -> PathBuf {
    if let Some(path) = powershell_7_path() {
        return path;
    }

    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32");
    let ps5 = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if ps5.is_file() {
        return ps5;
    }

    system32.join("cmd.exe")
}

/// 按 PATH、标准安装目录的顺序定位 PowerShell 7。
#[cfg(windows)]
pub fn powershell_7_path() -> Option<PathBuf> {
    if let Some(p) = which_in_path("pwsh.exe") {
        return Some(p);
    }

    if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        let candidate = pf.join("PowerShell").join("7").join("pwsh.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(windows)]
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
