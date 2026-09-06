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

运行时调试不是前端修改的默认步骤。先检查源码、样式规则和相关测试；只有结论依赖真实浏览器或 Tauri WebView 状态，且无法用静态证据可靠确认时，才进入本节流程。不得仅因为问题涉及布局、尺寸、裁剪、溢出、定位或点击区域就自动启动运行时。

以下情况必须执行运行时调试：

- 用户明确要求检查 DOM、计算样式、运行时测量、截图或真实 Tauri WebView。
- 问题依赖时序或浏览器运行状态，例如闪烁、错误重挂载、焦点丢失、滚动位置重置、状态陈旧、事件竞争或异步更新差异，且源码和测试不能直接证明行为。
- 问题依赖实际计算结果，例如响应式布局、动态内容、缩放、面板拖动、元素遮挡、命中区域或 `ResizeObserver`，并且关键尺寸或交互无法从确定的样式和组件结构推导。
- 问题依赖 Tauri IPC、原生窗口、PTY、终端渲染器或其他普通 Vite 页面无法模拟的状态。
- 同一问题已经修复失败，或存在多个合理原因而静态检查无法区分。

以下情况默认不执行运行时调试：

- 局部且确定性的样式修改，例如颜色、字体、间距、边框、圆角、固定尺寸、图标尺寸、静态对齐和 Tailwind 类名调整。
- 文案、图标、静态可见性或不依赖运行状态的组件结构修改。
- 可以通过源码、类型检查、单元测试或现有组件约定直接验证的修改。
- 仅为了例行确认视觉效果而启动应用，除非用户明确要求视觉复验或改动风险足以影响多个页面和交互状态。

决定触发本流程后，编辑前必须完整阅读 `docs/contributing/ui-runtime-debugging.md`。先定义可重复的复现条件和需要收集的证据，只检查与假设有关的 DOM、样式或运行状态；修改后使用相同证据复验。涉及 IPC 或原生状态时使用真实 Tauri 运行时，依赖 Tauri IPC 的问题不得只在普通 Vite 页面中诊断。

## 质量标准

所有修改都必须达到可发布质量，不能只满足“暂时能用”。

- **正确性**：考虑边界、失败路径和并发访问。
- **性能**：Terax 的目标是轻量和高性能。检查新增 RAM、IPC 往返、重复请求、额外渲染、无效计算和依赖体积。未启用的功能应当不消耗资源。
- **安全性**：在 IPC、文件系统、网络和 AI 工具边界验证输入。秘密路径拒绝规则必须同时覆盖读取和写入，不得绕过。
- **UI/UX**：所有状态和细节都要完整、专业。
- **架构**：可复用、复杂或需要独立验证的规则优先放入纯函数和低依赖模块；一次性且简单的逻辑保留在所属数据流附近，不得仅为方便单元测试创建通用抽象、包装层或独立模块。Tauri command 与 React 组件保持为薄的命令式外壳。
- **状态归属**：派生状态由其真实生命周期所有者计算并保持单一事实来源，挂到最小对应语义单元；跨边界恢复所需的数据随该单元持久化，展示层只消费结果。内部展示数据不得污染外部协议或下游业务输入。
- **变更范围**：只修改完成当前需求所必需的代码，不顺手重构无关内容。现有设计本身导致问题时，可以在受影响范围内进行破坏式重构，不得为了缩小表面 diff 保留错误抽象或并行旧路径。

### 开发阶段与兼容策略

Terax 当前处于开发阶段。除非文档明确声明某个边界为稳定公共协议，或用户在当前任务中明确要求兼容，否则旧功能、旧配置和旧持久化数据不构成兼容性约束。

- 不得仅为了兼容旧功能、旧配置文件、旧数据格式或历史中间实现增加回退读取、双写、迁移、弃用别名、适配层或条件分支。
- 发现现有逻辑、数据模型或架构有误时，直接修正事实来源，并同步更新受影响的调用方、测试、文档和当前配置结构。允许在当前需求范围内进行破坏式重构，同时删除被替代的旧路径，保持实现单一、简洁。
- 不得用兼容补丁掩盖当前实现的保存、加载、状态归属或协议设计问题。问题出在哪里，就修正对应边界，并用测试锁定修正后的当前行为。
- 跨平台支持、当前版本的跨进程协议、安全边界以及文档明确承诺的外部接口不属于本节所说的旧版本兼容，仍必须满足其既有约束。

