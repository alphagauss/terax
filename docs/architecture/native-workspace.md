# 原生 Cargo workspace

原生代码在单个 Git 仓库内使用 Cargo workspace。根目录统一维护 `Cargo.lock`、共享依赖与构建 profile，Cargo 产物默认进入根目录 `target/`；构建和打包脚本不另设 Rust 产物目录。

## 依赖与职责

- `terax-core` 拥有共享原生业务、授权、持久化和运行时资源，不依赖 Tauri、窗口或 WebView。桌面侧仍拥有窗口、插件及尚未迁出的桌面专属服务。
- `terax-git` 拥有 Git 仓库操作、命令执行和结果解析，依赖 `terax-core` 的工作区授权和 SSH 会话。
- `terax-http` 提供受控 HTTP 请求、文件快照传输和图片下载，复用 core 的代理路由、凭据和文件授权。
- `terax-lsp` 管理本地语言服务器的启动、消息分帧、进程监控和退出回收。桌面负责 IPC 转发，启动目录由 core 校验。
- `terax-pty` 管理终端会话、本地与 WSL Shell 启动和进程回收，使用 `terax-core` 的 SSH 终端接口。两者从 `resources/shell-integration` 嵌入所需脚本。
- `terax-transfers` 管理文件传输的调度、冲突、提交和恢复。SSH 连接通过 `terax-core` 提供传输资格、专用 SFTP 流和命令控制。
- `src-tauri` 中的 `terax` 是桌面宿主，负责命令参数映射、窗口身份、事件与通道转发、桌面 Store 接入。
- `terax-host` 是现有终端宿主的私有 stdio 入口，只接受启动所在的 Local 环境。

桌面宿主直接依赖 `terax-core`、`terax-git`、`terax-http`、`terax-lsp`、`terax-pty` 和 `terax-transfers`。终端宿主接入 `terax-core` 和 `terax-http`，两条依赖路径均关闭 core 的默认特性。此次拆分不新增 daemon，不改变每个 Workspace 独立进程的模型，也不让后台业务随 UI 挂载启停。

core 默认启用 `workspace-runtime`，覆盖 SSH 和文件监听等 Workspace 能力。终端宿主关闭 core 默认特性，保持原有轻量 Local 构建；它的请求校验始终拒绝远端环境，即使 workspace 联合构建使依赖特性合并，也不能放宽协议边界。

## 后续按需拆分

当前保留 `terax-core` 的模块组织，暂不继续拆分，也不预设必须落地的 crate 清单。后续开发发现拆分机会时可以提出建议，但不得因正在修改某个模块而自行拆分；只有用户明确要求拆分或明确同意具体拆分建议后才能实施。普通功能开发、修复和代码整理不自动授权新增 crate 或重划模块边界。

拆分建议应基于实际需求，例如模块频繁修改且需要独立编译或测试、较重依赖可以隔离、稳定能力需要被多个宿主复用，或现有依赖关系已经妨碍维护。建议需说明拟拆职责、依赖方向、预期收益、接口调整成本和验证范围，不以目录大小或单纯增加 crate 数量作为理由。

获准拆分后遵循以下原则：

- 按完整职责确定边界，不机械地将每个目录变成 crate；紧密耦合的实现可以继续放在一起。
- 保持依赖单向、无环，共享业务不反向依赖桌面宿主；不为消除编译错误而批量公开内部类型或方法。
- 优先提取边界清晰、收益明确的部分，不为假设中的宿主、插件或扩展提前建立抽象。
- 沿用单仓库 workspace、根目录锁文件与 `target/`，保持现有业务语义、权限、协议和资源生命周期；按 [检查与验证](../contributing/testing.md) 验证独立 crate、受影响宿主及相关回归。

## 宿主接入

宿主在处理请求前注入已有 Tokio 运行时句柄。原生线程需要调度异步工作时复用该句柄，core 不创建第二套执行器。

事件出口只转发既有事件名与 payload；PTY 原始字节和退出回执使用有类型的输出出口，桌面适配保持原有二进制 IPC。传输任务状态、取消与恢复由传输模块拥有，SSH 通道准入与释放由 core 管理。

SSH 宿主共享同一个秘密存储状态，重连仍读取最新凭据。传输设置由桌面适配访问与 WebView 相同的 Workspace Store；保存失败恢复旧内存值，不改变任务结果或现有持久化格式。

## 开发入口

所有 Cargo 命令从仓库根目录执行。默认成员是桌面宿主；全量检查显式使用 `--workspace`，局部检查使用 `-p terax-core`、`-p terax-git`、`-p terax-http`、`-p terax-lsp`、`-p terax-pty`、`-p terax-transfers`、`-p terax-host` 或 `-p terax`。具体检查命令见 [检查与验证](../contributing/testing.md)。

`pnpm tauri dev` 与 `pnpm tauri build` 继续作为桌面入口。TUI 打包中间文件保留在 `artifacts/`，内嵌的 Rust 宿主来自根目录 `target/release/`。
