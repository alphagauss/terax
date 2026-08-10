# PTY Shell 集成

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

## Session 模型

一个终端 tab 对应一个 PTY session。session 存放在 `PtyState`（`src-tauri/src/modules/pty/mod.rs:20`）中：

```rust
pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,
}
```

ID 从 1 开始单调递增且永不复用，因此前端可以将 `0` 视为未设置。

`pty_open`（`mod.rs:44`）在 blocking thread 上 spawn session，将其插入 map 并返回 ID。输出通过 `Channel<Response>` 流式传输，exit code 通过单独的 `Channel<i32>` 传输。`pty_write`（`mod.rs:100`）使用 `x-pty-id` header 接收原始字节，避免每次按键都进行 JSON serialization。

## Reader / flusher / waiter thread

`session::spawn`（`session.rs:102`）为每个 session 启动三个 thread：

1. **Reader** - 从 PTY master 读取字节，运行 DA filter 和 Agent detector，并将过滤后的字节推入 pending buffer。
2. **Flusher** - 合并输出并通过 data channel 发送到前端。
3. **Waiter** - 等待子进程退出，flush 尾部数据并发出 exit code。

pending buffer 上限为 4 MiB。溢出时会丢弃其内容并替换为 SGR reset 提示，避免截断的 CSI sequence 破坏 xterm 状态。

## Shell bootstrap

`shell_init::build_command`（`shell_init.rs:53`）构建用于 spawn Shell 的 `CommandBuilder`。路径和参数取决于平台以及所选 Workspace 环境（Local 或某个 WSL distro）。

### Unix

集成脚本位于 `src-tauri/src/modules/pty/scripts/`：

- zsh 使用 `zshenv.zsh`、`zprofile.zsh`、`zlogin.zsh`、`zshrc.zsh`
- bash 使用 `bashrc.bash`
- fish 使用 `init.fish`，存放在 `~/.terax/shell-integration/fish/` 下，并仅由 Terax 启动的 fish 实例显式 source

启动 Zsh 时，`ZDOTDIR` 指向 Terax 的集成目录，该目录先 source Terax 脚本，再 source 用户的实际配置。Bash 使用 `--rcfile` 指向 wrapper，在 Terax 配置之后 source 用户的 `~/.bashrc`。Fish 通过 `TERAX_FISH_INIT` 接收生成的脚本路径，并使用 `-C` source，因此不会修改任何用户配置文件。

所有集成 Shell 都会发出 **OSC 7**（cwd）和 **OSC 133 A/B/C/D**（prompt 边界和 exit code），使 Terax 无需解析用户 prompt 即可跟踪 cwd 和检测 command 边界。

### Windows

Windows 上的 Shell 优先级为：

1. `pwsh.exe`（PowerShell 7+）
2. `powershell.exe`（Windows PowerShell 5.1）
3. `cmd.exe`（无集成）

PowerShell 通过以下方式加载 `profile.ps1`：

```text
pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <profile.ps1>
```

profile 在 `$PROFILE` 运行后包装用户已有的 `prompt` 函数，以发出 OSC 7 + OSC 133 A/B/D。传入 ConPTY 前，cwd 会规范化为反斜杠，因为 `CreateProcessW` 处理正斜杠时会出现异常。

### Fish 4.0+

Fish 4.0 会自行写入 OSC 133 prompt marker。为避免重复，Terax 设置 `fish_features=no-mark-prompt`，并在 `config.fish` 运行后通过 `-C` 重新声明自己的 prompt。

## Windows 上的并发与进程生命周期

### `CONPTY_LIFECYCLE_LOCK`

`openpty + spawn_command` 及其对应的 close 操作由 `session.rs:71` 中的 static mutex 串行化。并发执行 ConPTY 生命周期调用会破坏新 console，使其 Shell 永远无法输出数据。

### Job Object

每个 ConPTY 子进程都会分配到带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（`job.rs:34`）的 Windows Job Object。Job HANDLE 被丢弃时，无论是正常关闭、panic，还是 Terax 进程被 SIGKILL，kernel 都会终止 Shell 的所有 descendant。否则 `TerminateProcess` 只会终止直接子进程，而在 pwsh 中启动的 `npm run dev` 会成为 orphan。

在 macOS 和 Linux 上，`Drop for Session` 调用 `killer.kill()`。开发时通过 `Ctrl-C` 终止 `cargo run` 仍可能留下 orphan，因为 destructor 可能没有运行；这种情况仅在开发环境下可接受。

## 输入与 escape sequence 处理

### DA filter

PowerShell / PSReadLine 启动时会发送 cursor position query（`ESC[6n`），并阻塞直到收到响应。`DaFilter`（`da_filter.rs`）拦截该 query，并在 PTY input 上响应，使 Shell 不会挂起。

### Agent 检测

Reader thread 在字节流上运行 `AgentDetector`（`agent_detect.rs`）。它由 `OSC 133;C;<cmd>` 或 self-armed `OSC 777` marker 启用，并发出 `terax:agent-signal` 状态转换（`started`、`working`、`attention`、`finished`、`exited`）。检测仅由 OSC sequence 驱动，绝不由原始输出驱动，因此 repaint 中的 TUI 不会造成状态反复变化。

### Enter 键

终端输入发送 `\r`（CR），而不是 `\n`（LF）。Windows 上的 PowerShell 要求使用 CR。

## 不变量

- 未验证快速连续创建 tab 时首个 tab 的稳定性之前，不要移除 `CONPTY_LIFECYCLE_LOCK`。
- Windows 上没有替代 orphan guard 时，不要禁用 Job Object。
- 将平台特定 Shell 逻辑保留在 `shell_init.rs` 对应的 `#[cfg(unix)]` 或 `#[cfg(windows)]` 分支中。
- 传给 ConPTY 的 cwd 必须使用反斜杠；到达前端的 OSC 7 cwd 使用正斜杠规范形式。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和 command 目录
- [终端 renderer pool](terminal-renderer-pool.md) - slot pool 和 DormantRing
