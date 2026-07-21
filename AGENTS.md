# AGENTS.md

**Markdown 文件统一使用 UTF-8 编码。**

Terax 会读取工作区根目录的 `AGENTS.md` 作为项目指令。本文件同时是项目架构和开发约束的权威入口，修改代码前必须完整阅读。

## 项目概览

**Terax** 是开源的 AI 原生终端模拟器。后端使用 Tauri 2、Rust 和 `portable-pty`，前端使用 React 19、TypeScript、xterm.js WebGL，AI 能力基于 Vercel AI SDK v6 并由用户自行提供密钥。

- 包标识符：`app.crynta.terax`
- 包管理器：只使用 **pnpm**
- 支持平台：macOS、Linux、Windows
- 前端检查：`pnpm lint`、`pnpm check-types`、`pnpm test`
- Rust 检查：`cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`、`cd src-tauri && cargo nextest run --locked`
- 本地没有 nextest 时可以使用：`cargo test --locked`

## 运行时调试路由

只有在确实需要运行时证据时才使用本节流程。以下情况必须执行：

- 仅凭源码难以确认的前端 UI 问题
- 复杂交互或已经多次修复失败的问题
- 布局、尺寸、裁剪、溢出、定位或点击事件异常
- 页面闪烁、错误重挂载、焦点丢失、滚动位置重置或状态陈旧
- 调整尺寸、面板激活、主题、缩放或异步更新后行为不同
- 用户明确要求检查 DOM、计算样式、运行时测量或真实 Tauri WebView

简单且可以从源码直接验证的局部 UI 修改不需要启动运行时。触发本流程后，编辑前必须完整阅读 `docs/contributing/ui-runtime-debugging.md`。先定义复现条件；涉及 IPC 或原生状态时使用真实 Tauri 运行时；收集有限且可重复的证据；定位第一个出错层；修改后用同样的证据复验。依赖 Tauri IPC 的问题不得只在普通 Vite 页面中诊断。

## 质量标准

所有修改都必须达到可发布质量，不能只满足“暂时能用”。

- **正确性**：考虑边界、失败路径和并发访问。
- **性能**：Terax 的目标是轻量和高性能。检查新增 RAM、IPC 往返、重复请求、额外渲染、无效计算和依赖体积。未启用的功能应当不消耗资源。
- **安全性**：在 IPC、文件系统、网络和 AI 工具边界验证输入。秘密路径拒绝规则必须同时覆盖读取和写入，不得绕过。
- **UI/UX**：所有状态和细节都要完整、专业。
- **架构**：新增或修改的逻辑优先放入纯函数和低依赖模块；Tauri command 与 React 组件保持为薄的命令式外壳。
- **变更范围**：只修改完成当前需求所必需的代码，不顺手重构无关内容。

完成前必须验证：

- 前端：`pnpm lint`、`pnpm check-types`、`pnpm test`
- Rust：`cargo clippy --all-targets --locked -- -D warnings`、`cargo nextest run --locked` 或 `cargo test --locked`
- 文档：检查每个新增或修改的 Rust、TypeScript、TSX 文件及相关代码项，确认满足下方代码文档规范。

修改终端、Shell 启动、工作区授权、Git、文件系统、IPC 或 AI 工具边界等核心子系统时，必须添加测试锁定关键不变量。

## 代码文档规范

以下规则适用于所有代码。

### 文件级注释

- 每个新增或修改的 Rust、TypeScript、TSX 文件都必须在文件开头具有中文文件级注释，不能只给新文件添加。
- TypeScript 和 TSX 使用文件级 JSDoc `/** ... */`，说明文件用途、主要职责以及重要边界或限制。
- Rust 使用内部文档注释 `//!`，说明模块职责、主要数据流以及关键安全、并发或平台约束。
- 文件存在 shebang、许可证、crate 属性或框架强制指令时，文件级注释放在语法允许的最前位置。
- 已有合格的中文文件级注释时不要重复添加；文件职责发生变化时同步更新。
- 测试文件也必须有文件级注释，重点说明测试对象和要锁定的不变量。

### 组件与函数注释

