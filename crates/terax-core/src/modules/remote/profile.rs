//! SSH profile 的原生读取入口。
//!
//! Workspace 身份校验和 Runtime 连接共享同一份反序列化逻辑，避免前端回传配置
//! 或不同原生模块各自解析持久化文件。

use super::models::SshProfile;

/// SSH 登录及服务器专用代理凭据共享的秘密服务标识。
pub const SECRET_SERVICE: &str = "terax-ssh";

/// 拒绝可能越过共享存储键空间的 profile ID。
fn validate_id(profile_id: &str) -> Result<(), String> {
    if profile_id.is_empty()
        || profile_id.contains(['/', '\\'])
        || profile_id.chars().any(char::is_control)
    {
        return Err("invalid SSH profile id".to_string());
    }
    Ok(())
}

/// 确认持久化值没有伪装成另一个 profile。
fn validate_stored_profile_id(profile_id: &str, profile: &SshProfile) -> Result<(), String> {
    if profile.id != profile_id {
        return Err(format!(
            "SSH profile id does not match its storage key: {profile_id}"
        ));
    }
    Ok(())
}

/// 从共享 profile 存储读取指定配置。
pub fn load(profile_id: &str) -> Result<SshProfile, String> {
    validate_id(profile_id)?;
    let profile =
        crate::modules::shared_store::read_value("ssh-profiles", &format!("profile:{profile_id}"))?
            .ok_or_else(|| format!("SSH profile not found: {profile_id}"))?;
    validate_stored_profile_id(profile_id, &profile)?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::{validate_id, validate_stored_profile_id};
    use crate::modules::remote::models::{SshAuthMethod, SshProfile};

    #[test]
    fn profile_ids_cannot_escape_the_shared_store_keyspace() {
        assert!(validate_id("ssh-production").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../production").is_err());
        assert!(validate_id("group\\production").is_err());
        assert!(validate_id("production\nnext").is_err());
    }

    #[test]
    fn profile_id_must_match_its_storage_key() {
        let profile = SshProfile {
            id: "production".to_string(),
            name: "Production".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: SshAuthMethod::Agent,
            identity_file: None,
            proxy_url: None,
            proxy_mode: crate::modules::network_proxy::SshProxyMode::Direct,
            reconnect_enabled: true,
            reconnect_max_attempts: 2,
            root_path: None,
            tunnels: Vec::new(),
        };

        assert!(validate_stored_profile_id("production", &profile).is_ok());
        assert!(validate_stored_profile_id("staging", &profile).is_err());
    }
}
