//! 无 WebView 宿主的真实管道集成测试。
//!
//! 验证文件版本冲突不能覆盖外部修改，并在客户端断开时清理实际运行的 Shell。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

struct HostProcess {
    child: Child,
    output: BufReader<ChildStdout>,
    next: u64,
}

impl HostProcess {
    /// 启动只绑定测试目录的独立原生宿主。
    fn new(root: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_terax-host"))
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            output,
            next: 0,
        }
    }

    /// 顺序发出协议请求并验证响应身份。
    fn call(&mut self, command: &str, args: Value) -> Value {
        self.next += 1;
        writeln!(
            self.child.stdin.as_mut().unwrap(),
            "{}",
            json!({ "id": self.next, "command": command, "args": args })
        )
        .unwrap();
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], self.next);
        response
    }

    /// 通过 EOF 触发清理，并有界等待实际进程退出。
    fn disconnect(&mut self) {
        self.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(Instant::now() < deadline, "host did not clean up after EOF");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.child.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn pipe_host_preserves_read_before_edit_and_conflict_checks() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("note.txt");
    std::fs::write(&path, "before").unwrap();
    let mut host = HostProcess::new(root.path());
    let context = json!({ "ownerSessionId": "6b9145ce-933e-4c54-8a4b-90831a2e4d84", "toolCallId": "read", "visibleReadIds": [], "root": root.path(), "permissionMode": "ask", "path": "note.txt" });
    assert!(host
        .call("agent_file_read", json!({"request": context}))
        .get("result")
        .is_some());
    let prepared = host.call("agent_file_prepare_mutation", json!({"request": {
        "ownerSessionId": "6b9145ce-933e-4c54-8a4b-90831a2e4d84", "toolCallId": "change", "root": root.path(), "permissionMode": "ask",
        "mutation": {"kind": "write", "path": "note.txt", "content": "after", "mode": "rewrite"}
    }}));
    assert!(prepared.get("result").is_some(), "{prepared}");
    std::fs::write(&path, "external change").unwrap();
    let result = host.call("agent_file_commit_mutation", json!({"request": {"ownerSessionId": "6b9145ce-933e-4c54-8a4b-90831a2e4d84", "toolCallId": "change"}}));
    assert!(result.get("error").is_some(), "{result}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "external change");
    host.disconnect();
}

#[test]
fn pipe_eof_terminates_the_owned_shell() {
    let root = tempfile::tempdir().unwrap();
    let mut host = HostProcess::new(root.path());
    let environment = host.call("shell_environment", json!({}));
    assert!(!environment["result"].as_array().unwrap().is_empty());
    assert_eq!(
        host.call("shell_environment", json!({}))["result"],
        environment["result"]
    );
    let command = if cfg!(windows) {
        "$PID; Start-Sleep -Seconds 30"
    } else {
        "echo $$; sleep 30"
    };
    let result = host.call("shell_exec", json!({
        "ownerSessionId": "6b9145ce-933e-4c54-8a4b-90831a2e4d84", "command": command, "initialCwd": root.path(), "cwd": root.path(),
        "permissionMode": "full-access", "timeoutSecs": 30, "yieldTimeMs": 1000, "maxOutputBytes": 4096, "shell": "default", "login": false
    }));
    assert_eq!(result["result"]["status"], "running", "{result}");
    let pid: u32 = result["result"]["stdout"]
        .as_str()
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    host.disconnect();
    #[cfg(unix)]
    assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            let result = WaitForSingleObject(handle, 2000);
            CloseHandle(handle);
            assert_eq!(result, WAIT_OBJECT_0);
        }
    }
}

#[test]
fn detached_service_is_not_listed_and_survives_host_exit() {
    let root = tempfile::tempdir().unwrap();
    let ready = root.path().join("ready");
    let release = root.path().join("release");
    let finished = root.path().join("finished");
    #[cfg(unix)]
    let (command, shell) = (
        "nohup sh -c 'touch ready; i=0; while [ ! -e release ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done; [ ! -e release ] || echo done > finished' </dev/null >service.log 2>&1 &".to_string(),
        "sh",
    );
    #[cfg(windows)]
    let (command, shell) = {
        std::fs::write(
            root.path().join("service.ps1"),
            r#"[IO.File]::WriteAllText('ready', 'ready')
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while (![IO.File]::Exists('release') -and [DateTime]::UtcNow -lt $deadline) { [Threading.Thread]::Sleep(20) }
if ([IO.File]::Exists('release')) { [IO.File]::WriteAllText('finished', 'done') }"#,
        )
        .unwrap();
        // WMI 由系统服务创建进程，不继承受管启动 Shell 的 Job Object。
        (
            r#"$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
[Console]::WriteLine('loading CimCmdlets')
Import-Module "$PSHOME\Modules\CimCmdlets\CimCmdlets.psd1"
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$command = '"{0}\System32\cmd.exe" /d /s /c ""{0}\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File service.ps1 <NUL >service.log 2>&1"' -f $env:SystemRoot
[Console]::WriteLine('creating WMI process')
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $PWD.Path; ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0 -or !$result.ProcessId) { throw "Create failed: $($result.ReturnValue)" }
$result.ProcessId"#
                .to_string(),
            "powershell",
        )
    };
    let mut host = HostProcess::new(root.path());
    let owner = "6b9145ce-933e-4c54-8a4b-90831a2e4d84";
    let yield_time_ms = if cfg!(windows) { 0 } else { 10000 };
    let result = host.call("shell_exec", json!({
        "ownerSessionId": owner, "command": command, "initialCwd": root.path(), "cwd": root.path(),
        "permissionMode": "full-access", "timeoutSecs": 35, "yieldTimeMs": yield_time_ms, "maxOutputBytes": 4096, "shell": shell, "login": false
    }));
    #[cfg(windows)]
    let result = if result["result"]["status"] == "running" {
        host.call(
            "shell_process",
            json!({"ownerSessionId": owner, "processId": result["result"]["process_id"],
                "action": "close_stdin", "closeStdin": false, "yieldTimeMs": 30000}),
        )
    } else {
        result
    };
    assert_eq!(result["result"]["status"], "exited", "{result}");
    assert_eq!(result["result"]["exit_code"], 0, "{result}");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        ready.exists(),
        "service did not start: {result}\n{}",
        std::fs::read_to_string(root.path().join("service.log")).unwrap_or_default()
    );
    assert_eq!(
        host.call(
            "shell_list",
            json!({"ownerSessionId": owner, "includeExited": false})
        )["result"],
        json!([])
    );
    assert!(host
        .call("shell_clear_owner", json!({"ownerSessionId": owner}))
        .get("error")
        .is_none());
    host.disconnect();
    // 宿主实际退出以后才让服务写入结果，避免仅验证启动命令已经返回。
    std::fs::write(release, "continue").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !finished.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        finished.exists(),
        "detached service did not survive host exit\n{}",
        std::fs::read_to_string(root.path().join("service.log")).unwrap_or_default()
    );
}
