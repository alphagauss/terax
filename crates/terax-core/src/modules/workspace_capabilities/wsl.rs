//! WSL 工作区能力探测，仅检查 Terax 会在当前发行版中调用的工具。

use super::{
    checked_at, feature, parse_command_report, report_state, CapabilityReport, ARCHIVE_COMMANDS,
    GIT_COMMANDS, PASTE_COMMANDS, SYNC_COMMANDS,
};

#[cfg(windows)]
const SOURCE: &str = concat!(
    include_str!("../workspace_capabilities_common.sh"),
    include_str!("wsl.sh")
);

const COMMANDS: &[(&str, &str)] = &[
    ("sh", "sh"),
    ("bash", "bash"),
    ("setsid", "setsid --wait"),
    ("git", "git"),
    ("head", "head -c"),
    ("cat", "cat"),
    ("wc", "wc -c"),
    ("find", "find -printf"),
    ("stat", "stat -c / --printf"),
    ("awk", "awk"),
    ("rm", "rm -rf --"),
    ("mktemp", "mktemp -d"),
    ("cp_archive", "cp -a"),
    ("chmod_recursive", "chmod -R u+rwX"),
    ("python3_renameat2", "python3 / ctypes / renameat2"),
    ("chmod_reference", "chmod --reference"),
    ("mv_force", "mv -f"),
    ("ln_create", "ln"),
    ("sha256sum", "sha256sum"),
    ("tar_gzip", "tar -czf / -xzf"),
    ("tar_sync", "tar --null --no-recursion"),
    ("gzip", "gzip"),
    ("sha256", "SHA-256"),
];

/// 在启动时绑定的发行版中探测能力，适用于状态栏首轮加载与显式重检。
#[cfg(windows)]
pub async fn probe_wsl(distro: &str) -> Result<CapabilityReport, String> {
    use std::{process::Stdio, time::Duration};

    crate::modules::workspace::validate_wsl_distro_name(distro)?;
    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .args(["-d", distro, "--exec", "sh", "-c", SOURCE])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    crate::modules::proc::hide_console(command.as_std_mut());
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "WSL capability probe timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("WSL capability probe failed".into());
    }
    build_report(&output.stdout)
}

fn build_report(bytes: &[u8]) -> Result<CapabilityReport, String> {
    let commands = parse_command_report(bytes, COMMANDS)?;
    let describe =
        |id, required, backend, fallback| feature(&commands, id, required, backend, fallback);
    let features = vec![
        describe("git", GIT_COMMANDS, "git", None),
        describe("file_version", &["sha256sum"], "sha256sum", None),
        describe("file_properties", &["stat"], "stat", None),
        describe(
            "directory_summary",
            &["bash", "find", "awk"],
            "find+awk",
            Some("Rust"),
        ),
        describe(
            "file_write",
            &[
                "sh",
                "sha256sum",
                "chmod_reference",
                "mv_force",
                "ln_create",
                "rm",
            ],
            "sh",
            None,
        ),
        describe("recursive_delete", &["rm"], "rm", None),
        describe("agent_processes", &["sh", "setsid", "rm"], "setsid", None),
        describe("explorer_paste", PASTE_COMMANDS, "bash", None),
        describe("archive_transfer", ARCHIVE_COMMANDS, "tar", None),
        describe("folder_sync", SYNC_COMMANDS, "tar", None),
    ];
    Ok(CapabilityReport {
        state: report_state(&features),
        checked_at: checked_at(),
        commands,
        features,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workspace_capabilities::CapabilityState;

    #[test]
    fn distro_report_separates_paste_dependencies_from_search_and_directory_summary() {
        let mut bytes = b"TERAX_CAPABILITIES_V1\0".to_vec();
        for (id, _) in COMMANDS {
            bytes.extend_from_slice(id.as_bytes());
            bytes.extend_from_slice(match *id {
                "python3_renameat2" | "find" => b"\0missing\0\0",
                _ => b"\0ready\0\0",
            });
        }
        bytes.extend_from_slice(b"END\0");
        let report = build_report(&bytes).unwrap();
        let state = |id| {
            report
                .features
                .iter()
                .find(|feature| feature.id == id)
                .unwrap()
                .state
        };
        assert_eq!(state("explorer_paste"), CapabilityState::Unavailable);
        assert_eq!(state("directory_summary"), CapabilityState::Fallback);
        assert_eq!(state("folder_sync"), CapabilityState::Unavailable);
        assert_eq!(state("archive_transfer"), CapabilityState::Ready);
        assert_eq!(state("git"), CapabilityState::Ready);
        assert!(report
            .commands
            .iter()
            .all(|command| !command.id.starts_with("rg")));
    }
}