完成前必须根据变更范围和风险选择最小且充分的验证集：

- 优先运行直接覆盖本次改动的格式、静态检查和相关测试，不为未涉及的技术栈运行无关检查。
- **测试边界**：回归测试只锁定用户可观察的业务不变量和真实故障边界。一个不变量保留一个主要测试，不按层级、排列或输入组合重复验证同一事实；已有测试覆盖组合行为时，只补本次新增的数据或状态边界。
- **避免恒等式**：不测试框架保证的透传、简单转发、常量拼装或实现细节。往返测试只有在经过两个独立转换边界，且任一方向丢失信息都会造成业务故障时才有价值，不能把同一实现与自身比较成恒等式。
- 修改前端代码或前端配置时，按影响范围运行 `pnpm lint`、`pnpm check-types` 和相关 `pnpm test`；涉及公共基础设施、构建配置或大范围变更时运行完整前端检查。
- 修改 Rust、Tauri 配置或原生依赖时，按影响范围运行 `cargo clippy --all-targets --locked -- -D warnings` 和相关测试；涉及公共基础设施或大范围变更时运行 `cargo nextest run --locked`，本地没有 nextest 时使用 `cargo test --locked`。
- 修改其他语言或独立子项目时，运行该部分已有的格式、静态检查和相关测试。跨语言、跨进程或跨协议边界的变更必须验证受影响的各层。
- 纯文档修改只需检查内容、链接、格式及其描述与实现是否一致，除非文档变更会影响生成、构建或测试流程。
- 发布准备、全局重构、高风险变更或用户明确要求时运行完整检查。无法执行必要验证时，必须说明未验证项和具体原因。
- 检查每个新增或修改的 Rust、TypeScript、TSX 文件及相关代码项，确认满足下方代码文档规范。

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
- 锁、并发顺序、异步取消、安全检查、平台分支、性能规避，以及当前支持平台或现行外部协议的兼容性处理通常需要说明原因。
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
- `fs::agent::*`：按聊天 owner、固定 cwd 和权限模式执行 AI 文件读取、发现、搜索、预备快照、条件提交与结构操作，统一路由 Local、WSL、SSH。
- `git::commands::*`：状态、diff、暂存、提交、同步和历史；所有操作都经过工作区授权。
- `shell::shell_run_command`：编辑器格式化等非 AI 功能使用的有界一次性子 Shell。
- `shell::shell_exec`、`shell::shell_process`、`shell::shell_list`：按聊天 owner 隔离的统一 Agent 进程启动、stdin/EOF/增量输出/终止和发现；`shell_clear_owner` 在聊天删除时回收所属进程。
- `workspace::*`：工作区授权、当前目录、WSL 桥接，以及无 Explorer 根时延迟准备默认 Agent 工作目录。
- `lsp::*`：语言服务器进程及 JSON-RPC 管道；协议智能位于前端。
- `net::http_request`、`net::http_cancel`：带地址安全检查、响应上限和按 WebView 隔离取消的通用 HTTP 传输，全部网络 Provider、Channels 和语音复用；请求按连接身份由 `network_proxy` 解析出口，默认直连，不继承环境代理。
- `secrets::secrets_*`：通过 `keyring` 访问系统密钥链。
- `ai_sessions::*`：保存、列出和锁定 JSONL 会话，并在共享 Agent 配置锁内级联删除 Custom Agent 及其全部会话。
- `auxiliary_window::open_auxiliary_window`：按封闭类型定义创建或复用轻量辅助窗口，设置页是首个注册页面。
- `workspace_runtime::*`：登记完整 Workspace 进程，并通过原子运行时文件投递窗口激活、打开文件和可重建工作页。

### PTY 与 Shell 集成

