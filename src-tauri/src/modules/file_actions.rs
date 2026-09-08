//! 用户主动触发的系统打开方式与另存为。环境来自当前进程，远端下载交给传输运行时。

use crate::modules::transfers::{
    models::{EnqueueTransferRequest, TransferDirection, TransferStrategy},
    TransferState,
};
use crate::modules::{fs::file, workspace::WorkspaceEnv, workspace_process::WorkspaceProcessState};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 选择本机保存位置；本机原子复制，WSL 与 SSH 使用已有后台下载队列。
#[tauri::command]
pub async fn file_save_as(
    path: String,
    title: String,
    window: tauri::WebviewWindow,
    workspace: tauri::State<'_, WorkspaceProcessState>,
    transfers: tauri::State<'_, TransferState>,
) -> Result<Option<String>, String> {
    let env = workspace.bootstrap().env.clone();
    let stat = file::fs_stat(path.clone(), Some(env.clone())).await?;
    if !matches!(stat.kind, file::StatKind::File) {
        return Err("source is not a regular file".into());
    }
    let name = path.rsplit('/').next().unwrap_or("file");
    let destination = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .set_file_name(name)
        .blocking_save_file();
    let Some(destination) = destination else {
        return Ok(None);
    };
    let destination = destination.into_path().map_err(|e| e.to_string())?;
    if env == WorkspaceEnv::Local {
        tauri::async_runtime::spawn_blocking(move || {
            copy_file_atomic(Path::new(&path), &destination)
        })
        .await
        .map_err(|e| e.to_string())??;
    } else {
        let parent = destination.parent().ok_or("destination has no parent")?;
        let name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("invalid destination filename")?;
        let task = transfers
            .manager()
            .enqueue(
                window.app_handle().clone(),
                env,
                workspace.bootstrap().id.clone(),
                EnqueueTransferRequest {
                    direction: TransferDirection::Download,
                    strategy: TransferStrategy::Direct,
                    sources: vec![path],
                    destination: parent.to_string_lossy().into_owned(),
                    destination_name: Some(name.to_string()),
                },
            )
            .await
            .map_err(|e| format!("{e:?}"))?;
        return Ok(Some(task.id));
    }
    Ok(None)
}

fn copy_file_atomic(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = open_regular_file(source)?;
    let parent = destination.parent().ok_or("destination has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::copy(&mut input, temporary.as_file_mut()).map_err(|e| e.to_string())?;
    drop(input);
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(destination)
        .map_err(|e| e.error.to_string())?;
    Ok(())
}

/// 拒绝链接和特殊文件；在 Unix 上避免来源被替换为 FIFO 后阻塞读取线程。
fn open_regular_file(path: &Path) -> Result<std::fs::File, String> {
    if !std::fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("source is not a regular file".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("source is not a regular file".into());
    }
    Ok(file)
}

/// 只允许当前本机环境通过系统应用选择器打开普通文件，不向系统传递行号。
#[tauri::command]
pub async fn file_open_with(
    path: String,
    title: String,
    window: tauri::WebviewWindow,
    workspace: tauri::State<'_, WorkspaceProcessState>,
) -> Result<(), String> {
    if workspace.bootstrap().env != WorkspaceEnv::Local {
        return Err("system applications require a local workspace".into());
    }
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("source is not a regular file".into());
    }
    open_with(path, title, window).await
}

#[cfg(target_os = "windows")]
async fn open_with(
    path: PathBuf,
    _title: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OPENASINFO};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let parent = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    window
        .run_on_main_thread(move || {
            let shell_path =
                std::ffi::OsString::from(crate::modules::fs::to_canon(&path).replace('/', "\\"));
            let path: Vec<u16> = shell_path.encode_wide().chain(Some(0)).collect();
            let info = OPENASINFO {
                pcszFile: path.as_ptr(),
                pcszClass: std::ptr::null(),
                oaifInFlags: OAIF_EXEC,
            };
            // 路径缓冲区在原生对话框返回前保持有效，窗口句柄来自当前窗口。
            let result = unsafe { SHOpenWithDialog(parent as _, &info) };
            let _ = sender.send(if result >= 0 || result as u32 == 0x800704c7 {
                Ok(())
            } else {
                Err(format!("Open With failed: {result:#x}"))
            });
        })
        .map_err(|e| e.to_string())?;
    receiver.await.map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
