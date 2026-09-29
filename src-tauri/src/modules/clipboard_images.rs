//! 页面图片通过二进制 IPC 复制，避免 RGBA 的 JSON 序列化；原生插件保留系统剪贴板格式与历史行为。

use tauri_plugin_clipboard_manager::ClipboardExt;

/// 在后台线程完成图片编码和剪贴板写入，不占用异步运行时工作线程。
#[tauri::command]
pub async fn clipboard_write_image(
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    if !matches!(
        window.label(),
        "main" | "auxiliary-settings" | "auxiliary-file-properties"
    ) {
        return Err("image clipboard is unavailable for this window".into());
    }
    let dimension = |name| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| "invalid clipboard image dimensions".to_string())
    };
    let width = dimension("x-image-width")?;
    let height = dimension("x-image-height")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("clipboard image requires a binary body".into());
    };
    validate_rgba(width, height, bytes.len())?;
    let image = tauri::image::Image::new_owned(bytes.clone(), width, height);
    tauri::async_runtime::spawn_blocking(move || {
        window
            .clipboard()
            .write_image(&image)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 原生边界独立检查像素上限和数据长度，不信任前端提供的尺寸。
fn validate_rgba(width: u32, height: u32, length: usize) -> Result<(), String> {
    let max_pixels = if cfg!(target_os = "linux") {
        9_000_000
    } else {
        16_777_216
    };
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 || pixels > max_pixels || pixels * 4 != length as u64 {
        return Err("invalid clipboard image dimensions or RGBA length".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_rgba_before_native_clipboard_access() {
        assert!(validate_rgba(1920, 1080, 1920 * 1080 * 4).is_ok());
        assert!(validate_rgba(0, 1, 0).is_err());
        assert!(validate_rgba(1, 0, 0).is_err());
        assert!(validate_rgba(2, 1, 4).is_err());
        assert!(validate_rgba(1, 1, 8).is_err());
        assert!(validate_rgba(u32::MAX, u32::MAX, 0).is_err());
        assert!(validate_rgba(4097, 4096, 4097 * 4096 * 4).is_err());
        if cfg!(target_os = "linux") {
            assert!(validate_rgba(3001, 3000, 3001 * 3000 * 4).is_err());
        }
    }
}