- Shell 初始化脚本位于 `src-tauri/src/modules/pty/scripts/`，负责 OSC 7 和 OSC 133 标记。
- Unix 和 Windows 平台代码必须放入正确的 `#[cfg]` 分支。
- SSH 文件内容操作统一经过 `remote/file_service.rs`。目录与正文读取共享 raw SFTP 流水线，版本读取、元数据和写入使用独立高层 session 或封闭任务。
- Terax 内部可回退的 SSH Bash 操作统一经过连接级 `remote/tasks/` 运行时，按任务缓存当前 epoch 的依赖能力，并共享高 RTT 单槽预开 channel。单文件正文和单层目录读取固定使用 SFTP；文件版本、条件写入、递归树、目录汇总和目录创建使用 Bash 优先、传统实现回退。任务只接受 Rust 枚举的封闭操作，不能成为通用命令入口。
- Windows ConPTY 创建必须由 `SPAWN_LOCK` 包围；并发创建会造成某个 PTY 输出管道停滞。
- 每个 Windows ConPTY 子进程必须进入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，保证 Terax 退出时清理整个进程树。
- AI 短命令与长任务统一登记为 Agent 进程。Local 使用 Unix process group 或 Windows Job Object，Windows 进程必须挂起启动并在恢复前加入 Job Object；WSL 与 SSH 使用独立远端进程组。超时、取消、聊天删除和应用退出必须清理完整进程树。
- Agent 进程运行中输出使用 4 MiB 有界全局 offset 日志，终态压缩为最近 256 KiB，模型单次最多读取 256 KiB；stdin、EOF、固定文本等待和终止统一通过 `shell_process`，不建立第二套后台进程类型。
- AI 文件工具统一经过 `fs/agent.rs`。Rust 负责权限模式、有界 owner 绑定、请求批准模式的 Workspace 根与敏感路径、最近存在祖先 canonicalize、稳定物理 I/O 路径、普通文件检查、读取版本和 prepared mutation；TypeScript 只对显式路径做保守审批分类并声明工具 schema、审批和展示。
- `write_file` 自动创建父目录并显式区分 create 与 rewrite；`apply_patch` 只对已读取的现有 UTF-8 文件执行严格替换，并保留 CRLF 文件的换行风格。多文件补丁先全部校验，再逐文件原子发布，不得宣称跨文件系统原子性。
- 终端 Enter 必须发送 `\r`，不能发送 `\n`，否则 Windows PowerShell 无法正确处理。
- `AiComposerProvider` 必须始终挂载在 `App.tsx` 根部。条件包装会在密钥加载后重挂载整棵树并重新创建所有 PTY。

### Workspace 进程模型

每个原生 Workspace 窗口都是独立的 Terax 应用进程，拥有自己的 React WebView、Rust 状态、PTY、LSP、Shell、文件监听器、SSH/SFTP/tunnel 和 AI 运行时。新窗口和环境切换通过启动新进程完成，不重置当前窗口。

进程启动时确定的 Local、WSL 或 SSH 环境不可变。Space 只保存 UI 分组、根目录和标签页状态，不能切换进程后端。

Terax 自有数据统一存放在 `~/.terax`。全局可写配置通过白名单 `shared_store.rs` API 执行加锁、读取最新值、最小变更和原子替换。不得重新引入共享 `LazyStore` 或整表覆盖写入。

Workspace 窗口登记和一次性消息使用 `~/.terax/workspaces/terax-workspace-runtime.json`。它是可丢弃的运行时交换文件，不是配置或恢复状态；窗口存活以既有 Workspace OS lock 为准，不增加心跳。

### 前端与国际化

