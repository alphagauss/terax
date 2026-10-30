//! 桌面与后台任务共用环境身份和持久化文件名，保证命名规则只有一份。

use super::workspace::WorkspaceEnv;
use uuid::Uuid;

pub struct EnvironmentIdentity {
    pub key: String,
    pub filename_key: String,
}

pub fn environment_identity(env: &WorkspaceEnv) -> Result<EnvironmentIdentity, String> {
    let key = match env {
        WorkspaceEnv::Local => "local".to_string(),
        WorkspaceEnv::Wsl { distro } => format!("wsl:{distro}"),
        WorkspaceEnv::Ssh { profile_id } => {
            let profile = crate::modules::remote::profile::load(profile_id)?;
            profile.endpoint_key()
        }
    };
    let filename_key = match env {
        WorkspaceEnv::Local => "local".to_string(),
        WorkspaceEnv::Wsl { distro } => format!("wsl-{}", filename_component(distro)),
        WorkspaceEnv::Ssh { .. } => format!("ssh-{}", filename_component(&key["ssh:".len()..])),
    };
    Ok(EnvironmentIdentity { key, filename_key })
}

/// 返回可安全用于持久化文件名前缀的 Workspace 环境标识。
pub fn environment_filename_key(env: &WorkspaceEnv) -> Result<String, String> {
    Ok(environment_identity(env)?.filename_key)
}

fn filename_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            result.push(char::from(byte));
        } else {
            result.push('_');
            result.push_str(&format!("{byte:02x}"));
        }
    }
    if result.len() <= 120 {
        result
    } else {
        Uuid::new_v5(&Uuid::NAMESPACE_URL, value.as_bytes()).to_string()
    }
}

/// 确认调用仍属于启动时绑定的 SSH profile 和 endpoint。
pub fn assert_ssh_runtime_owner(
    environment: &WorkspaceEnv,
    environment_key: &str,
    profile: &crate::modules::remote::models::SshProfile,
) -> Result<(), String> {
    match environment {
        WorkspaceEnv::Ssh {
            profile_id: active_profile,
        } if active_profile == &profile.id && environment_key == profile.endpoint_key() => Ok(()),
        WorkspaceEnv::Ssh {
            profile_id: active_profile,
        } if active_profile == &profile.id => {
            Err("SSH endpoint changed; open a new Workspace for this profile".into())
        }
        WorkspaceEnv::Ssh { .. } => Err("SSH profile does not match this Workspace".into()),
        _ => Err("SSH connection requires an SSH Workspace".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filename_component_is_windows_safe_and_keeps_short_names_readable() {
        assert_eq!(filename_component("Ubuntu"), "Ubuntu");
        assert_eq!(filename_component("dev@example:22"), "dev_40example_3a22");
    }
}
