#[cfg(any(windows, test))]
use std::path::Path;

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
    Ok(format!(r"HKCU\Software\Classes\Applications\{name}"))
}

#[cfg(windows)]
fn run_reg(args: Vec<String>) -> Result<(), String> {
    let output = std::process::Command::new("reg")
        .args(args)
        .output()
        .map_err(|error| format!("cannot run reg.exe: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() {
        format!("reg.exe exited with {}", output.status)
    } else {
        error
    })
}

#[tauri::command]
pub fn open_with_register() -> Result<String, String> {
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let key = application_key(&executable)?;
        run_reg(vec![
            "add".to_string(),
            format!(r"{key}\shell\open"),
            "/v".to_string(),
            "FriendlyAppName".to_string(),
            "/d".to_string(),
            "Terax".to_string(),
            "/f".to_string(),
        ])?;
        run_reg(vec![
            "add".to_string(),
            format!(r"{key}\shell\open\command"),
            "/ve".to_string(),
            "/d".to_string(),
            command_value(&executable),
            "/f".to_string(),
        ])?;
        for extension in FILE_EXTENSIONS {
            run_reg(vec![
                "add".to_string(),
                format!(r"{key}\SupportedTypes"),
                "/v".to_string(),
                extension.to_string(),
                "/d".to_string(),
                String::new(),
                "/f".to_string(),
            ])?;
        }
        return Ok(executable.to_string_lossy().into_owned());
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
        let exists = std::process::Command::new("reg")
            .args(["query", &key])
            .status()
            .map_err(|error| format!("cannot run reg.exe: {error}"))?
            .success();
        if exists {
            run_reg(vec!["delete".to_string(), key, "/f".to_string()])?;
        }
        return Ok(());
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