- 所有新增或实质修改的导出 React 组件必须添加中文 JSDoc，说明用途、主要职责和特殊行为或限制。
- 重要函数、Hook、公共方法必须添加中文 JSDoc，说明函数作用、关键逻辑和必要的参数约束。
- 新增或实质修改的 Rust 公共项和重要私有函数必须使用中文 `///`。签名无法直接表达时，说明所有权、生命周期、并发、异步取消、平台差异、安全边界、错误或 panic 行为。
- 修改本应具有文档但尚未记录的组件或函数时，在同一次修改中补齐；不要扩展到无关代码。

### 重要逻辑块注释

- 只为不明显的业务规则、实现原因和约束添加中文行内注释。
- 注释优先解释“为什么这样实现”，不要复述代码正在做什么。
- 锁、并发顺序、异步取消、安全检查、平台分支、性能规避和兼容性处理通常需要说明原因。
- 不给简单变量、简单访问器、薄转发函数或代码已经清楚表达的操作添加注释。
- 不添加空泛的 AI 式说明。

### 范围与豁免

- 所有新增或更新的注释统一使用中文。
- 不翻译本次修改没有涉及的既有英文注释。
- 生成代码和注册表管理的代码豁免。尤其不要仅为了添加注释而修改 `src/components/ui/` 或 `src/components/ai-elements/`。

TypeScript / TSX 示例：

```tsx
/**
 * 本文件实现聊天主面板及其消息交互流程。
 * 负责连接会话状态、消息列表和输入组件，不直接持久化会话。
 */

/**
 * 聊天主面板组件。
 *
 * 负责消息展示、用户输入和消息发送。发送中的会话保持挂载，避免切换面板时中断流式响应。
 */
export function ChatPanel() {}
```

Rust 示例：

```rust
//! 终端会话的创建与生命周期管理。
//!
//! 本模块负责启动 PTY、转发输出，并确保会话关闭时释放子进程。

/// 创建一个新的终端会话。
///
/// Windows 上的 ConPTY 必须串行创建，否则其中一个会话可能无法读取输出。
fn create_session() {}
```

## 通用约定

- 代码、注释、提交和文档中不使用 em dash 字符。
- 不使用 emoji。
- 前端跨模块导入统一使用 `@/...`，不要使用相对路径。
- 只使用 pnpm，不使用 npm、npx 或 yarn。

## 架构

### 双进程边界

Rust `src-tauri/` 负责所有操作系统访问。WebView 不直接访问文件系统、进程或 Shell，必须通过注册在 `src-tauri/src/lib.rs` 的 Tauri command 调用：

- `pty::pty_*`：长生命周期交互式 PTY，由 `PtyState` 管理，通过 `Channel<PtyEvent>` 输出。
- `fs::*`：文件树、读取、写入、元数据、搜索、grep、glob 和变更操作。
- `git::commands::*`：状态、diff、暂存、提交、同步和历史；所有操作都经过工作区授权。
- `shell::shell_run_command`：AI 工具使用的一次性子 Shell，不是用户交互终端。
- `shell::shell_session_*`、`shell::shell_bg_*`：持久 Agent Shell 和后台进程。
- `workspace::*`：工作区授权、当前目录和 WSL 桥接。
- `lsp::*`：语言服务器进程及 JSON-RPC 管道；协议智能位于前端。
- `net::*`：带 SSRF 防护的 AI HTTP 代理。
- `secrets::secrets_*`：通过 `keyring` 访问系统密钥链。
- `open_settings_window`：独立设置窗口。

### PTY 与 Shell 集成

- Shell 初始化脚本位于 `src-tauri/src/modules/pty/scripts/`，负责 OSC 7 和 OSC 133 标记。
- Unix 和 Windows 平台代码必须放入正确的 `#[cfg]` 分支。
- Windows ConPTY 创建必须由 `SPAWN_LOCK` 包围；并发创建会造成某个 PTY 输出管道停滞。
- 每个 Windows ConPTY 子进程必须进入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，保证 Terax 退出时清理整个进程树。
- 终端 Enter 必须发送 `\r`，不能发送 `\n`，否则 Windows PowerShell 无法正确处理。
- `AiComposerProvider` 必须始终挂载在 `App.tsx` 根部。条件包装会在密钥加载后重挂载整棵树并重新创建所有 PTY。

### Workspace 进程模型