- 翻译资源位于 `src/i18n/locales/<language>/<namespace>.json`，所有语言的 namespace 必须一致。
- 所有用户可见文本都必须翻译，包括 JSX、按钮、菜单、tooltip、`title`、`aria-label`、`placeholder`、toast、验证错误、命令面板和 macOS 原生菜单。
- 新增用户可见文本时，同一次修改必须更新 `en` 和 `zh-CN`。
- `language` 设置是唯一语言状态来源，不要增加第二个 store，也不要持久化到 `localStorage`。
- 每个应用进程只有一个完整 Workspace 窗口；同一进程可以按需创建设置窗口和轻量辅助 `WebviewWindow`，但它们不能成为第二个 Workspace 运行时所有者。多个完整 Workspace 窗口仍来自多个独立进程。
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
- 终端标签的 `tab.id` 同时作为前端终端会话、renderer pool 和 Agent 路由的唯一身份，不得重新引入 `terminalId` 或 `leafId`。原生 PTY ID 是独立资源 ID，只能通过终端会话层映射。
- `editor/`：CodeMirror 页面、换行与缩进检测、冲突保存、格式化、diff、AI 补全和 LSP。大文件限制和主题解析必须保持现有不变量。
- `explorer/`：文件树、搜索、重命名和上下文操作；路径 basename 必须兼容反斜杠。
- `preview/`：开发服务器预览。
- `tabs/`：Workbench 标签页展示层，标签顺序和激活状态只由 Workbench 管理。
- `find/`：共享查找和替换 UI，搜索状态仍由编辑器、终端或 Git 等调用方持有。
- `workspace-search/`：轻量工作区内容搜索面板和公共请求类型；与 AI `grep` 共享 `fs_content_search`，不建立索引、watcher 或持久搜索历史。
- `header/`、`statusbar/`、`sidebar/`：应用框架、状态和侧边栏。
- `shortcuts/`：快捷键注册；跨平台组合键使用 `metaKey || ctrlKey`。
- `settings/`：白名单共享设置。
- `channels/`：只由 Local 永久主窗口拥有的 TS 消息连接、独立保活与固定 AI 会话；设置和通知入口只消费状态。
- `source-control/`、`git-history/`：Git 状态、diff、提交和历史。
- `lsp/`：按需启用，未启用时不得产生进程、PATH 检查或额外 eager bundle 成本。没有 root marker 就不能启动 session，每个 server 最多 4 个 session。
- `markdown/`：Markdown 预览。
- `workspace/`、`workspace-process/`：环境模型、启动上下文和多进程策略。
- `workspace-handoff/`：主窗口工作页复制协议、临时窗口发现和定向消息消费，不传输进程内运行时资源。
- `theme/`：自定义主题引擎，不使用 `next-themes`。
- `agents/`：内置 Agent 与终端编码 Agent 的通知、状态和 OSC 777 检测。
- `command-palette/`：命令与导航面板。
- `spaces/`：Workspace 内的 UI 分组，不拥有也不切换运行环境。
- `ai/`：AI 子系统，详细约束见下一节。

### AI 子系统

