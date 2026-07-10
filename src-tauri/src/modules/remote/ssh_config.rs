//! Minimal OpenSSH config importer.
//!
//! Adapted from meatshell `src/ssh_config.rs` (MIT OR Apache-2.0). Terax keeps
//! the deliberately small import surface: HostName, User, Port and IdentityFile.

use std::path::Path;

use super::models::ImportedHost;

pub fn parse_default() -> Vec<ImportedHost> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    match std::fs::read_to_string(home.join(".ssh").join("config")) {
        Ok(text) => parse_str(&text, &home),
        Err(_) => Vec::new(),
    }
}

fn split_kv(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    let (key, value) = if let Some(eq) = line.find('=') {
        let space = line.find(char::is_whitespace).unwrap_or(usize::MAX);
        if eq < space {
            (&line[..eq], &line[eq + 1..])
        } else {
            line.split_once(char::is_whitespace)?
        }
    } else {
        line.split_once(char::is_whitespace)?
    };
    let value = value.trim().trim_matches('"').trim();
    (!value.is_empty()).then(|| (key.trim().to_ascii_lowercase(), value.to_string()))
}

fn expand_tilde(path: &str, home: &Path) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest).to_string_lossy().replace('\\', "/")
    } else if path == "~" {
        home.to_string_lossy().replace('\\', "/")
    } else {
        path.replace('\\', "/")
    }
}

fn is_concrete(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains(['*', '?', '!'])
}

fn is_valid_hostname(value: &str) -> bool {
    if value.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    !value.is_empty()
        && value.len() <= 253
        && value.split('.').all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 63
                && bytes
                    .iter()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
                && bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
        })
}

pub fn parse_str(text: &str, home: &Path) -> Vec<ImportedHost> {
    let mut hosts = Vec::new();
    let mut current: Option<ImportedHost> = None;
    let flush = |current: &mut Option<ImportedHost>, hosts: &mut Vec<ImportedHost>| {
        if let Some(mut host) = current.take() {
            if host.hostname.is_empty() {
                host.hostname = host.alias.clone();
            }
            if is_valid_hostname(&host.hostname) {
                hosts.push(host);
            }
        }
    };

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_kv(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                flush(&mut current, &mut hosts);
                if let Some(alias) = value.split_whitespace().find(|v| is_concrete(v)) {
                    current = Some(ImportedHost {
                        alias: alias.into(),
                        hostname: String::new(),
                        user: String::new(),
                        port: 22,
                        identity_file: String::new(),
                    });
                }
            }
            "hostname" => {
                if let Some(host) = current.as_mut() {
                    host.hostname = value;
                }
            }
            "user" => {
                if let Some(host) = current.as_mut() {
                    host.user = value;
                }
            }
            "port" => {
                if let (Some(host), Ok(port)) = (current.as_mut(), value.parse()) {
                    host.port = port;
                }
            }
            "identityfile" => {
                if let Some(host) = current.as_mut().filter(|h| h.identity_file.is_empty()) {
                    host.identity_file = expand_tilde(&value, home);
                }
            }
            _ => {}
        }
    }
    flush(&mut current, &mut hosts);
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_concrete_hosts_only() {
        let hosts = parse_str(
            "Host prod\n HostName 10.0.0.5\n User deploy\n Port 2222\n IdentityFile ~/.ssh/id_ed25519\nHost *\n User ignored\n",
            Path::new("/home/me"),
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
        assert_eq!(hosts[0].port, 2222);
    }
}
