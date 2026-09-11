# PTY 与 Shell 集成

终端是长生命周期交互式 PTY。其前端身份和窗口归属见 [进程模型](two-process-model.md)，原生实现位于 `src-tauri/src/modules/pty/`。

## Shell 行为

- 初始化脚本只作用于 Terax 启动的 Shell，不修改用户配置；保留用户启动配置与 prompt 行为。
- OSC 7 表示 cwd，OSC 133 表示命令边界。Agent 状态通过 OSC 133/777 标记检测，不从普通 TUI 重绘文本猜测。
- Windows 按 PowerShell 7、Windows PowerShell、cmd 的顺序检测默认 Shell；cmd 不提供相同集成能力。
- 终端 Enter 发送 CR（`\r`）；LF 不能替代 Windows PowerShell 的输入约定。

## 文件粘贴与拖放

只有本机终端接收宿主文件路径，WSL、SSH 终端拒绝文件粘贴和拖放，需通过文件管理器上传。文件路径优先于剪贴板附带的文本表示；多个路径按现有引用规则拼接，不附加回车，不执行命令。纯内存图片不生成临时文件，也不粘贴到终端；普通文本粘贴保持可用。

块终端处于命令编辑状态时，粘贴进入对应终端的命令编辑栏并保留编辑撤销；其他状态使用 xterm 粘贴。异步读取后按终端身份重新定位，不能因渲染器复用或输入栏切换而写入另一个终端。

## 生命周期限制

ConPTY 的创建与关闭必须串行化，重叠调用会使新终端无法输出。Windows PTY 必须由 Job Object 清理完整子进程树；仅终止直接 Shell 会遗留其开发服务器等后代。锁、缓冲和具体协议实现以源码注释及测试为准。

终端页面隐藏后仍接收 PTY 输出。运行中的 TUI 不能用旧快照加增量重绘恢复，详见 [renderer pool](terminal-renderer-pool.md)。`AiComposerProvider` 必须保持稳定挂载，不能因凭据加载条件改变而重挂载整棵应用树。
