# 实验性终端宿主

`terax agent` 使用 OpenTUI React 与 Bun，通过私有子进程管道调用无 WebView 的 terax-host。当前暂停主动开发，保留 CLI、构建入口和测试；桌面新增能力不要求同步增加 TUI 入口。共享边界变更仍需更新必要调用，若维持 TUI 需要大规模改造则重新评估范围。

## 使用

依赖通过 pnpm 管理，另需 Bun 与 Rust：

```sh
pnpm install
pnpm build:host
pnpm agent --help
pnpm agent --cwd /path/to/project --model provider/model-id
pnpm agent --list
pnpm agent --resume SESSION_UUID
```

默认使用共享配置；`--model`、`--full-access` 和 `TERAX_API_KEY` 只影响本次运行。`TERAX_NATIVE_HOST` 可指定同版本宿主。Enter 发送，Shift+Enter 换行，Escape 停止；Ctrl+C 运行时停止、空闲时退出。审批使用 Y/N，保存失败用 Ctrl+R 重试。

仅支持当前启动系统的 Local 环境。在 WSL 内启动时，该 WSL 系统就是 Local；拒绝恢复其他环境、Channel 或 External Agent 会话，不把远端请求当成本地执行。目前没有界面内模型或会话切换，也没有运行中引导。

## 宿主边界

桌面与终端共享业务规则和原生服务，各自拥有运行实例；桌面与 Channels 尚未统一到 TUI 会话控制器。会话锁、checkpoint、授权与收尾继续由共享实现拥有。

共享服务位于 modules，桌面和私有管道接入位于 adapters。私有管道不监听端口，不是稳定外部协议；EOF 和终止取消请求并清理进程与锁。PTY、SSH 管理等桌面专用能力不为 TUI 预先拆分，daemon 与远程服务不在当前范围。

## 构建与验证

```sh
pnpm build tui
pnpm build tui mjs
```

当前生成 Windows x64 单文件：standalone 包含 Bun，mjs 需要外部 Bun。原生宿主及资源释放到进程专属临时目录；只回收已退出实例的资源。中间产物独立于桌面 target。

修改终端链路时按范围运行：

```sh
pnpm check-types:terminal
pnpm build:host
pnpm test:terminal
pnpm test:tui
pnpm test:tui:package
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features headless --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features headless --locked
```

打包测试需要先生成两种发行物。未影响终端链路的桌面修改不运行 TUI 专项检查。
