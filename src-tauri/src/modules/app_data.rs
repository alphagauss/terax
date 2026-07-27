//! Terax 自有数据目录。
//!
//! 所有可写的跨模块数据都从 `~/.terax` 派生，不读取进程环境中的 HOME 路径。

use std::path::PathBuf;

/// Application-owned directories below `~/.terax`.
///
/// New persistent Terax data must use this module rather than an OS app-data
/// directory or a module-local path convention.
pub enum Directory {
    Shared,
    Sessions,
    Workspaces,
    WindowState,
    Ssh,
    ShellIntegration,
    Logs,
    Alpha,
}

pub fn root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".terax"))
        .ok_or_else(|| {
            "Terax data directory is unavailable: home directory is unavailable".to_string()
        })
}

pub fn directory(directory: Directory) -> Result<PathBuf, String> {
    let name = match directory {
        Directory::Shared => "shared",
        Directory::Sessions => "sessions",
        Directory::Workspaces => "workspaces",
        Directory::WindowState => "window-state",
        Directory::Ssh => "ssh",
        Directory::ShellIntegration => "shell-integration",
        Directory::Logs => "logs",
        Directory::Alpha => "alpha",
    };
    Ok(root()?.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directories_use_stable_names() {
        let shared = directory(Directory::Shared).unwrap();
        assert_eq!(shared.file_name().unwrap(), "shared");
        assert_eq!(shared.parent().unwrap().file_name().unwrap(), ".terax");
        let window_state = directory(Directory::WindowState).unwrap();
        assert_eq!(window_state.file_name().unwrap(), "window-state");
        let alpha = directory(Directory::Alpha).unwrap();
        assert_eq!(alpha.file_name().unwrap(), "alpha");
    }
}