每个原生 Workspace 窗口都是独立的 Terax 应用进程，拥有自己的 React WebView、Rust 状态、PTY、LSP、Shell、文件监听器、SSH/SFTP/tunnel 和 AI 运行时。新窗口和环境切换通过启动新进程完成，不重置当前窗口。

进程启动时确定的 Local、WSL 或 SSH 环境不可变。Space 只保存 UI 分组、根目录和标签页状态，不能切换进程后端。

Terax 自有数据统一存放在 `~/.terax`。全局可写配置通过白名单 `shared_store.rs` API 执行加锁、读取最新值、最小变更和原子替换。不得重新引入共享 `LazyStore` 或整表覆盖写入。

### 前端与国际化

- 翻译资源位于 `src/i18n/locales/<language>/<namespace>.json`，所有语言的 namespace 必须一致。
- 所有用户可见文本都必须翻译，包括 JSX、按钮、菜单、tooltip、`title`、`aria-label`、`placeholder`、toast、验证错误、命令面板和 macOS 原生菜单。
- 新增用户可见文本时，同一次修改必须更新 `en` 和 `zh-CN`。
- `language` 设置是唯一语言状态来源，不要增加第二个 store，也不要持久化到 `localStorage`。
- 每个应用进程只有一个窗口。多窗口来自多个进程，不是同一进程中的多个 Workspace WebView。
- 标签页切换时不卸载，而是通过 `invisible pointer-events-none` 隐藏，保证 PTY 和开发服务器继续运行。
- `App.tsx` 只负责模块协调，新功能放入对应的 `src/modules/<area>/`。

### Workbench 布局与动画

- `react-resizable-panels` 是唯一 SplitView 基础组件，面板使用稳定 id。
- 拖动期间只通过 DOM ref 和 `transform` 更新视觉指示器，不更新业务 React 状态、不写 store、不反复创建 timer。
- 只在 `onLayoutChanged` 确认用户交互结束后读取并持久化最终尺寸。
- 动画复用 `src/styles/globals.css`、`src/lib/motion.ts` 和现有语义 token：反馈 100ms、控件 160ms、面板 150ms、表面 240ms。
- 优先动画 `transform` 和 `opacity`。大型子树、Markdown、编辑器、终端及昂贵的 `ResizeObserver` 布局不得动画 `width`、`height`、`left`、`top`、`flex-basis` 或 grid track。
- 不使用 `transition-all`、Document View Transition、`flushSync`、全局平滑滚动、逐帧 React 状态更新或仅为动画增加运行时依赖。
- 动画必须可取消，快速切换从当前视觉状态继续，reduced motion 直接跳到结果。

### 前端模块边界

- `workbench/`：归一化页面所有权、递归分割树和稳定 ViewPool。移动或分割标签页不能重挂载页面。
- `terminal/`：PTY 会话、OSC 解析和 renderer pool。运行命令的隐藏终端不能被序列化；不要重放增量 TUI 输出覆盖快照。
- `editor/`：CodeMirror 页面、换行与缩进检测、冲突保存、格式化、diff、AI 补全和 LSP。大文件限制和主题解析必须保持现有不变量。
- `explorer/`：文件树、搜索、重命名和上下文操作；路径 basename 必须兼容反斜杠。
- `preview/`：开发服务器预览。
- `tabs/`：Workbench 标签页展示层，标签顺序和激活状态只由 Workbench 管理。
- `find/`：共享查找和替换 UI，搜索状态仍由编辑器、终端或 Git 等调用方持有。
- `header/`、`statusbar/`、`sidebar/`：应用框架、状态和侧边栏。
- `shortcuts/`：快捷键注册；跨平台组合键使用 `metaKey || ctrlKey`。
- `settings/`：白名单共享设置。
- `source-control/`、`git-history/`：Git 状态、diff、提交和历史。
- `lsp/`：按需启用，未启用时不得产生进程、PATH 检查或额外 eager bundle 成本。没有 root marker 就不能启动 session，每个 server 最多 4 个 session。
- `markdown/`：Markdown 预览。
- `workspace/`、`workspace-process/`：环境模型、启动上下文和多进程策略。
- `theme/`：自定义主题引擎，不使用 `next-themes`。
- `agents/`：内置 Agent 与终端编码 Agent 的通知、状态和 OSC 777 检测。
- `command-palette/`：命令与导航面板。
- `spaces/`：Workspace 内的 UI 分组，不拥有也不切换运行环境。
- `ai/`：AI 子系统，详细约束见下一节。

