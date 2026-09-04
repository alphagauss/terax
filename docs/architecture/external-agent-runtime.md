# External Agent Runtime

本指南说明 Terax 如何把当前 Workspace 环境中已安装的成熟 Agent CLI 作为聊天后端。当前支持 Claude Code 和 Codex；主 Agent 委派外部 Agent 不在当前阶段范围内，但必须复用本运行时。

## 定位

External Agent 是完整 Agent，不是 AI SDK `LanguageModel`，也不是网络 Provider。它拥有自己的系统提示、工具、权限、认证和会话存储。因此：

- External Agent 不进入 `providerRegistry.ts`，不声明 endpoint、credential 或模型目录。
- 聊天 transport 在调用 `runAgentStream` 前分流到 `runExternalAgentStream`。
- External Agent 不接收 Terax Custom Agent 指令或工具白名单。
- UI 可以把 External Agent 与模型放在同一个选择器中，但必须分组展示。

## 数据流

```text
Chat UI
  -> External Agent transport
  -> external_agent_run
  -> ShellState managed process
  -> Local / WSL / SSH
  -> CLI JSONL stdout
  -> External Agent adapter
  -> AI SDK UIMessageChunk
  -> Chat UI and session persistence
```

Rust 只接受封闭的 `ExternalAgentId`，并负责构造命令。前端不能提供 executable、参数模板或通用 Shell 命令。用户 prompt 只通过 stdin 发送，随后关闭 stdin，不进入命令行参数。

## 进程与环境

External Agent 复用 `shell::AgentProcess`，与 AI Shell 工具共享：

- 按聊天 owner 隔离的进程登记与容量限制
- Workspace cwd 授权
- Local、WSL、SSH 路由
- stdout、stderr 并发读取和有界日志
- stdin、EOF、终态和取消
- Unix process group、Windows Job Object 和远端进程组清理

`ProcessPurpose` 区分普通 Shell 与 External Agent。`shell_process`、`shell_list` 只能访问普通 Shell 进程；External Agent 只能通过自己的取消入口控制。删除聊天时 `shell_clear_owner` 回收两类进程。

CLI 必须安装并登录在当前应用进程绑定的环境中：Local 使用宿主环境，WSL 使用当前固定 distro，SSH 使用当前 profile 的远端环境。任何环境都不得回退到宿主机 CLI。可用性探测同样在目标环境执行，结果只做进程内缓存。

## 事件协议与 adapter

原生层通过每次运行独占的 Tauri `Channel` 发送两类事件：

```ts
type ExternalAgentProcessEvent =
  | { kind: "output"; stdout: string }
  | {
      kind: "done";
      status: "exited" | "timed_out" | "terminated";
      exitCode: number | null;
      stderr: string;
    };
```

前端共享有上限的增量 JSONL decoder。Agent adapter 把各自协议投影为统一语义事件：session、text、activity、usage、completed 和 error。未知 JSON 事件与单行非 JSON 噪声可以忽略；损坏数据不能截断后续有效事件。增加新 Agent 时只增加封闭启动定义、可用性探测和协议 parser。

`text` 映射为助手正文，`activity` 映射为已完成的 AI SDK tool part，并复用现有聊天活动块。启动 CLI 本身也是第一条活动；同一正文边界之前的活动逐条追加，折叠标题显示最新一条。正文到达会结束此前活动块，后续活动另起一块。External Agent 不占用侧栏标题的当前步骤字段，也不伪装成模型 reasoning。进程退出码可能因平台或远端通道而缺失；已收到协议 `completed` 且没有协议错误时仍视为成功，没有协议终态的零退出或未知退出则明确报错。

Claude Code 使用非交互 `stream-json`；Codex 使用 `exec --json`。二者的 session ID 从结构化事件取得，不能从文件名、终端文本或最近会话猜测。

## 会话归属

External Agent 在未发送的草稿中选择。首次消息接受后，绑定写入 Terax session metadata：

```json
{
  "externalAgent": {
    "agentId": "claude",
    "sessionId": "..."
  }
}
```

`agentId` 在会话创建后不可改变；`sessionId` 只能从 `null` 变为第一个有效值，之后不可替换。捕获 session ID 后立即在仍持有的 session run lock 中提交 metadata。Local、WSL、SSH 的外部会话数据由对应环境的 CLI 保存，Terax 只保存恢复所需的 ID。

External Agent 会话不能切换为其他 Agent 或普通模型；需要切换时创建新聊天。resume 失败必须明确报错，不能静默开启新外部会话，否则用户会误以为历史仍然连续。

## 权限边界

External Agent 的文件和 Shell 操作不经过 Terax 内置工具审批。当前两档权限只做保守映射：

- `ask`：映射到无人值守只读或 plan 模式，不允许自动修改。
- `full-access`：映射到 adapter 能证明的 Workspace 写入模式，不自动启用危险的权限绕过。

具体能力由 CLI 自身保证。Terax 不得宣称 External Agent 受 `fs::agent` 的 canonical path 或敏感路径规则保护。未来若需要逐工具审批，应接入 Agent 官方 permission callback、SDK 或 app-server 协议，而不是解析 TUI。

## 与终端 Agent 通知的关系

External Agent 直接聊天不创建 PTY 标签，不使用 OSC 777。它的状态来自结构化运行事件，并进入现有聊天通知桥。用户在普通终端手动启动 Claude、Codex 或 Gemini 时，现有 PTY hook 与 OSC 777 通知继续保留；两条路径只共享最终通知展示，不共享通信协议。

## 当前限制

- 只发送最新用户消息的文本 part；图片输入会被明确拒绝。
- External Agent 使用自己的项目指令发现规则，Terax Custom Agent 不生效。
- 安装探测不等同于认证探测；未登录错误由 CLI 返回。
- 主 Agent 委派、并行外部 Agent 和逐工具审批留到后续阶段。

## 扩展要求

加入新 Agent 必须同时提供：

1. Rust 封闭 ID、探测和启动参数。
2. 前端 JSON 或 JSONL parser fixture 测试。
3. session ID 与 resume 规则；不支持恢复时明确声明。
4. `ask` 与 `full-access` 的真实能力映射。
5. Local、WSL、SSH 中至少覆盖命令构造和环境归属。
6. 中止、非零退出、损坏输出和超长输出测试。

不得通过可配置命令模板、xterm 屏幕读取、定时模拟 Enter 或宿主 CLI fallback 接入新 Agent。
