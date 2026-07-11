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
    }
}
