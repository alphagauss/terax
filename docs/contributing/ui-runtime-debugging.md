# Tauri 运行时调试

本流程仅在满足 [AGENTS.md 的运行时调试条件](../../AGENTS.md#ui-与验证) 后使用，不作为每次改动的默认验收步骤。进入调试前梳理源码、静态检查、自动化测试和已有人工反馈，记录复现条件及还需获取的证据；修复后用相同条件复验。

## 工具选择优先级

页面交互、布局和前端状态优先使用真实 Tauri WebView 的 CDP，其他平台使用对应 WebView inspector；后台行为优先通过原生接口、日志和进程证据排查。原生菜单、窗口激活和焦点优先人工验证反馈；确需自动化且上述方式无法覆盖时，最后才考虑 Computer Use 技能，使用前说明原因，只操作必要的原生步骤。不要因 CDP 暂时未连接就切换到 Computer Use，应先检查目标、启动参数和端口。

## Windows WebView2

读取 `src-tauri/tauri.conf.json` 的 beforeDevCommand 与 devUrl。Tauri CLI 自行启动前端，不另起第二个 Vite。先识别本 checkout 的旧开发实例，避免 Workspace 锁或 WebView profile 复用影响调试。

在同一 PowerShell 中前台运行：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\tauri-webview-debug"
pnpm.cmd tauri dev
```

保持该命令运行，从另一个 Shell 查询：

```powershell
Invoke-RestMethod http://127.0.0.1:9223/json |
  Select-Object title, url, webSocketDebuggerUrl
```

选择 URL 匹配 devUrl 的 page target，以支持 CDP 的客户端连接其精确 WebSocket 地址。确认 root 已挂载、`window.__TAURI_INTERNALS__` 存在且没有 IPC/bootstrap 错误。直接在普通浏览器打开 devUrl 不等于真实 Tauri。

原生进程存活但没有 WebView2 子进程或调试端口时，先检查启动输出与执行环境是否允许 GUI 子进程，不据此修改应用配置。profile 或端口冲突时选择独立目录或端口。

macOS、Linux 使用各自 WebView inspector；上述环境变量只适用于 Windows。

## 仅生产构建白屏

先比较可运行提交与失败提交，重点检查生产分块、资源路径和启动初始化。`pnpm tauri dev` 不执行生产分块，开发启动成功不能替代 release 验证。

原生日志写入 `~/.terax/logs/`，当前桌面日志文件为 `Terax.log`。Windows 可持续查看：

```powershell
Get-Content "$env:USERPROFILE\.terax\logs\Terax.log" -Tail 100 -Wait
```

当前日志插件只配置文件输出，前端 `console.error` 和未捕获异常不会自动写入该文件。原生日志正常时仍需检查 WebView Console。

退出目标 Workspace 的已有实例后，在设置上述 WebView2 调试环境变量的同一 PowerShell 中启动构建产物：

```powershell
& .\src-tauri\target\release\terax.exe
```

已有实例可能只被激活而不继承调试环境变量。通过 `http://127.0.0.1:9223/json` 查找 URL 为 `http://tauri.localhost/` 的主窗口 target，使用返回的 `devtoolsFrontendUrl` 打开检查器，或连接 `webSocketDebuggerUrl`。启用 Console 的 Preserve log，并在 Network 中检查失败的脚本和样式请求；必要时重新加载捕获首次异常。不要把截图窗口或辅助窗口误当成主窗口。

优先记录第一条异常的完整堆栈、资源文件名及行列号，再检查后续连带错误。如果错误只存在于压缩产物，可临时启用 Vite 的 `build.sourcemap` 后重新构建定位，结束后撤销。手动分块的循环引用可能改变依赖初始化顺序；非递归分组需配合 `output.strictExecutionOrder`，修复后仍应使用 `pnpm tauri build` 的实际产物复验。

## 插件命令缺失与构建缓存

若插件调用报 `Command ... not found`，先核对命令注册和 capabilities，区分命令未编入产物与运行时权限被拒绝。曾出现 capabilities 已允许 `write_html`，但 release 产物缺少该命令、普通文本和图片复制仍正常的情况。定向清理剪贴板插件缓存后，在 `removeUnusedCommands: true` 下重新构建已验证恢复，因此保留命令裁剪，不把永久关闭裁剪作为此类缓存问题的修复。

裁剪宏读取生成的命令表，涉及 [sccache 对过程宏读取文件的缓存限制](https://github.com/mozilla/sccache/blob/v0.16.0/docs/Rust.md)。仅清理 Cargo 产物仍可能从 sccache 取回旧插件；应同时定向清理对应缓存条目，或强制刷新它们。以下命令从仓库根目录执行，仅清理剪贴板插件的 release 产物，并在本次构建后恢复缓存环境变量：

```powershell
cargo clean --manifest-path src-tauri/Cargo.toml --release -p tauri-plugin-clipboard-manager
$previousRecache = $env:SCCACHE_RECACHE
try {
  $env:SCCACHE_RECACHE = "1"
  pnpm tauri build --no-bundle
} finally {
  $env:SCCACHE_RECACHE = $previousRecache
}
```

若只清缓存、稍后自行构建，应先确认没有编译任务运行，停止 sccache 服务后，按缓存归档内的 crate 产物名识别并删除对应条目，不清空全局缓存；下次编译会自动启动服务。dev 问题清理对应的 debug 产物，不带 `--release`。

复验使用实际构建产物，分别检查选中文字后的右键复制、剪贴板中的 HTML／纯文本格式与图片复制。单元测试中的插件 mock 不能证明原生命令已编入产物，图片复制成功也不能替代文字选区验证。

## 证据与收尾

React 开发组件轨道会复制变化前后的 props。React DOM 19.3 已包含[性能记录回收修复](https://github.com/react/react/pull/34803)，由 React 自身及时清理组件记录，主窗口和辅助窗口不再安装额外观察器；浏览器 Performance 录制仍能消费轨道事件。不要通过关闭整个 Performance API 或要求用户清空会话处理内存问题。

AI 性能验证同时记录 renderer 私有内存、JS 堆、Performance 记录数量和可见组件订阅；分别验证长流、内外层折叠、侧栏隐藏、取消与冷恢复。

动画逐项对照，保持窗口尺寸、缩放、刷新率和前台状态一致，区分单个动画与完整面板的成本。分别记录主线程耗时、样式重算、布局、Paint 和所属进程的 GPU 引擎占用；零 Paint 不代表零 GPU 成本，主线程改善不能当作同等 GPU 降幅。复测波动时明确结论边界，不把单轮百分比作为保证。

展开与收起分别验证，覆盖内容短于视口、略超视口和远超视口的情况，不能以收起正常推断展开正常。记录实际滚动视口边界、逐帧裁剪边界和后续标题位置，确认可见区域逐步揭示、后续内容同步移动；动画对象仍在运行不能证明可见区域仍有过渡。观察过渡过程中内容区域的尺寸是否逐帧变化，以及是否连带触发尺寸观测、虚拟列表测量或重新解析。可用长 Markdown 的目录开关、较多提交记录的侧边栏 Graph 分组作为代表场景；检查的是实际渲染路径，不以已有封装或虚拟化作为通过依据。复验快速反向切换、滚动和阅读锚点、焦点与命中区域、长标题省略、主题及 reduced motion 行为，使用要求见 [动画规则](ui-style.md#动画)。

只检查受影响元素、状态及其所属链路。布局收集 rectangle、client/scroll size 与计算样式；命中使用 elementFromPoint；焦点和重挂载检查 DOM identity、key 与 activeElement。截图用于外观，不能替代命中或生命周期证据。

结束时移除临时日志并停止本次启动的前台命令，必要时只清理已记录 PID 的子进程，不按进程名批量终止。按 [测试指南](testing.md) 验证受影响代码。
