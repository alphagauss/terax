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
    let context = json!({ "ownerSessionId": "6b9145ce-933e-4c54-8a4b-90831a2e4d84", "root": root.path(), "permissionMode": "ask", "path": "note.txt" });
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