- 云端 provider 通过 `@ai-sdk/*` 接入；本地 provider 包括 LM Studio、MLX、Ollama。
- Claude Code、Codex 等完整 CLI Agent 通过独立 External Agent Runtime 接入，不伪装成网络 Provider 或 AI SDK `LanguageModel`。CLI 必须安装并登录在当前 Local、WSL 或 SSH 环境中，运行、探测和恢复不得回退到宿主环境。
- External Agent 复用统一 Agent 进程的 owner、Workspace 授权、stdin/EOF、有界输出和完整进程树清理；Rust 只接受封闭 Agent ID 并构造命令，前端 adapter 只解析结构化输出。直接聊天会话绑定 Agent 与外部 session ID，恢复数据随 Terax session metadata 持久化。
- 网络偏好统一保存到 `terax-settings.json` 的 `network.` 前缀键，逐连接精确更新；不单独维护网络配置文件。SSH 每次自动重连读取最新代理设置，但不改变当前 Workspace 的主机、身份与工作目录。
- 所有网络 Provider 的 SDK 必须注入原生 HTTP fetch，目录与推理使用相同实例身份选择出口；聊天、补全等消费者不另设路由。SDK 远端附件下载沿用 Provider 出口但不继承模型服务器的私网许可。代理策略与地址权限独立，失败不回退直连。详见 `docs/architecture/network.md`。
- 内置 provider 的地址、凭据策略、模型目录和运行时 adapter 统一定义在 `src/modules/ai/providerRegistry.ts`。设置页和 Agent 只消费解析后的连接，不按供应商名称重复拼接协议。新增流程见 `docs/architecture/ai-subsystem.md`。
- 远端模型目录只用于发现模型 ID；用户明确添加的模型才进入设置。不得重新加入静态模型清单、价格、上下文长度、营销说明或主观能力评分。
- 密钥只存放在系统 keychain 或 Linux secrets fallback，绝不能写入磁盘配置、settings store 或 `localStorage`。
- `lib/agent.ts` 保持 `Agent` 和 `DirectChatTransport` 结构，其他模块依赖 AI SDK v6 chat 语义。
- 会话以 `sessions/<uuid>.jsonl` 原子保存；首行固定为 metadata，后续每行是一条角色消息记录。单会话 OS 锁禁止两个进程同时继续同一会话。
- `ai/lib/conversation.ts` 统一会话记录、SDK 适配和模型、展示投影；每个会话只有一份 JSONL，不持久化模型或展示副本。后台结果以 `role=event`、展示快照以 `role=display` 保存原始 `content`，引导属性随 user 记录保存。运行时显式维护已提交 part 游标，只在原子写入成功后推进，序列化不得根据事件标记猜测提交进度。
- Terax 只有一个代码内定义、不可编辑或删除的主 Agent。Custom Agent 跨 Workspace 共享，只配置专属指令和内置工具白名单；Agent 仅能在未发送的 draft 中选择，首次发送后以 `metadata.agent` 快照绑定会话，persisted session 不得切换 Agent。
- 每个 Chat runtime 在首次模型请求时读取 Workspace 根 `AGENTS.md`，并冻结统一核心提示、执行环境、固定 cwd、会话 Agent 快照和自定义指令。后续轮次复用逐字相同的 system prompt 和工具集；LRU 淘汰或进程重启后从当前文件、设置和会话 Agent 快照重新构造。磁盘 metadata 中的 `systemPrompt` 只用于检查，不得作为恢复输入。
- Custom Agent ID 是会话归属和历史筛选键。删除 Custom Agent 必须通过 Rust 级联删除所有 Workspace 中的关联会话，并在任一关联会话运行时拒绝整个操作；不得保留孤儿会话或通过通用共享存储删除绕过该入口。
- 用户消息和该 Chat runtime 的系统提示词必须在模型请求前写入会话；普通流式半成品保留在所属进程，`AgentRunBridge` 在 idle、error 或 stop 后追加终态记录。`wait=false` Subagent 结果恢复主循环前，必须把此前完整步骤、恢复所需终态数据和 append-only 内部事件 checkpoint 到同一 turn，checkpoint 不得释放 session run lock。
- AI sidebar 是唯一完整聊天界面。面板卸载后运行仍通过 `AgentRunBridge` 继续；长任务的状态收集和持久化不得依赖可卸载 UI。
- Composer context 始终挂载，保证侧边栏关闭后草稿和附件仍然存在。
- 内置 Agent 运行中允许用户引导，统一由会话运行协调器的接入队列管理，用户输入优先于未消费的后台 Subagent 结果且同类保持顺序。前台工具调用和审批仍是接入边界。消费前不显示正文；消费时先保存完整前缀和带 `guided` 标记的用户消息，再分段展示并请求模型。中止清空所有未消费输入，不自动重放。
- 草稿会话的 cwd 优先跟随 Explorer 根目录；没有 Explorer 根时，Local 与 WSL 延迟创建并授权各自的 `~/.terax/workspace`，SSH 使用连接时验证的 profile Workspace root。SSH profile root 只提供默认位置，用户明确打开的任意可访问 Explorer 根都可以成为会话 cwd。首次发送时冻结并写入会话；所有相对工具路径始终基于该固定 cwd。终端最后 300 行仅在工具调用时读取，禁止提前快照。
- 请求批准模式下，cwd 内且非敏感的文件读取、搜索、写入、精确补丁和普通结构操作自动执行；cwd 外、敏感路径及递归删除按整个 tool call 请求一次性 UI 批准。批准只提升原调用，不改变会话 cwd 或后续调用。完全访问模式允许自动访问当前 Local、WSL 或 SSH 用户可访问的任意路径，并跳过敏感路径 deny-list。两种模式都保留普通文件、大小、条件写入、并发和灾难性操作保护。
- 请求批准模式下，`shell_exec` 对明确位于 cwd 内的普通开发命令自动执行；外部路径、网络访问和无法可靠分类的命令请求一次性批准。Shell 字符串检查只是保守的应用层分类，不是进程沙箱。完全访问模式跳过该分类并允许任意可访问 cwd。`shell_process` 的 stdin 写入仍需批准；进程轮询、列表、EOF 和终止只能作用于当前聊天拥有的登记进程并自动执行。
- 用户拒绝审批时保持 AI SDK `output-denied` 状态，将稳定拒绝原因作为 tool result 返回模型并持久化；模型不得通过替代工具、路径、编码或 Shell 重试绕过拒绝。
- 需要批准的 `write_file` 和 `apply_patch` 通过一个或多个 `ai-diff` 标签页审阅，并按整个 tool call 批准或拒绝；批准前不得实际写入。cwd 内自动执行的修改仍必须通过 prepared mutation、read-before-edit 和条件提交。
- `run_subagent` 只接受通用任务、标签和 `wait`，每聊天默认最多并发 3 个，超过上限立即拒绝。请求批准模式下 Subagent 只能使用父 Agent 白名单中的只读工具，且没有独立 UI 审批通道，需要提权的调用以原生边界错误返回；完全访问模式继承父白名单；两种模式都移除 `run_subagent`。`wait=false` 完成结果以标准 user 消息投影进入模型上下文，但在 UI 中保持隐藏，且不得改写既有 tool result 或消息前缀。

