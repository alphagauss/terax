//! 截图共享偏好和进程内会话身份；不依赖窗口对象。

use crate::modules::shared_store::SharedStoreMutation;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::Instant;

const ENABLED_KEY: &str = "screenshotGlobalShortcutEnabled";
const SHORTCUT_KEY: &str = "screenshotShortcut";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub global_shortcut_enabled: bool,
    pub shortcut: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            global_shortcut_enabled: true,
            shortcut: "CommandOrControl+Shift+X".into(),
        }
    }
}

impl Config {
    pub fn from_map(values: &Map<String, Value>) -> Self {
        let defaults = Self::default();
        Self {
            global_shortcut_enabled: values
                .get(ENABLED_KEY)
                .and_then(Value::as_bool)
                .unwrap_or(defaults.global_shortcut_enabled),
            shortcut: values
                .get(SHORTCUT_KEY)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or(defaults.shortcut),
        }
    }
}

/// 只提交本次修改的字段，避免另一窗口的过时快照覆盖共享偏好。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigPatch {
    pub global_shortcut_enabled: Option<bool>,
    pub shortcut: Option<String>,
}

impl ConfigPatch {
    pub fn into_mutations(self) -> Vec<SharedStoreMutation> {
        let mut changes = Vec::new();
        if let Some(enabled) = self.global_shortcut_enabled {
            changes.push(SharedStoreMutation::Set {
                key: ENABLED_KEY.into(),
                value: enabled.into(),
            });
        }
        if let Some(shortcut) = self.shortcut {
            changes.push(SharedStoreMutation::Set {
                key: SHORTCUT_KEY.into(),
                value: shortcut.into(),
            });
        }
        changes
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub token: String,
    pub width: u32,
    pub height: u32,
    pub language: String,
}

pub struct Session {
    pub frame: Frame,
    pub png: Option<Vec<u8>>,
    pub started: Instant,
    pub capture_ms: u64,
    pub encode_ms: u64,
    pub presented: bool,
    pub exporting: bool,
}

impl Session {
    pub fn check_token(&self, token: &str) -> Result<(), String> {
        if self.frame.token != token {
            return Err("SCREENSHOT_EXPIRED".into());
        }
        Ok(())
    }
}

/// 只有默认 Local 永久窗口注册全局快捷键，手动截图不受此条件限制。
pub fn owns_global_shortcut(primary: bool, local: bool) -> bool {
    primary && local
}

/// 所有 Workspace 使用相同的页面边界，不依据终端环境限制本机截图。
pub fn allows_caller(label: &str, overlay: bool) -> bool {
    if overlay {
        label == "screenshot"
    } else {
        matches!(label, "main" | "auxiliary-settings")
    }
}

/// 在解码前验证像素上界，避免畸形导出耗尽原生内存。
pub fn validate_dimensions(width: u32, height: u32, source: (u32, u32)) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > source.0
        || height > source.1
        || u64::from(width) * u64::from(height) > 50_000_000
    {
        return Err("SCREENSHOT_IMAGE_INVALID".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_default_local_registers_hotkey_but_all_workspace_pages_can_capture() {
        assert!(owns_global_shortcut(true, true));
        assert!(!owns_global_shortcut(false, true));
        assert!(!owns_global_shortcut(true, false));
        assert!(!owns_global_shortcut(false, false));
        assert!(allows_caller("main", false));
        assert!(allows_caller("auxiliary-settings", false));
        assert!(!allows_caller("main", true));
        assert!(!allows_caller("screenshot", false));
        assert!(allows_caller("screenshot", true));
        assert!(!allows_caller("auxiliary-file-properties", false));
    }

    #[test]
    fn independent_setting_edits_do_not_overwrite_other_windows() {
        let mut values = Map::new();
        for patch in [
            ConfigPatch {
                shortcut: Some("Control+Shift+S".into()),
                ..Default::default()
            },
            ConfigPatch {
                global_shortcut_enabled: Some(false),
                ..Default::default()
            },
        ] {
            for change in patch.into_mutations() {
                if let SharedStoreMutation::Set { key, value } = change {
                    values.insert(key, value);
                }
            }
        }
        let config = Config::from_map(&values);
        assert_eq!(config.shortcut, "Control+Shift+S");
        assert!(!config.global_shortcut_enabled);
    }

    #[test]
    fn image_bounds_are_checked_before_allocation() {
        assert!(validate_dimensions(1920, 1080, (3840, 2160)).is_ok());
        assert!(validate_dimensions(0, 100, (3840, 2160)).is_err());
        assert!(validate_dimensions(3841, 100, (3840, 2160)).is_err());
        assert!(validate_dimensions(u32::MAX, u32::MAX, (u32::MAX, u32::MAX)).is_err());
    }

    #[test]
    fn stale_callbacks_cannot_export_a_new_session() {
        let session = Session {
            frame: Frame {
                token: "new".into(),
                width: 1,
                height: 1,
                language: "en".into(),
            },
            png: None,
            started: Instant::now(),
            capture_ms: 0,
            encode_ms: 0,
            presented: false,
            exporting: false,
        };
        assert!(session.check_token("old").is_err());
        assert!(session.check_token("new").is_ok());
    }
}
