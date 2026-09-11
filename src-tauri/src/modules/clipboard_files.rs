//! 用户主动粘贴时读取宿主剪贴板文件路径，不读取文件正文，也不修改剪贴板。

/// 文件列表与图片数据必须分开识别，远端会话由调用方拒绝宿主文件。
#[tauri::command]
pub async fn clipboard_read_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        paths_from_clipboard(clipboard.get().file_list())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn paths_from_clipboard(
    result: Result<Vec<std::path::PathBuf>, arboard::Error>,
) -> Result<Vec<String>, String> {
    let paths = match result {
        Ok(paths) => paths,
        Err(arboard::Error::ContentNotAvailable) => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut result = Vec::new();
    for path in paths {
        if !path.is_absolute() {
            return Err("clipboard file path is not absolute".into());
        }
        let path = path
            .into_os_string()
            .into_string()
            .map_err(|_| "clipboard file path is not valid Unicode")?;
        if !result.contains(&path) {
            result.push(path);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absence_errors_and_paths_remain_distinct() {
        assert!(
            paths_from_clipboard(Err(arboard::Error::ContentNotAvailable))
                .unwrap()
                .is_empty()
        );
        assert!(paths_from_clipboard(Err(arboard::Error::ClipboardOccupied)).is_err());
        assert!(paths_from_clipboard(Ok(vec!["relative.txt".into()])).is_err());
        let path = std::env::temp_dir().join("文件.txt");
        assert_eq!(
            paths_from_clipboard(Ok(vec![path.clone(), path.clone()])).unwrap(),
            vec![path.to_str().unwrap()]
        );
    }
}