### Channels

- 仅 Local 永久 Workspace 主窗口启动 Channels。连接、协议、重连、消息队列和 Agent 接入均位于 TS；Rust 只提供通用 HTTP、秘密、存储和已有工具边界。
- 每个连接实例绑定固定 session UUID，使用 Local 的 `~/.terax/workspace`、主 Agent、每轮冻结的全局默认模型和完全访问权限，不修改桌面聊天的全局选择。不设置连接数量上限；连接独立在线和执行，同一连接按配置引导当前轮或等待本轮完成后顺序执行下一轮。
- 会话 metadata 的 `channelId` 不可变并投影到摘要。人工输入沿用跨环境会话的禁用机制，保留输入框；只有匹配连接在 Local 永久窗口可以提交 Channel 会话。
- 连接配置和有界协议状态位于 `~/.terax/channels`，正文继续保存在既有 `sessions`。状态存储不包含凭据或回复令牌，不进入 Workspace 恢复文件。
- 入站身份先记录再执行，回复在会话终态提交后发送。发送失败不重跑 Agent，异常退出后的未完成请求不自动重放。设置是独立 WebView，通过定向消息管理唯一主窗口服务。
- 首版个人微信只接受扫码账号本人私聊文本。扩展规则与协议恢复边界见 `docs/architecture/channels.md`。

### UI 与路径约定

- 界面样式统一遵循 `docs/contributing/ui-style.md`。业务 Button、Input、Textarea、Select、Dialog 和 AlertDialog 从 `@/components/controls/` 导入，使用公共默认字号、圆角、焦点和动效，不在页面中重复覆盖。菜单触发器和设置导航沿用无额外焦点边框的交互，不在菜单关闭恢复焦点时留下描边或光晕。
- 设置页与其他业务模块共享 `components/layout/` 和 `components/settings/` 的标题、字段和设置分组。组间距使用 `gap-section`，字段间距使用 `gap-field`；父容器拥有间距，普通设置采用组内分隔行，独立业务实体保留卡片。

- `src/components/ui/` 由 shadcn/ui 管理，`src/components/ai-elements/` 由 AI Elements registry 管理，不要手工修改生成代码。
- 业务代码中的 Dropdown Menu 和 Context Menu 统一从 `src/components/menu/` 导入，默认使用紧凑桌面密度；只有 registry 包装层可以直接导入对应的 `src/components/ui/` 生成组件。
- 业务代码中的 Select 统一从 `src/components/controls/select.tsx` 导入；包装层默认使用 12px 字号、32px 触发器高度和紧凑菜单行高，调用方只声明不同于默认值的尺寸或样式。只有该项目级包装层可以直接导入 `src/components/ui/select.tsx`。
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
- `docs/architecture/network.md`：内置 HTTP、连接级代理选择、SSH 共享与自定义代理及安全边界
- `docs/architecture/channels.md`：消息连接、固定会话、微信协议及通用网络边界
- `docs/architecture/external-agent-runtime.md`：外部 CLI Agent 的进程、协议、会话和跨环境边界
- `docs/architecture/terminal-renderer-pool.md`：renderer pool 和 DormantRing 不变量
- `docs/architecture/workspace-page-handoff.md`：主窗口向同环境临时 Workspace 复制可重建工作页
- `docs/contributing/testing.md`：测试约定和核心子系统不变量
- `docs/contributing/themes.md`：主题字段、Modern 基准、透明度规则和新增主题流程
- `docs/contributing/ui-style.md`：紧凑桌面 UI、公共控件入口、文字层级、间距和动效规范
- `docs/contributing/ui-runtime-debugging.md`：复杂 UI 的运行时调试和回归验证
