# 复杂 UI 诊断与运行时调试

> Agent 指令：仅在有必要进行运行时检查时，才必须遵循本文档，例如仅凭源码难以验证 UI 问题、交互复杂、问题已反复修复失败，或用户明确要求运行时调试或验收。简单、局部且可通过源码验证的 UI 变更不需要此流程。一旦触发，必须在编辑代码前完整阅读本文档；即使疑似修复只是 CSS 或 React 变更，也不得跳过运行时复现或测量。

本指南主要面向在受限执行环境中工作的 Codex 和其他 Agent。命令和恢复步骤考虑了文件系统 sandbox、GUI 启动审批、detached child process 和浏览器控制能力边界。

当前端问题难以仅通过源码解释时，应使用本指南，例如控件错位、panel 裁剪或溢出、点击落到错误 target、状态似乎过时、组件闪烁或 remount，或者变更只在某些 layout 中有效。

目标不是随意尝试某个 CSS property，而是将视觉症状转换为关于 runtime state 的小型、可测试陈述，找出该陈述首次变为 false 的层级，并修复该层的约定。

编辑前，记录简短的复现约定：

```text
Given: [route, tab, theme, viewport, zoom, data]
When: [specific click, key, resize, navigation, or async completion]
Expected: [observable behavior]
Actual: [observable behavior]
Stable: [always, only after resize, only after reload, intermittent]
```

只包含与问题相关的状态，例如 viewport、theme、active tab、pane visibility、focus，以及 runtime 是否为真实 Tauri WebView。启动依赖 Tauri IPC 时，普通 Vite 页面不能作为有效复现环境。

## 启动 Tauri runtime 进行调试

UI 依赖 `invoke()`、event、PTY state、文件系统状态或 Workspace bootstrap 时，应使用真实 Tauri 进程。普通前端开发服务器并不等价，因为 Tauri IPC 可能在应用挂载前就失败。

### Windows 上最短且可靠的 Codex 流程

本流程面向 Codex 和其他受限执行环境。请依次执行。此路径成功前，不要添加后台 launcher、第二个 Vite 进程或 process supervisor。

1. 阅读 `src-tauri/tauri.conf.json`，记录 `build.beforeDevCommand` 和 `build.devUrl`。Tauri CLI 会自行运行 `beforeDevCommand`，因此不要单独启动该前端命令。Terax 使用 `pnpm dev` 和 `http://localhost:1420`。
2. 关闭该应用较早启动的开发实例。已有 WebView2 进程可能复用 browser profile 而不带新的调试参数，项目也可能强制使用 Workspace lock 或 single-instance policy。
3. 请求在 sandbox 外运行 Tauri 开发命令的权限。即使通过 Shell 工具启动，Tauri 开发命令仍属于 GUI 启动。执行环境必须允许 `terax.exe` 创建 WebView2 子进程。
4. 在已批准的执行上下文中，从项目根目录将以下命令作为一个前台 Shell command 运行：

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
   $env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\tauri-webview-debug"
   pnpm.cmd tauri dev
   ```

   Windows 上使用 `pnpm.cmd`，因为 PowerShell 可能将 `pnpm` 解析为被阻止的 `pnpm.ps1`。对于 npm、Yarn、Bun 或仅使用 Cargo 的项目，只替换最后一条启动命令。
5. 保持前台命令运行。从另一个 Shell 调用中验证 WebView2 target：

   ```powershell
   Invoke-RestMethod http://127.0.0.1:9223/json |
     Select-Object title, url, webSocketDebuggerUrl
   ```

只有当它返回应用页面和 `webSocketDebuggerUrl` 后，才能开始 DOM 或 CSS 检查。将兼容的 DevTools 或 CDP client 连接到该精确 target。预期的 Terax target URL 为 `http://localhost:1420/`。

成功条件很简单：

```text
tauri dev remains running
        +
the native window renders the expected project
        +
http://127.0.0.1:9223/json returns its WebView target
```

### 受限环境中的失败特征

如果 parent process 仍处于 sandbox 中，仅正确设置 WebView2 环境变量还不够。Codex 可能观察到看似应用或 CDP 配置问题的部分成功启动。

在受限环境中观察到的误导性失败如下：

```text
Vite listens on 127.0.0.1:1420
        +
terax.exe remains alive
        +
the temporary EBWebView directory is created
        +
no WebView2 child remains alive
        +
the Crashpad directory contains a new report
        +
127.0.0.1:9223 refuses connections
```

不要将此状态解释为 Vite host 问题、缺失 Tauri IPC shim，或 remote-debugging 参数不受支持的证据。在更改项目配置前，先以 GUI 权限重新运行同一个前台命令。成功启动后，会存在一个 live `msedgewebview2.exe` 进程，其命令行使用指定的 user-data 目录，并且 `/json` 返回应用 target。

诊断进程继承时，只检查本次启动创建的进程。Windows 上，在允许的情况下使用 `Get-CimInstance Win32_Process` 确认 parent chain 和 WebView2 参数。不要终止所有 `msedgewebview2.exe`：Windows Search、Microsoft 365、Codex 和其他应用可能拥有无关实例。

### 连接调试 client

`/json` response 是应用启动与浏览器检查之间的交接点。选择 `type` 为 `page` 且 `url` 匹配 `build.devUrl` 的 entry，然后将兼容的 CDP client 连接到该 entry 的精确 `webSocketDebuggerUrl`。

