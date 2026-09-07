# 终端 Agent 与共享运行能力

`terax agent` 是独立的 OpenTUI React 界面，使用 Bun 执行 TypeScript，通过私有子进程管道调用 `terax-host`。首版只提供当前系统中的内置 Agent，不实现编辑器、daemon 或远程服务协议。在 Linux Server 或 WSL 内启动时，该系统就是 Local 执行环境。

## 扩展方向与代码边界

新增代码遵循 [项目架构约束](../../AGENTS.md#新增代码与渐进拆分边界)：业务规则与运行状态独立于具体 UI，宿主提供配置、通信和原生能力，UI 提交操作并订阅结果。现有代码随已确定的功能需求逐块提取，不进行全量预防性拆分，也不为假设中的前端提前建设框架。

当前以完善 `terax agent` 为终端方向。`terax edit` 仅作为架构讨论中的示例，不列入后续计划；当前远程工作需求由现有桌面 SSH 登录与工作区能力满足。daemon、remote agent 等保留扩展可能，待具体需求确定后再设计相应生命周期和接入方式。

## 开发与启动

依赖继续使用 pnpm 管理。终端运行已验证 Bun 1.3.13；构建原生宿主需要 Rust 和对应平台的编译工具，不需要 WebView、GTK 或 Tauri 窗口插件。

```sh
pnpm install --frozen-lockfile
pnpm build:host
pnpm agent
```

`bin/terax` 是发行命令入口，也可直接运行 `bun bin/terax agent`。开发入口的用法如下：

```sh
pnpm agent --help
pnpm agent --cwd /path/to/project --model provider/model-id
pnpm agent --list
pnpm agent --resume SESSION_UUID
pnpm agent --full-access
```

模型、提供商地址、自定义指令、Subagent 设置和界面语言读取现有共享配置。凭据沿用系统密钥链或 Linux secrets 文件。`--model` 和 `--full-access` 只影响本次终端运行，不改写桌面的全局选择。`TERAX_API_KEY` 可向本次进程提供所选模型的凭据，不会写回磁盘。

默认寻找工作树内的 `src-tauri/target/debug/terax-host`，Windows 使用 `.exe`。发行时可以通过 `TERAX_NATIVE_HOST` 指定同版本原生程序；是否随发行包提供 Bun 属于打包规则。Release 原生构建为：

```sh
cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --features headless --bin terax-host --release --locked
```

Enter 发送，Shift+Enter 换行，Escape 停止，Ctrl+C 在运行时停止、空闲时退出。审批使用 Y/N，文件修改先展示完整 diff。保存失败保留当前运行状态，Ctrl+R 显式重试；Ctrl+C 可以放弃重试并退出。`/exit` 关闭终端界面。

## 职责与所有权

- `src/modules/ai/lib/agent.ts`、`transport.ts`：共享模型执行、工具、提示词冻结和 Subagent 编排。
- `runLifecycle.ts`：直接订阅 SDK 状态，协调审批、取消和终态提交，不依赖 React 组件挂载。
- `sessionPersistence.ts`：共享用户输入、checkpoint 和终态的增量提交规则，只有原子保存成功才推进游标。
- `agentDefinition.ts`：不依赖桌面翻译或设置的 Agent 身份与会话快照。
- `agentSession.ts`：无界面单会话控制器，显式接收配置并发布可订阅快照。
- `src/modules/ai/store/runLifecycle.ts`：桌面会话状态和审批展示的接入；订阅随运行锁释放。
- `src/lib/nativeHost.ts`、`tauriHost.ts`：共享宿主接口与按需加载的桌面接入。桌面仍使用原有 IPC 和进程结构。
- `apps/terminal/`：终端参数、配置接入、原生管道和交互展示，不另写模型循环或文件策略。

Rust 默认 `desktop` 特性保留 Tauri 应用，启动和命令注册在 `src-tauri/src/desktop.rs`。共享能力的宿主接入统一位于 `adapters/`：

```text
adapters/
  mod.rs       集中选择编译的宿主
  tauri/       共享能力的桌面命令、Channel 转换和配置监听
  stdio.rs     terax-host 私有管道和封闭请求映射
modules/
  fs/          文件策略、正文、目录、条件写入和搜索
  shell/       受管进程与执行规则
  net.rs       HTTP 地址安全、传输和取消
  ai_sessions.rs、secrets.rs、shared_store.rs
```

保留 `modules/` 名称以避免无关路径改动。其中上述共享服务只接收普通 Rust 参数，不包含 Tauri command、State 或 AppHandle；桌面包装负责提取状态，stdio 直接调用同一服务。文件、配置和 HTTP 的通知通过 `FileEvents`、`StoreEvents`、`HttpEventSink` 传出，由宿主决定通知方式。配置 watcher 仅由桌面启动。

`adapters/tauri/` 整体受 `desktop` 特性控制，内部命令无需逐个声明 `cfg(desktop)`。其余仅用于桌面的模块仍保留在已有位置，不为未来子命令提前增加适配目录。添加原生能力时修改一次服务，再在需要它的宿主入口增加薄映射。

PTY、配置监听、文件模糊搜索与 SSH 管理依赖由 `desktop` 特性启用，无界面构建不引入这些当前未使用的能力。

当前无界面构建不包含 SSH 连接管理。现有 SSH Runtime 仍由桌面 Workspace 管理，因此共享服务中的 SSH 分支暂时保留对应构建条件；这不表示 SSH 天然属于桌面。未来支持终端 SSH 时需要独立提取连接生命周期，本次不扩大到该重构。终端请求中的非 Local 环境被明确拒绝，不会被当成本地路径执行。

## 不变量

- 每个宿主绑定固定执行环境；恢复会话保持原 cwd 和 Agent 快照。终端入口拒绝继续其他环境、Channel 或 External Agent 会话。
- 桌面和终端共享实现，各自拥有运行实例。会话 OS 锁继续禁止两个进程同时执行同一会话，不能通过共同读写 JSONL 代替运行状态同步。
- 用户输入与系统提示在模型请求前保存；普通流式正文在终态提交；后台恢复继续使用原 checkpoint 规则。
- 没有界面也能完成业务收尾。UI 只提交操作并订阅结果；输入焦点、滚动和差异展示仍属于各端 UI。
- 文件敏感路径、读取版本、条件写入、进程所有权、完整进程树清理以及 HTTP 地址和代理策略继续由共享原生实现执行。
- 私有管道不监听端口，不是稳定外部协议。请求大小、并发和响应缓存有界；EOF 和终止信号会取消请求、清理受管进程并释放锁。
- 后续子命令可以复用宿主能力并提取自己的业务模块。daemon 和远程客户端还需要明确的托管、身份、通信与重连设计，本次不预先实现。

## 验证

```sh
pnpm lint
pnpm check-types
pnpm check-types:terminal
pnpm test
pnpm build:host
pnpm test:terminal
pnpm test:tui
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features headless --all-targets --locked -- -D warnings
cargo nextest run --manifest-path src-tauri/Cargo.toml --no-default-features --features headless --locked
```

`test:terminal` 使用本地模拟模型和真实 Rust 文件、HTTP、进程服务；会话存储用内存替身，避免写入用户历史。会话原子保存与 OS 锁由既有 Rust 测试覆盖。`test:tui` 使用 OpenTUI 原生测试渲染器，验证中文、多行输入、审批焦点、草稿保留和缩放。Linux 应安装对应平台的依赖，不能依赖 Windows 安装的原生 OpenTUI 资源。

桌面改动仍需执行原有前端和 Rust 检查。真实桌面回归应遵循 [UI 运行时调试](../contributing/ui-runtime-debugging.md)，使用临时 Workspace 和受控模型，并在原生调用边界阻止非测试模型请求。
