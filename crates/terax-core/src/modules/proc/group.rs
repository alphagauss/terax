//! Shell 与 Git 共用的 POSIX 进程组登记和终止脚本。

/// 对已登记的独立进程组先发送 TERM，再发送 KILL；失败保留登记供重试。
pub fn posix_group_kill_command(pid_file: &str, release_exited: bool) -> String {
    let file = crate::modules::shell::quote::shell_quote(pid_file);
    // 只有正常收完输出时释放后代；管道仍被后代持有时，显式取消仍必须终止进程组。
    let release = if release_exited {
        format!("if [ \"$state\" = exited ]; then rm -f -- {file}; exit 0; fi")
    } else {
        String::new()
    };
    // 只将明确的 ESRCH 当作幂等成功；其他失败保留 pid 文件供后续重试。
    format!(
        r#"i=0; while [ ! -s {file} ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done
[ -e {file} ] || exit 0
{{ read -r pid || exit 1; read -r state || state=; }} < {file} || exit 1
{release}
case "$pid" in ''|0|*[!0-9]*) printf '%s\n' 'invalid Agent process group id' >&2; exit 1;; esac
for signal in TERM KILL; do
    if error=$(LC_ALL=C kill -"$signal" -"$pid" 2>&1); then
        [ "$signal" = KILL ] || sleep 1
    else
        case "$error" in
            *'No such process'*|*'no such process'*) break;;
            *) printf '%s\n' "$error" >&2; exit 1;;
        esac
    fi
done
rm -f -- {file}"#
    )
}

/// 在独立会话内登记进程组；调用方使用 setsid 启动，并在收完输出后清理登记。
pub fn posix_group_wrapper(
    payload: &str,
    pid_file: &str,
    shell: &str,
    login: bool,
    release_children: bool,
) -> String {
    let login_flag = if login { " -l" } else { "" };
    let pid_file = crate::modules::shell::quote::shell_quote(pid_file);
    // 追加完成标记而不覆盖 PID，避免并发取消读到截断的登记。
    // 收完输出后只删除登记，显式取消仍可读取原进程组。
    // 取消或断线触发的信号会终止包装器，不会写入该标记。
    let release = if release_children {
        format!("printf 'exited\\n' >> {pid_file}; ")
    } else {
        String::new()
    };
    format!(
        "printf '%s\\n' \"$$\" > {pid_file}; trap 'trap - TERM INT HUP; kill -TERM -$$ 2>/dev/null || true' TERM INT HUP; {shell}{login_flag} -c {}; rc=$?; {release}exit $rc",
        crate::modules::shell::quote::shell_quote(payload)
    )
}

/// 本地 POSIX 子进程在独立进程组中启动，取消时一并回收其后代。
#[cfg(unix)]
pub fn terminate_local_group(pid: u32) -> Result<(), String> {
    for signal in [libc::SIGTERM, libc::SIGKILL] {
        if unsafe { libc::kill(-(pid as libc::pid_t), signal) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(error.to_string());
        }
        if signal == libc::SIGTERM {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    Ok(())
}

/// 经 WSL 入口执行共用的进程组清理，不只结束 Windows 侧的 wsl.exe。
pub fn terminate_wsl_group(
    distro: &str,
    pid_file: &str,
    release_exited: bool,
) -> Result<(), String> {
    let mut command = std::process::Command::new("wsl.exe");
    command
        .args([
            "-d",
            distro,
            "--exec",
            "/bin/sh",
            "-c",
            &posix_group_kill_command(pid_file, release_exited),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    super::hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return if status.success() {
                Ok(())
            } else {
                Err(format!("terminate WSL process group: {status}"))
            };
        }
        if started.elapsed() >= std::time::Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("terminate WSL process group timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
