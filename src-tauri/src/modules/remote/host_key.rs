//! TOFU host-key verification and confirmation bridge.
//!
//! The on-disk format and changed-key behavior are adapted from meatshell's
//! `known_hosts.rs`; the pending Tauri request bridge follows Eussh's
//! `ssh/host_key.rs`. Both sources are modified for Terax's app data path.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use russh::keys::ssh_key::{HashAlg, PublicKey};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::oneshot;

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
    sender: oneshot::Sender<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostKeyPrompt {
    request_id: String,
    profile_id: String,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
    changed: bool,
}

pub struct HostKeyVerifier {
    path: PathBuf,
    pending: tokio::sync::Mutex<HashMap<String, PendingVerification>>,
    trusted_once: Mutex<HashMap<String, (String, Instant)>>,
    file_lock: Mutex<()>,
}

impl HostKeyVerifier {
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

    pub async fn check(
        &self,
        app: &tauri::AppHandle,
        profile_id: &str,
        host: &str,
        port: u16,
        key: &PublicKey,
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
        self.pending.lock().await.insert(
            request_id.clone(),
            PendingVerification {
                host: host.to_string(),
                port,
                key: key_line,
                sender,
            },
        );
        let prompt = HostKeyPrompt {
            request_id: request_id.clone(),
            profile_id: profile_id.to_string(),
            host: host.to_string(),
            port,
            key_type: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            changed: status == HostKeyStatus::Changed,
        };
        if app.emit("terax://ssh-host-key", prompt).is_err() {
            self.pending.lock().await.remove(&request_id);
            return false;
        }
        match tokio::time::timeout(Duration::from_secs(90), receiver).await {
            Ok(Ok(accepted)) => accepted,
            _ => {
                self.pending.lock().await.remove(&request_id);
                false
            }
        }
    }

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
