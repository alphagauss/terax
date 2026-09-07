# External Agent Runtime

当前支持 Claude Code 和 Codex 的直接聊天。CLI 拥有自己的提示词、工具、认证、权限和会话，不能作为 AI SDK LanguageModel 或网络 Provider 接入，也不接收 Terax Custom Agent 指令与白名单。

## 执行与协议

CLI 必须安装并登录在当前 Workspace 的 Local、WSL 或 SSH 环境中，探测、执行和恢复均不得回退宿主环境。

Rust 接收封闭 Agent ID 并构造命令，prompt 只走 stdin；前端 adapter 将结构化 JSONL 输出投影为统一聊天流，不解析 TUI、猜测最近会话或接受任意启动模板。新 Agent 需定义启动、探测、协议 parser、恢复和权限映射。

运行复用受管 Agent 进程的 owner、容量和完整进程树清理，但普通 shell_process、shell_list 不得访问外部 Agent 进程。聊天删除回收两类进程。

协议 completed 且没有协议错误可作为成功证据，即使平台无法提供退出码；没有协议终态的零退出或未知退出须报错。活动记录与正文分段展示，不伪装成模型 reasoning。普通终端 OSC 通知继续独立存在。

## 会话

草稿首次发送后绑定 Agent，不能切换普通模型或其他 CLI。外部 session ID 只能由结构化事件取得，从空值变为首个有效值后不再替换；捕获时立即在现有运行锁内保存。

外部历史由对应环境的 CLI 保存，Terax 只记录恢复标识。resume 失败明确报错，不能静默新建会话。目前只发送最新用户消息的文本，图片拒绝，安装探测不代表已经认证。

## 权限

- ask 映射到 CLI 无人值守只读或 plan 模式，不允许自动修改。
- full-access 映射到 adapter 能证明的 Workspace 写入能力，不自动开启危险权限绕过。

文件和 Shell 操作不经过 Terax 内置工具审批，不能宣称受 fs::agent 的 canonical 或敏感路径策略保护。逐工具审批需要官方回调、SDK 或 app-server 协议；主 Agent 委派与并行编排仍待后续范围确认。