不要假设 browser automation skill 会自动发现任意 WebView2 CDP port。Codex 的应用内 Browser 可能可用，但 browser list 只包含应用内浏览器而不包含 WebView2 target。此时，只要 `/json` 返回正确 target，Tauri 调试设置就是正常的。使用能连接到返回 WebSocket URL 的 CDP client。不要改为打开 `http://localhost:1420`，因为这会创建一个没有 Tauri IPC 的独立浏览器页面。

在诊断 UI 行为前，先通过 CDP 确认以下最小 runtime 验证项：

- `location.href` 等于预期的 `build.devUrl`。
- `document.querySelector("#root")` 已挂载 child。
- `window.__TAURI_INTERNALS__` 存在。
- document title 或可见 Workspace state 与原生 Terax 窗口一致。
- console error 中没有 Workspace bootstrap 或 Tauri IPC failure。

### 停止调试 session

记录当前前台启动创建的 `cargo` 和 `terax.exe` process ID。应尽量正常停止前台命令。如果 Agent 侧 command wrapper 被终止但子进程仍在运行，只停止这些已记录的 process ID，并使用启动它们时相同的 elevated execution context。验证 port `1420` 和 `9223` 不再存在属于该调试 session 的 listener。

不要按进程名清理。无关 Cargo build、已安装的 Terax 实例或 WebView2 host 可能同时运行。

### 如果五个步骤失败

以前台输出为权威信息源，并且只修复第一个失败层级：

1. 如果 `pnpm.cmd tauri dev` 退出，读取该终端的第一个 error。不要通过 `Start-Process`、`cmd /c` 或其他后台 wrapper 重试。
2. 如果前端 port 被占用，识别现有 listener。只有它属于同一 checkout 和 revision 时才复用；否则关闭该过时开发进程，然后重新执行五个步骤。
3. 如果原生窗口打开但 `/json` 拒绝连接，确认两个 WebView2 环境变量已在运行 `tauri dev` 的同一个 PowerShell 中设置。由 Agent 启动命令时，还要确认执行环境允许 GUI 和 WebView2 子进程。关闭应用，使用新的临时 user-data folder 名称重试一次。
4. 如果 `/json` 返回错误 target，说明另一个 WebView 占用了 port 或 profile。关闭它或选择另一个调试 port，然后重启一次。
5. 如果原生页面空白但 `/json` 可用，检查 console 中的 Tauri IPC 或 bootstrap error。在应用 root 挂载前不要诊断 layout。

除非 Tauri 配置明确没有 `beforeDevCommand`，否则不要同时运行 `pnpm dev` 和 `pnpm tauri dev`。不要按名称终止进程，先确认 port owner 和项目。

macOS 和 Linux 上遵循相同顺序：读取 `tauri.conf.json`、运行一个前台 `tauri dev`、验证原生页面，然后连接该平台 WebView 支持的 inspector。上述 WebView2 环境变量仅适用于 Windows。

## 运行时检查

连接真实 WebView 后，使用能确认疑似失败的最小 probe：

| 症状 | 运行时证据 |
| --- | --- |
| 尺寸错误或溢出 | 元素与 ancestor rectangle、client size、scroll size、计算后的 overflow 和 sizing style |
| 可见但不可点击 | `elementFromPoint`、pointer event、stacking context、active overlay |
| UI 过时或缺失 | 将 rendered DOM 与当前 state、prop、IPC result 和 active route 比较 |
| remount、focus 丢失或 scroll reset | DOM identity、React key、mount lifecycle 和 `document.activeElement` |
| 仅 resize 后失败 | resize、pane activation、theme 或 zoom 变化前后的 measurement |

读取范围仅限受影响元素及其 ownership chain。记录能证实或否定 hypothesis 的 measurement，并在变更后重复相同 probe。截图只能验证外观，不能验证 hit testing、overflow、focus 或状态正确性。

## 动画性能约定

- 使用 `duration-feedback`、`duration-control`、`duration-pane` 或 `duration-surface`。没有显式 duration 的 Tailwind transition 和 entrance animation 使用 feedback timing。生成的 registry 文件可以保留由 compatibility layer 映射到 token 的数字 class；应用代码不得新增数字 duration utility 或 `transition-all`。
- pointer resize 期间不使用 transition。手势过程中通过 transform 更新 visual guide，松开后再 commit React state、layout persistence 和高开销 measurement。
- 优先使用 `transform` 和 `opacity`。只有短暂、离散的操作，且确认受影响 subtree 开销较小时，才允许 geometry transition。
- Workbench sidebar 立即改变 geometry，因为 xterm 和 editor observer 会响应每个中间尺寸。除非 transaction 期间明确暂停高开销 observer 并在结束后只 flush 一次，否则只为内容进入添加动画。
- 长 Markdown 文档只 commit 一次 outline geometry，并使用 FLIP 实现视觉移动。outline surface 可以动画 clip、transform 和 opacity，因为其 rendered subtree 较小且已 virtualized。
- `prefers-reduced-motion` 必须使所有 transition 和 animation 直接跳到结果。全局 smooth scrolling 保持禁用。

## 完成条件

- 在真实 Tauri WebView 中复现原始状态。
- 编辑前识别第一个错误层级。
- 使用相同 runtime evidence 验证修复。
- 只检查与 bug 相关的邻近 transition，例如 resize、hidden pane activation、focus 或 async completion。
- 移除临时日志，并停止已记录的调试进程。
- 运行与变更代码相适应的检查：`pnpm lint`、`pnpm check-types`、`pnpm test` 和相关 Rust 检查。
