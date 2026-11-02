//! 关闭保护的进程核对。Unix 只核对 Shell 报告的作业，避免提示符辅助进程误报。

use std::collections::HashSet;

/// 本机 Unix 和 WSL 共用查询超时、子进程回收及快照解析。
pub async fn query_posix_tasks(
    mut command: tokio::process::Command,
    shell_pid: u32,
    jobs: Option<&[u32]>,
) -> Result<bool, String> {
    command.args(["-e", "-o", "pid=,ppid=,pgid=,stat="]);
    command.kill_on_drop(true);
    #[cfg(windows)]
    terax_core::modules::proc::hide_console(command.as_std_mut());
    let output = tokio::time::timeout(std::time::Duration::from_secs(2), command.output())
        .await
        .map_err(|_| "terminal process check timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("terminal process check failed".into());
    }
    has_posix_tasks(&String::from_utf8_lossy(&output.stdout), shell_pid, jobs)
}

pub fn has_posix_tasks(output: &str, shell_pid: u32, jobs: Option<&[u32]>) -> Result<bool, String> {
    let mut processes = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 4 {
            return Err("invalid terminal process snapshot".into());
        }
        let parse = |value: &str| value.parse::<u32>().map_err(|e| e.to_string());
        processes.push((
            parse(fields[0])?,
            parse(fields[1])?,
            parse(fields[2])?,
            fields[3],
        ));
    }
    if !processes.iter().any(|(pid, _, _, _)| *pid == shell_pid) {
        return Err("terminal shell missing from process snapshot".into());
    }
    let mut descendants = HashSet::from([shell_pid]);
    loop {
        let before = descendants.len();
        for (pid, parent, _, _) in &processes {
            if descendants.contains(parent) {
                descendants.insert(*pid);
            }
        }
        if before == descendants.len() {
            break;
        }
    }
    Ok(processes.iter().any(|(pid, _, group, status)| {
        *pid != shell_pid
            && descendants.contains(pid)
            && !status.starts_with('Z')
            && jobs.is_none_or(|jobs| jobs.contains(pid) || jobs.contains(group))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_live_jobs_without_counting_prompt_helpers_or_other_terminals() {
        let output = "10 1 10 S\n11 10 11 S\n20 10 20 S\n21 10 20 S\n30 10 30 Z\n40 1 40 S\n";
        assert!(!has_posix_tasks(output, 10, Some(&[])).unwrap());
        assert!(has_posix_tasks(output, 10, Some(&[20])).unwrap());
        assert!(!has_posix_tasks(output, 10, Some(&[30, 40, 50])).unwrap());
        // 管道组长已退出，仍需保护同组的后续进程。
        assert!(has_posix_tasks("10 1 10 S\n21 10 20 S\n", 10, Some(&[20])).unwrap());
        assert!(has_posix_tasks(output, 10, None).unwrap());
        assert!(has_posix_tasks("unexpected output", 10, None).is_err());
        assert!(has_posix_tasks("", 10, None).is_err());
    }

    #[tokio::test]
    async fn process_query_timeout_is_not_reported_as_idle() {
        #[cfg(windows)]
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = {
            let script = directory.path().join("slow.ps1");
            std::fs::write(&script, "Start-Sleep -Seconds 30").unwrap();
            let mut command = tokio::process::Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-NonInteractive", "-File"])
                .arg(script);
            command
        };
        #[cfg(unix)]
        let command = {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", "exec sleep 30"]);
            command
        };
        assert_eq!(
            query_posix_tasks(command, 1, None).await.unwrap_err(),
            "terminal process check timed out"
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_reports_root_identity_and_command_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("profile.ps1");
        std::fs::write(
            &profile,
            include_str!("../../../resources/shell-integration/profile.ps1"),
        )
        .unwrap();
        let script = format!(
            "function global:PSConsoleHostReadLine {{ 'Start-Sleep -Seconds 1' }}; . '{}'; prompt | Out-Null; PSConsoleHostReadLine | Out-Null; prompt | Out-Null",
            profile.to_string_lossy().replace('\'', "''"),
        );
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ]);
        terax_core::modules::proc::hide_console(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = String::from_utf8_lossy(&output.stdout);
        let markers: Vec<_> = output
            .split("\x1b]777;terax;tasks;")
            .skip(1)
            .map(|part| part.split("\x1b\\").next().unwrap())
            .collect();
        assert_eq!(markers.len(), 3, "{output:?}");
        let pid = markers[0].split(';').next().unwrap();
        assert!(pid.parse::<u32>().unwrap() > 0);
        assert_eq!(
            markers,
            [
                format!("{pid};idle;?"),
                format!("{pid};running;?"),
                format!("{pid};idle;?")
            ]
        );
    }
}