### AI 子系统

- 云端 provider 通过 `@ai-sdk/*` 接入；本地 provider 包括 LM Studio、MLX、Ollama。
- 密钥只存放在系统 keychain 或 Linux secrets fallback，绝不能写入磁盘配置、settings store 或 `localStorage`。
- `lib/agent.ts` 保持 `Agent` 和 `DirectChatTransport` 结构，其他模块依赖 AI SDK v6 chat 语义。
- 会话以 `sessions/<uuid>.json` 原子快照保存；单会话 OS 锁禁止两个进程同时继续同一会话。
- `AgentRunBridge` 在 idle、error 或 stop 后发布完整快照；流式消息、审批和工具状态保留在所属进程。
- AI sidebar 是唯一完整聊天界面。面板卸载后运行仍通过 `AgentRunBridge` 继续。
- Composer context 始终挂载，保证侧边栏关闭后草稿和附件仍然存在。
- live context 按需读取当前终端 cwd 和最后 300 行，禁止提前快照。
- `read_file`、`list_directory`、`fs_search`、`fs_grep` 自动执行；写入、重命名、删除、命令和后台进程必须经过 UI 审批。
- `lib/security.ts` 的秘密路径拒绝规则必须同时用于读取和写入。
- AI 修改通过 `ai-diff` 标签页逐 hunk 接受或拒绝，接受前不得实际写入。

### UI 与路径约定

- `src/components/ui/` 由 shadcn/ui 管理，`src/components/ai-elements/` 由 AI Elements registry 管理，不要手工修改生成代码。
- Tailwind v4 配置位于 `src/styles/globals.css`，不存在 `tailwind.config.*`。
- 从 `@/lib/utils` 导入并使用 `cn()`。
- 前端规范路径使用正斜杠。来自 OSC 7、Explorer 或系统的路径必须同时兼容 `/` 和 `\`。
- `homeDir()` 在 Windows 返回反斜杠，必须在边界处转换；相同规范路径不能触发文件树重置。

### 窗口、能力与打包

- macOS 使用 `titleBarStyle: Overlay` 和原生窗口控制按钮。
- Linux、Windows 使用无边框透明窗口，由 React 渲染 `WindowControls`。
- 新增 Tauri plugin 通常需要同时修改 `Cargo.toml`、`lib.rs` 中的 `.plugin(...)` 和 `src-tauri/capabilities/default.json`。
- HOME 和缓存目录使用 `dirs` crate，不直接读取 `$HOME` 或 `%USERPROFILE%`。
- `bundle.targets` 为 `all`；保留各平台已有 minimum version、Linux 依赖、NSIS 和 WebView2 设置。

### 已知陷阱

- React 19 Strict Mode 在开发环境双重挂载 `useEffect`，首个 PTY 会很快清理；`SPAWN_LOCK` 负责串行化创建。
- Windows 上 `portable-pty` 的 `killer.kill()` 只杀直接子进程，必须依赖 Job Object 清理后代进程。
- 标签页 `cwd` 来自 OSC 7，前端规范形式为正斜杠；传给 Windows Rust 文件系统命令前必须兼容或转换分隔符。

## 延伸阅读

详细贡献者文档位于 `docs/`。它们用于展开本文件；发生冲突时以 `AGENTS.md` 为准。

- `docs/README.md`：贡献者文档索引
- `docs/architecture/two-process-model.md`：IPC 边界和命令参考
- `docs/architecture/pty-shell-integration.md`：PTY、Shell 初始化、OSC、ConPTY、Job Object
- `docs/architecture/security-model.md`：安全模型和边界
- `docs/architecture/ai-subsystem.md`：AI 技术栈、会话、工具和 provider
- `docs/architecture/terminal-renderer-pool.md`：renderer pool 和 DormantRing 不变量
- `docs/contributing/testing.md`：测试约定和核心子系统不变量
- `docs/contributing/ui-runtime-debugging.md`：复杂 UI 的运行时调试和回归验证
