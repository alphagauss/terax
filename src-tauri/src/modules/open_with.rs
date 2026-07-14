#[cfg(any(windows, test))]
use std::path::Path;

#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

#[cfg(windows)]
const FILE_EXTENSIONS: &[&str] = &[
    ".json",
    ".jsonc",
    ".txt",
    ".log",
    ".csv",
    ".tsv",
    ".md",
    ".markdown",
    ".mdx",
    ".js",
    ".mjs",
    ".cjs",
    ".jsx",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".java",
    ".kt",
    ".kts",
    ".gradle",
    ".py",
    ".rb",
    ".php",
    ".go",
    ".rs",
    ".swift",
    ".dart",
    ".lua",
    ".c",
    ".h",
    ".cpp",
    ".cc",
    ".hpp",
    ".hh",
    ".cs",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".xml",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".sh",
    ".bash",
    ".zsh",
    ".sql",
    ".graphql",
    ".proto",
];

#[cfg(any(windows, test))]
fn command_value(executable: &Path) -> String {
    format!("\"{}\" \"%1\"", executable.display())
}

#[cfg(windows)]
fn application_key(executable: &Path) -> Result<String, String> {
    let name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "current executable has no file name".to_string())?;
    Ok(format!(r"Software\Classes\Applications\{name}"))
}

#[cfg(windows)]
fn notify_association_changed() {
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

#[tauri::command]
pub fn open_with_register() -> Result<String, String> {
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let key = application_key(&executable)?;
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let (open, _) = current_user
            .create_subkey(format!(r"{key}\shell\open"))
            .map_err(|error| error.to_string())?;
        open.set_value("FriendlyAppName", &"Terax")
            .map_err(|error| error.to_string())?;
        let (command, _) = open
            .create_subkey("command")
            .map_err(|error| error.to_string())?;
        command
            .set_value("", &command_value(&executable))
            .map_err(|error| error.to_string())?;
        let (supported_types, _) = current_user
            .create_subkey(format!(r"{key}\SupportedTypes"))
            .map_err(|error| error.to_string())?;
        for extension in FILE_EXTENSIONS {
            supported_types
                .set_value(extension, &"")
                .map_err(|error| error.to_string())?;
        }
        notify_association_changed();
        Ok(executable.to_string_lossy().into_owned())
    }
    #[cfg(not(windows))]
    Err("Open With registration is only available on Windows".to_string())
}

#[tauri::command]
pub fn open_with_unregister() -> Result<(), String> {
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let key = application_key(&executable)?;
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        match current_user.delete_subkey_all(key) {
            Ok(()) => notify_association_changed(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Open With registration is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_passes_the_opened_file_as_the_first_argument() {
        assert_eq!(
            command_value(Path::new(r"C:\Tools\Terax.exe")),
            r#""C:\Tools\Terax.exe" "%1""#
        );
    }
}