async fn open_with(
    path: PathBuf,
    title: String,
    _window: tauri::WebviewWindow,
) -> Result<(), String> {
    // 静态 JXA 脚本仅通过 argv 接收路径，应用列表由 NSWorkspace 查询。
    const SCRIPT: &str = r#"ObjC.import('AppKit'); function run(argv) {
      const app = Application.currentApplication(); app.includeStandardAdditions = true;
      const url = $.NSURL.fileURLWithPath(argv[0]);
      const urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(url);
      const paths = []; for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
      const chosen = app.chooseFromList(paths, {withPrompt: argv[1]});
      return chosen === false ? "" : chosen[0];
    }"#;
    let output = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT, "--"])
        .arg(&path)
        .arg(title)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let chosen = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let chosen = chosen.trim_end_matches(['\r', '\n']);
    if chosen.is_empty() {
        return Ok(());
    }
    let output = tokio::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(chosen)
        .arg(&path)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[cfg(target_os = "linux")]
async fn open_with(
    path: PathBuf,
    _title: String,
    _window: tauri::WebviewWindow,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::{collections::HashMap, os::fd::AsFd};
    use zbus::zvariant::{Fd, OwnedObjectPath, OwnedValue, Value};
    let connection = zbus::Connection::session()
        .await
        .map_err(|e| e.to_string())?;
    let proxy = zbus::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
    )
    .await
    .map_err(|e| e.to_string())?;
    // 在发送请求前订阅响应，避免快速取消或失败发生在订阅之前。
    let token = format!("terax_{}", uuid::Uuid::new_v4().simple());
    let sender = connection
        .unique_name()
        .ok_or("portal connection has no unique name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let request_path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let request = zbus::Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        request_path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut responses = request
        .receive_signal("Response")
        .await
        .map_err(|e| e.to_string())?;
    let file = open_regular_file(&path)?;
    let options = HashMap::from([
        ("ask", Value::from(true)),
        ("handle_token", Value::from(token.as_str())),
    ]);
    let _: OwnedObjectPath = proxy
        .call("OpenFile", &("", Fd::from(file.as_fd()), options))
        .await
        .map_err(|e| e.to_string())?;
    let response = responses
        .next()
        .await
        .ok_or("application chooser disconnected")?;
    let (code, _): (u32, HashMap<String, OwnedValue>) =
        response.body().deserialize().map_err(|e| e.to_string())?;
    match code {
        0 | 1 => Ok(()),
        _ => Err("system application chooser failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_rejects_directory_without_changing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("copy");
        std::fs::write(&destination, b"old").unwrap();
        assert!(copy_file_atomic(directory.path(), &destination).is_err());
        assert_eq!(std::fs::read(destination).unwrap(), b"old");
    }
    #[cfg(unix)]
    #[test]
    fn save_rejects_fifo_and_symlink_without_opening_them() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().unwrap();
        let fifo = directory.path().join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // 测试只在独立临时目录创建 FIFO，读取入口必须立即拒绝。
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let destination = directory.path().join("copy");
        assert!(copy_file_atomic(&fifo, &destination).is_err());
        let source = directory.path().join("source");
        std::fs::write(&source, b"text").unwrap();
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(copy_file_atomic(&link, &destination).is_err());
        assert!(!destination.exists());
    }
    #[test]
    fn save_preserves_bytes_and_replaces_destination() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("源文件.bin");
        let destination = directory.path().join("copy.bin");
        std::fs::write(&source, [0, 255, 13, 10]).unwrap();
        std::fs::write(&destination, b"old").unwrap();
        copy_file_atomic(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), [0, 255, 13, 10]);
        assert_eq!(std::fs::read(&source).unwrap(), [0, 255, 13, 10]);
    }
    #[test]
    fn missing_source_does_not_change_destination() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("copy");
        std::fs::write(&destination, b"old").unwrap();
        assert!(copy_file_atomic(&directory.path().join("missing"), &destination).is_err());
        assert_eq!(std::fs::read(destination).unwrap(), b"old");
    }
}
