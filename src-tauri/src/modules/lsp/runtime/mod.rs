//! 进程级 LSP 宿主。管理本地语言服务器、二进制消息与退出回执，复用 Workspace 的目录授权。

mod env;
mod framing;
mod rss;
mod session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use session::LspSession;
use terax_core::events::OutputSink;
use terax_core::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use terax_core::runtime::spawn_blocking;

pub use session::LspExit;

/// 一次启动请求的命令、环境与资源限制。
pub struct LspLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub root: String,
    pub max_rss_mb: Option<u64>,
    pub workspace: WorkspaceEnv,
}

/// 每个 Workspace 进程独占会话表，关闭后拒绝新的启动请求。
pub struct LspState {
    sessions: Mutex<HashMap<u32, Arc<LspSession>>>,
    stopped: RwLock<bool>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            stopped: RwLock::new(false),
            next_id: AtomicU32::new(1),
        }
    }
}

impl LspState {
    fn take(&self, id: u32) -> Option<Arc<LspSession>> {
        self.sessions.lock().unwrap().remove(&id)
    }

    /// 校验本地工作目录后在阻塞线程启动子进程。进程登记与退出回收共享同一把锁。
    pub async fn spawn(
        self: &Arc<Self>,
        registry: &WorkspaceRegistry,
        launch: LspLaunch,
        on_message: OutputSink<Vec<u8>>,
        on_exit: OutputSink<LspExit>,
    ) -> Result<u32, String> {
        if launch.workspace.is_wsl() || launch.workspace.is_ssh() {
            return Err("lsp: non-local workspaces are not supported yet".into());
        }
        let root = authorize_spawn_cwd(registry, Some(&launch.root), &launch.workspace)?
            .ok_or("lsp: workspace root is required")?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let state = Arc::clone(self);
        spawn_blocking(move || {
            let binary = env::resolve_binary(&launch.command)
                .ok_or_else(|| format!("lsp: binary not found: {}", launch.command))?;
            // 启动之间可并行；关闭要等所有已开始的启动完成登记，随后才能清空会话表。
            let stopped = state.stopped.read().unwrap();
            if *stopped {
                return Err("lsp: host is shutting down".into());
            }
            let session = session::spawn(
                id,
                Arc::downgrade(&state),
                &binary,
                &launch.args,
                &launch.env,
                &root,
                launch.max_rss_mb,
                on_message,
                on_exit,
            )?;
            let mut sessions = state.sessions.lock().unwrap();
            // 快速退出可能已触发回收。持表锁检查，避免在退出线程移除后重新插入。
            if !session.exited.load(Ordering::Acquire) {
                sessions.insert(id, session);
            }
            drop(sessions);
            drop(stopped);
            log::info!(
                "lsp spawned id={id} cmd={} root={}",
                launch.command,
                root.display()
            );
            Ok(id)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// 向服务器写入一条消息。等待管道可写时不占用会话锁和宿主事件线程。
    pub async fn send(&self, id: u32, message: String) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("lsp_send: unknown id={id}"))?;
        spawn_blocking(move || session.write_message(&message))
            .await
            .map_err(|e| e.to_string())?
    }

    pub fn kill(&self, id: u32) {
        if let Some(session) = self.take(id) {
            session.kill();
            log::info!("lsp killed id={id}");
        }
    }

    /// 关闭进程宿主；后续启动不能留下未登记的服务器。
    pub fn shutdown(&self) {
        *self.stopped.write().unwrap() = true;
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for session in sessions.into_values() {
            session.kill();
        }
    }
}

impl Drop for LspState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 在与服务器启动一致的环境中查找可执行文件。
pub async fn detect(command: String) -> Option<String> {
    spawn_blocking(move || env::resolve_binary(&command).map(|p| p.to_string_lossy().into_owned()))
        .await
        .ok()
        .flatten()
}

/// 查找最近的项目根目录，在用户主目录之前停止。
pub async fn project_root(path: String, markers: Vec<String>) -> Option<String> {
    spawn_blocking(move || resolve_root(&path, &markers))
        .await
        .ok()
        .flatten()
}

fn resolve_root(path: &str, markers: &[String]) -> Option<String> {
    let home = dirs::home_dir();
    let start = std::path::PathBuf::from(path);
    let mut dir = if start.is_dir() {
        start.as_path()
    } else {
        start.parent()?
    };
    loop {
        if home.as_deref() == Some(dir) {
            return None;
        }
        if markers.iter().any(|m| dir.join(m).exists()) {
            return Some(dir.to_string_lossy().into_owned());
        }
        dir = dir.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::mpsc;
    use std::time::Duration;

    const PAYLOAD: &str = r#"{"jsonrpc":"2.0","method":"测试"}"#;

    // 子进程只回显一帧，然后立即退出，同时覆盖实际管道、UTF-8 分帧和退出回收。
    fn echo_launch(root: &std::path::Path) -> LspLaunch {
        let len = framing::encode_frame(PAYLOAD).len();
        #[cfg(unix)]
        let (command, args) = (
            "sh",
            vec!["-c".into(), format!("exec dd bs=1 count={len} 2>/dev/null")],
        );
        #[cfg(windows)]
        let (command, args) = ("powershell.exe", vec![
            "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(),
            format!("$s=[Console]::OpenStandardInput(); $b=New-Object byte[] {len}; $n=0; while ($n -lt {len}) {{ $r=$s.Read($b,$n,{len}-$n); if ($r -eq 0) {{ exit 1 }}; $n+=$r }}; [Console]::OpenStandardOutput().Write($b,0,$n)"),
        ]);
        LspLaunch {
            command: command.into(),
            args,
            env: HashMap::new(),
            root: root.to_string_lossy().into_owned(),
            max_rss_mb: None,
            workspace: WorkspaceEnv::Local,
        }
    }

    fn channel<T: Send + 'static>() -> (OutputSink<T>, mpsc::Receiver<T>) {
        let (tx, rx) = mpsc::channel();
        (
            OutputSink::new(move |value| tx.send(value).map_err(|e| e.to_string())),
            rx,
        )
    }

    #[tokio::test]
    async fn local_server_echoes_a_frame_and_reaps_before_exit_receipt() {
        let root = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(root.path()).unwrap();
        let state = Arc::new(LspState::default());
        let (output, messages) = channel();
        let (on_exit, exits) = channel();
        let id = state
            .spawn(&registry, echo_launch(root.path()), output, on_exit)
            .await
            .unwrap();
        state.send(id, PAYLOAD.into()).await.unwrap();
        assert_eq!(
            messages.recv_timeout(Duration::from_secs(10)).unwrap(),
            PAYLOAD.as_bytes()
        );
        assert_eq!(
            exits.recv_timeout(Duration::from_secs(10)).unwrap().code,
            Some(0)
        );
        assert_eq!(
            state.send(id, PAYLOAD.into()).await.unwrap_err(),
            format!("lsp_send: unknown id={id}")
        );
    }

    #[tokio::test]
    async fn shutdown_reaps_a_running_server_and_rejects_later_spawns() {
        let root = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(root.path()).unwrap();
        let state = Arc::new(LspState::default());
        let (output, _messages) = channel();
        let (on_exit, exits) = channel();
        state
            .spawn(
                &registry,
                echo_launch(root.path()),
                output.clone(),
                on_exit.clone(),
            )
            .await
            .unwrap();
        state.shutdown();
        exits.recv_timeout(Duration::from_secs(10)).unwrap();
        let error = state
            .spawn(&registry, echo_launch(root.path()), output, on_exit)
            .await
            .unwrap_err();
        assert_eq!(error, "lsp: host is shutting down");
    }

    #[tokio::test]
    async fn rejects_remote_environments_and_unauthorized_local_roots() {
        let root = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        let state = Arc::new(LspState::default());
        let (output, _messages) = channel();
        let (on_exit, _exits) = channel();
        for workspace in [
            WorkspaceEnv::Wsl {
                distro: "test".into(),
            },
            WorkspaceEnv::Ssh {
                profile_id: "test".into(),
            },
        ] {
            let mut launch = echo_launch(root.path());
            launch.workspace = workspace;
            assert_eq!(
                state
                    .spawn(&registry, launch, output.clone(), on_exit.clone())
                    .await
                    .unwrap_err(),
                "lsp: non-local workspaces are not supported yet"
            );
        }
        let error = state
            .spawn(&registry, echo_launch(root.path()), output, on_exit)
            .await
            .unwrap_err();
        assert!(
            error.starts_with("cwd is outside the authorized workspace:"),
            "{error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_root_finds_nearest_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("proj");
        let nested = root.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        std::fs::write(nested.join("main.rs"), "").unwrap();

        let found = resolve_root(
            nested.join("main.rs").to_str().unwrap(),
            &["Cargo.toml".to_string()],
        );
        assert_eq!(found, Some(root.to_string_lossy().into_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_root_returns_none_without_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let nested = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("f.rs"), "").unwrap();

        let found = resolve_root(
            nested.join("f.rs").to_str().unwrap(),
            &["Cargo.toml".to_string()],
        );
        assert_eq!(found, None);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_root_stops_at_home() {
        let home = dirs::home_dir().expect("home");
        let found = resolve_root(
            home.join("somefile.ts").to_str().unwrap(),
            &["nonexistent-marker-xyz".to_string()],
        );
        assert_eq!(found, None);
    }
}
