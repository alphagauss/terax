# Tauri 运行时调试

用户明确要求，或源码与测试无法可靠区分运行状态相关原因时使用本流程。编辑前记录复现条件和需要确认的证据，修复后用相同条件复验；确定性的局部样式修改不默认启动应用。

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

## 证据与收尾

只检查受影响元素、状态及其所属链路。布局收集 rectangle、client/scroll size 与计算样式；命中使用 elementFromPoint；焦点和重挂载检查 DOM identity、key 与 activeElement。截图用于外观，不能替代命中或生命周期证据。

结束时移除临时日志并停止本次启动的前台命令，必要时只清理已记录 PID 的子进程，不按进程名批量终止。按 [测试指南](testing.md) 验证受影响代码。
