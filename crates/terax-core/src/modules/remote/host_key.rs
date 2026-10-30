//! SSH 主机密钥的 TOFU 校验、持久化与确认事件桥接。
//!
//! 每个未知或变化的密钥只在当前连接生命周期内等待确认。连接被新意图取消时同步
//! 移除 pending 请求，避免迟到对话框影响下一次 transport。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use russh::keys::ssh_key::{HashAlg, PublicKey};
use serde::Serialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostKeyStatus {
    Unknown,
    Match,
    Changed,
}

struct PendingVerification {
    host: String,
    port: u16,
    key: String,
    prompt: HostKeyPrompt,
    sender: oneshot::Sender<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    request_id: String,
    profile_id: String,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
    changed: bool,
}

/// 管理 known_hosts 校验和当前进程内待确认请求。
pub struct HostKeyVerifier {
    path: PathBuf,
    pending: tokio::sync::Mutex<HashMap<String, PendingVerification>>,
    trusted_once: Mutex<HashMap<String, (String, Instant)>>,
    file_lock: Mutex<()>,
}

impl HostKeyVerifier {
    /// 使用指定 known_hosts 文件创建校验器。
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: tokio::sync::Mutex::new(HashMap::new()),
            trusted_once: Mutex::new(HashMap::new()),
            file_lock: Mutex::new(()),
        }
    }

    fn id(host: &str, port: u16) -> String {
        format!("{host}:{port}")
    }

    fn key_line(key: &PublicKey) -> String {
        key.to_openssh()
            .unwrap_or_else(|_| key.fingerprint(HashAlg::Sha256).to_string())
    }

    fn load(&self) -> Vec<(String, String)> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    return None;
                }
                let (id, key) = line.split_once(char::is_whitespace)?;
                Some((id.to_string(), key.trim().to_string()))
            })
            .collect()
    }

    fn verify(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
        let wanted = Self::key_line(key);
        let id = Self::id(host, port);
        let mut seen = false;
        for (entry_id, entry_key) in self.load() {
            if entry_id != id {
                continue;
            }
            seen = true;
            if entry_key == wanted {
                return HostKeyStatus::Match;
            }
        }
        if seen {
            HostKeyStatus::Changed
        } else {
            HostKeyStatus::Unknown
        }
    }

    fn remember(&self, host: &str, port: u16, key: &str) -> Result<(), String> {
        let _guard = self.file_lock.lock().map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let id = Self::id(host, port);
        let mut output = String::new();
        for (entry_id, entry_key) in self.load() {
            if entry_id == id {
                continue;
            }
            output.push_str(&entry_id);
            output.push(' ');
            output.push_str(&entry_key);
            output.push('\n');
        }
        output.push_str(&id);
        output.push(' ');
        output.push_str(key);
        output.push('\n');
        std::fs::write(&self.path, output).map_err(|e| e.to_string())
    }

    /// 校验服务端主机密钥，必要时等待前端确认或当前连接取消。
    pub async fn check(
        &self,
        app: &crate::modules::remote::RemoteHost,
        profile_id: &str,
        host: &str,
        port: u16,
        key: &PublicKey,
        cancellation: &CancellationToken,
    ) -> bool {
        let status = self.verify(host, port, key);
        if status == HostKeyStatus::Match {
            return true;
        }
        let id = Self::id(host, port);
        let key_line = Self::key_line(key);
        if self
            .trusted_once
            .lock()
            .ok()
            .and_then(|mut trusted| {
                trusted
                    .retain(|_, (_, accepted_at)| accepted_at.elapsed() < Duration::from_secs(120));
                trusted.get(&id).cloned()
            })
            .is_some_and(|(accepted_key, _)| accepted_key == key_line)
        {
            return true;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let prompt = HostKeyPrompt {
            request_id: request_id.clone(),
            profile_id: profile_id.to_string(),
            host: host.to_string(),
            port,
            key_type: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            changed: status == HostKeyStatus::Changed,
        };
        self.pending.lock().await.insert(
            request_id.clone(),
            PendingVerification {
                host: host.to_string(),
                port,
                key: key_line,
                prompt: prompt.clone(),
                sender,
            },
        );
        if app.events.emit("terax://ssh-host-key", prompt).is_err() {
            self.pending.lock().await.remove(&request_id);
            return false;
        }
        let confirmation = tokio::select! {
            _ = cancellation.cancelled() => None,
            result = tokio::time::timeout(Duration::from_secs(90), receiver) => Some(result),
        };
        match confirmation {
            Some(Ok(Ok(accepted))) => accepted,
            _ => {
                self.pending.lock().await.remove(&request_id);
                false
            }
        }
    }

    /// 返回指定 profile 当前仍在等待处理的主机密钥提示。
    pub async fn pending_prompt(&self, profile_id: &str) -> Option<HostKeyPrompt> {
        self.pending
            .lock()
            .await
            .values()
            .find(|pending| pending.prompt.profile_id == profile_id)
            .map(|pending| pending.prompt.clone())
    }

    /// 建连失败或被替换后移除失效的主机密钥确认，避免后台重试重复提示。
    pub async fn cancel_pending(&self, profile_id: &str) -> bool {
        let mut pending = self.pending.lock().await;
        let count = pending.len();
        pending.retain(|_, entry| entry.prompt.profile_id != profile_id);
        pending.len() != count
    }

    /// 完成一次仍在等待的主机密钥确认，并按用户选择写入 known_hosts。
    pub async fn confirm(
        &self,
        request_id: &str,
        accepted: bool,
        remember: bool,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| "host-key verification request not found".to_string())?;
        if accepted && remember {
            self.remember(&pending.host, pending.port, &pending.key)?;
        }
        if accepted {
            self.trusted_once
                .lock()
                .map_err(|error| error.to_string())?
                .insert(
                    Self::id(&pending.host, pending.port),
                    (pending.key.clone(), Instant::now()),
                );
        }
        let _ = pending.sender.send(accepted);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_prompt_survives_event_bridge_registration_race() {
        let verifier = HostKeyVerifier::new(std::env::temp_dir().join("terax-known-hosts-test"));
        let prompt = HostKeyPrompt {
            request_id: "request".to_string(),
            profile_id: "profile".to_string(),
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:test".to_string(),
            changed: false,
        };
        let (sender, _receiver) = oneshot::channel();
        verifier.pending.lock().await.insert(
            prompt.request_id.clone(),
            PendingVerification {
                host: prompt.host.clone(),
                port: prompt.port,
                key: "key".to_string(),
                prompt: prompt.clone(),
                sender,
            },
        );

        let restored = verifier.pending_prompt("profile").await.unwrap();
        assert_eq!(restored.request_id, prompt.request_id);
        assert!(verifier.pending_prompt("other").await.is_none());
        assert!(verifier.cancel_pending("profile").await);
        assert!(verifier.pending_prompt("profile").await.is_none());
    }
}
