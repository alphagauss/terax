//! Linux 桌面静态代理：GNOME 使用 GSettings，KDE 使用 kioslaverc。

use super::{endpoint, SystemProxy};
use std::collections::HashMap;

#[cfg(target_os = "linux")]
pub(super) async fn read() -> Result<SystemProxy, String> {
    if std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .any(|name| name.eq_ignore_ascii_case("KDE"))
    {
        let path = dirs::config_dir()
            .ok_or("system config directory is unavailable")?
            .join("kioslaverc");
        let text = match tokio::fs::read_to_string(path).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SystemProxy::default())
            }
            Err(_) => return Err("unable to read KDE proxy settings".into()),
        };
        return parse_kde(&text);
    }
    let mut command = tokio::process::Command::new("gsettings");
    command
        .args(["list-recursively", "org.gnome.system.proxy"])
        .kill_on_drop(true);
    // AppImage 的库路径只属于应用，不适用于宿主桌面工具。
    if std::env::var_os("APPIMAGE").is_some() {
        command.env_remove("LD_LIBRARY_PATH");
    }
    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(3), command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SystemProxy::default())
            }
            _ => return Err("unable to read desktop proxy settings".into()),
        };
    if !output.status.success() {
        return Err("unable to read GSettings proxy settings".into());
    }
    parse_gnome(
        std::str::from_utf8(&output.stdout).map_err(|_| "invalid GSettings proxy settings")?,
    )
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('\'') && value.ends_with('\''))
            || (value.starts_with('"') && value.ends_with('"')))
    {
        value[1..value.len() - 1]
            .replace("\\'", "'")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        value.to_string()
    }
}

fn parse_gnome(text: &str) -> Result<SystemProxy, String> {
    let mut values = HashMap::new();
    for line in text.lines() {
        let mut fields = line.splitn(3, char::is_whitespace);
        if let (Some(schema), Some(key), Some(value)) =
            (fields.next(), fields.next(), fields.next())
        {
            values.insert(format!("{schema}.{key}"), unquote(value));
        }
    }
    let get = |key: &str| {
        values
            .get(&format!("org.gnome.system.proxy.{key}"))
            .map(String::as_str)
            .unwrap_or("")
    };
    match get("mode") {
        "none" | "auto" => return Ok(SystemProxy::default()),
        "manual" => {}
        _ => return Err("invalid GSettings proxy mode".into()),
    }
    let proxy = |scheme: &str| {
        let host = get(&format!("{scheme}.host"));
        let port = get(&format!("{scheme}.port"));
        if host.is_empty() || port == "0" {
            return Ok(None);
        }
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        endpoint(&format!("{host}:{port}"), scheme == "socks").map(Some)
    };
    let mut http = proxy("http")?;
    if get("http.use-authentication") == "true" {
        if let Some(proxy) = &mut http {
            let user = get("http.authentication-user");
            if !user.is_empty() {
                proxy.username = Some(user.to_string());
                proxy.password = Some(get("http.authentication-password").to_string());
            }
        }
    }
    let https = proxy("https")?.or_else(|| http.clone());
    let bypass = get("ignore-hosts")
        .trim_start_matches("@as ")
        .trim_matches(['[', ']'])
        .split(',')
        .map(unquote)
        .filter(|value| !value.is_empty())
        // GNOME 的域名例外同时匹配域名本身和子域；IP 及 CIDR 仍按地址匹配。
        .map(|rule| {
            if rule.parse::<std::net::IpAddr>().is_ok()
                || rule.parse::<ipnet::IpNet>().is_ok()
                || rule.starts_with('[')
            {
                rule
            } else {
                format!(
                    ".{}",
                    rule.strip_prefix("*.")
                        .unwrap_or(&rule)
                        .trim_start_matches('.')
                )
            }
        })
        .collect();
    Ok(SystemProxy {
        http,
        https,
        socks: proxy("socks")?,
        bypass,
        ..Default::default()
    })
}

fn parse_kde(text: &str) -> Result<SystemProxy, String> {
    let mut active = false;
    let mut values = HashMap::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            active = line == "[Proxy Settings]";
        } else if active {
            if let Some((key, value)) = line.split_once('=') {
                values.insert(key.trim(), value.trim());
            }
        }
    }
    let get = |key| values.get(key).copied().unwrap_or("");
    if get("ProxyType") != "1" {
        return Ok(SystemProxy::default());
    }
    let proxy = |key, socks| {
        let value = get(key);
        if value.is_empty() || value.starts_with("//:") {
            return Ok(None);
        }
        endpoint(&value.replace(' ', ":"), socks).map(Some)
    };
    Ok(SystemProxy {
        http: proxy("httpProxy", false)?,
        https: proxy("httpsProxy", false)?,
        socks: proxy("socksProxy", true)?,
        // KDE 的主机例外按后缀匹配，IP 和本地域名标记保留原有语义。
        bypass: get("NoProxyFor")
            .split([',', ' '])
            .filter(|rule| !rule.is_empty())
            .map(|rule| {
                if rule.eq_ignore_ascii_case("<local>")
                    || rule.contains(['*', '?'])
                    || rule
                        .trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok()
                    || rule.parse::<ipnet::IpNet>().is_ok()
                {
                    rule.to_string()
                } else {
                    format!("*{rule}")
                }
            })
            .collect(),
        reverse_bypass: get("ReversedException") == "true",
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_manual_modes_and_unsupported_auto_modes_are_distinct() {
        let gnome = "org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy ignore-hosts ['localhost', '*.internal']\norg.gnome.system.proxy.http host '127.0.0.1'\norg.gnome.system.proxy.http port 8080\norg.gnome.system.proxy.https host ''\norg.gnome.system.proxy.socks host '127.0.0.1'\norg.gnome.system.proxy.socks port 1080";
        let settings = parse_gnome(gnome).unwrap();
        assert_eq!(
            settings
                .for_destination("https", "api.example", 443)
                .unwrap()
                .port,
            8080
        );
        assert_eq!(
            settings
                .for_destination("ssh", "api.example", 22)
                .unwrap()
                .port,
            1080
        );
        for host in ["internal", "a.internal", "localhost", "sub.localhost"] {
            assert!(settings.for_destination("https", host, 443).is_none());
        }
        assert!(settings
            .for_destination("https", "notinternal", 443)
            .is_some());
        assert!(parse_gnome(&gnome.replace("'manual'", "'auto'"))
            .unwrap()
            .http
            .is_none());
        let kde = "[Proxy Settings]\nProxyType=1\nhttpProxy=http://127.0.0.1 8080\nhttpsProxy=//: 0\nsocksProxy=//: 0\nNoProxyFor=localhost,.internal example.com 10.0.0.0/8 <local>\n";
        let settings = parse_kde(kde).unwrap();
        assert_eq!(settings.http.as_ref().unwrap().port, 8080);
        assert!(settings.https.is_none());
        assert!(settings.socks.is_none());
        for host in [
            "localhost",
            "a.internal",
            "api.example.com",
            "10.1.2.3",
            "intranet",
        ] {
            assert!(settings.for_destination("http", host, 80).is_none());
        }
        assert!(settings
            .for_destination("http", "api.external", 80)
            .is_some());
        let reversed = parse_kde(&format!("{kde}ReversedException=true\n")).unwrap();
        assert!(reversed
            .for_destination("http", "api.example.com", 80)
            .is_some());
        assert!(reversed
            .for_destination("http", "api.external", 80)
            .is_none());
        assert!(parse_kde(&kde.replace("ProxyType=1", "ProxyType=2"))
            .unwrap()
            .http
            .is_none());
    }
}
