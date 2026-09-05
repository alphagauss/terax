//! Terax 自有数据目录。
//!
//! 所有可写的跨模块数据都从 `~/.terax` 派生，不读取进程环境中的 HOME 路径。

use std::path::PathBuf;

/// `~/.terax` 下由应用统一管理的持久化目录。
///
/// 新增持久化数据必须从这里取路径，不能自行约定模块目录。
pub enum Directory {
    /// 消息连接的配置与协议恢复数据。
    Channels,
    Shared,
    Sessions,
    Workspace,
    Workspaces,
    WindowState,
    Transfers,
    Ssh,
    ShellIntegration,
    Logs,
    Alpha,
}

/// 返回 Terax 自有数据根目录。
pub fn root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".terax"))
        .ok_or_else(|| {
            "Terax data directory is unavailable: home directory is unavailable".to_string()
        })
}

/// 返回指定类别的稳定数据目录路径，不主动创建目录。
pub fn directory(directory: Directory) -> Result<PathBuf, String> {
    let name = match directory {
        Directory::Channels => "channels",
        Directory::Shared => "shared",
        Directory::Sessions => "sessions",
        Directory::Workspace => "workspace",
        Directory::Workspaces => "workspaces",
        Directory::WindowState => "window-state",
        Directory::Transfers => "transfers",
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
        let workspace = directory(Directory::Workspace).unwrap();
        assert_eq!(workspace.file_name().unwrap(), "workspace");
        let window_state = directory(Directory::WindowState).unwrap();
        assert_eq!(window_state.file_name().unwrap(), "window-state");
        let transfers = directory(Directory::Transfers).unwrap();
        assert_eq!(transfers.file_name().unwrap(), "transfers");
        let alpha = directory(Directory::Alpha).unwrap();
        assert_eq!(alpha.file_name().unwrap(), "alpha");
    }
}
