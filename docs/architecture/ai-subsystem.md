# AI 子系统

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

## 概览

AI 子系统采用 BYOK（bring your own key）模式。它通过 `@ai-sdk/*` 支持云 provider，并通过 OpenAI-compatible endpoint 支持本地/离线 provider。Agent 层基于 Vercel AI SDK v6 chat 语义构建，包括 `streamText`、工具定义和 `stopWhen` step limit。

主要入口：`src/modules/ai/lib/agent.ts` 中的 `runAgentStream`。

## Provider

云 provider 定义在 `src/modules/ai/config.ts` 中：

- OpenAI、Anthropic、Google、xAI、Cerebras、Groq、DeepSeek、Mistral、OpenRouter
- 用于任意自定义 base URL 的 `openai-compatible`
- 本地：LM Studio、MLX、Ollama

`src/modules/ai/lib/agent.ts:76` 中的 `buildLanguageModel` 根据 `provider` 进入不同分支，以构建正确的 AI SDK provider instance。本地 provider 使用 `createOpenAICompatible`，并传入允许访问私有网络的 `localProxyFetch`；云 provider 则使用各自专用的 SDK constructor。

模型 metadata（context limit、cost、reasoning behavior）存储在 `config.ts` 的模型 registry 中。`resolveModel` 将 model ID 映射到对应 provider 和默认值。

### 新增 provider

1. 在 `src/modules/ai/config.ts` 的 `PROVIDERS` 中添加 `ProviderInfo` entry。
2. 在同一文件的模型 registry 中添加 model ID 和 metadata。
3. 在 `buildLanguageModel`（`src/modules/ai/lib/agent.ts:99`）中添加构建 provider instance 的分支。对于 OpenAI-compatible API，通常可以复用 `createOpenAICompatible`。
4. 如果 provider 需要 API key，更新 `config.ts` 中的 `providerNeedsKey` 和 keyring service mapping。
5. 如果需要专用的 `@ai-sdk/*` package，将其添加到 `package.json`，并说明 bundle cost 的合理性（参见 `CONTRIBUTING.md`）。
6. 新增 built-in 必须说明其相对于 `openai-compatible` 和 OpenRouter 的独特价值；`CONTRIBUTING.md` 对此有明确要求。

key 绝不会持久化到操作系统 keychain / Linux secrets 文件之外。

## Agent 运行循环

`runAgentStream`（`agent.ts:391`）会：

1. 通过 `buildConfiguredLanguageModel` 解析模型。
2. 根据 `selectSystemPrompt(modelId)`、session 工作目录、可选 persona、自定义指令和 `AGENTS.md` 项目指令构建稳定的 system prompt。联系模型前，准确的 prompt 和所有新 user message 都会 commit 到磁盘。
3. 将 UI message 转换为 model message；如果模型不保留 reasoning content，则将其移除；context limit 超出时 compact 旧 message。
4. 使用 `buildTools(ctx)` 提供的 tool set 和 `stopWhen: stepCountIs(MAX_AGENT_STEPS)`，通过 `streamText` 进行流式传输。
5. 发出 step label、usage delta 和 finish metadata。

tool set 在 `src/modules/ai/tools/tools.ts` 中，由 `fs`、`patch`、`search`、`shell`、`subagent`、`terminal`、`todo` 和 `managedAgent` builder 组装而成。

## Sub-agent

`src/modules/ai/agents/registry.ts` 定义只读 sub-agent：`explore`、`code-review`、`security` 和 `general`。每个 sub-agent 都有 tool whitelist 和自己的 system prompt。`run_subagent` 不能递归调用，因为 sub-agent tool set 不包含 `run_subagent` 本身。

## Session

对话按 session 组织。已接受的 user message 和完整 response record 以每个 UUID 一个原子 JSONL 文件的形式存储在 `~/.terax/sessions/` 下（`src-tauri/src/modules/ai_sessions.rs`、`src/modules/ai/lib/sessions.ts` 和 `src/modules/ai/lib/sessionMessages.ts`）：

- `<uuid>.jsonl`：第一行是固定 metadata record，其余每行是一条 role message
- `<uuid>.lock`：一个进程运行该 session 时使用的 OS lock
- 不使用共享 session index；list 操作只读取第一行 metadata
- `ai_sessions_list` 将每个 header 投影为显式的 lightweight summary，绝不返回 `systemPrompt` 等仅供检查的 metadata

```json
{"_type":"metadata","key":"<uuid>","createdAt":"2026-07-26T10:00:00.000Z","updatedAt":"2026-07-26T10:00:01.000Z","environmentKey":"local","cwd":"/workspace/project","metadata":{"title":"Session title","todos":[],"systemPrompt":"..."}}
```

JSONL message schema 属于 Terax，而不是 Vercel AI SDK。user 和 Assistant 文本使用直接的 `role` 和 `content` field，reasoning 使用 `reasoning_content`，tool result 使用 `role: "tool"`。tool call 刻意遵循 OpenAI-compatible envelope：

```json
{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}],"timestamp":"2026-07-26T10:00:00.000Z"}
{"role":"tool","tool_call_id":"call_1","name":"read_file","content":{"content":"..."},"timestamp":"2026-07-26T10:00:00.000Z"}
```

`function.arguments` 始终为 JSON string。chat hydrate 时，显式 adapter 会将这些 record 投影为 AI SDK `UIMessage` 值。每个 persistence phase 只将其新增 record 发送给 Rust；Rust 在 session lock 下读取现有 JSONL、追加 record，并原子替换完整文件。这使磁盘格式保持可读，也使未来切换 SDK 的影响限制在 adapter 内。

streaming state 保留在所属进程中。发送操作首先获取 session run lock。每个 locked session 都保留自己的 runtime bridge，因此 active UI 可以切换 session，而不会停止后台 streaming 或 approval。运行中的 session 不能删除。transport 在创建模型 request 前 commit 已接受的 user record 和当前 prompt。`AgentRunBridge` 只在 session 进入 idle、error 或 stopped 状态且没有 pending approval 后，追加完整的 Assistant 和 tool record。只有 terminal commit 和 Rust lock release 都成功后，才清除前端可观察 lock。background-running 和 completed-unread indicator 是进程内 memory state：查看对应 session 会将其清除，且永远不会写入 session file。focus/poll/normal-close 路径也会 flush 已完成的 run。进程 crash 会保留最近接受的 user message，但不会写入不完整的 Assistant stream。

其他 Workspace 进程每三秒 poll metadata（窗口隐藏且 AI panel 关闭时暂停），在 focus 时 refresh，并且绝不覆盖本地正在运行的 session。fingerprint 变化会在复用前驱逐 inactive cached runtime。active session ID 存储在 UUID 对应的 Workspace 文件中，恢复顺序依次为已保存 ID、最近的 session 文件、全新 session。

## Composer

`AiComposerProvider`（`src/modules/ai/lib/composer.tsx`）是 React context，为 docked input bar 和其他 surface 保存共享输入状态（文本、附件、语音）。附件可以是图片、文本文件或来自终端/编辑器的 `selection` chip。提交时，selection 会包装为 `<selection source="terminal|editor">…</selection>` block，而不会粘贴进 textarea。

composer 根据 active session 在 `agentMetaBySession` 中的 entry 派生 `isBusy`，因此它可以在 session hydrate 前安全挂载，同时其他 session 继续在后台运行。

draft 会显示并跟随当前 Explorer root。第一条被接受的 user message 会将其提升为 persisted session，并将该 root 冻结为 `cwd`。persisted session 始终显示并使用已存储的 `cwd`。文件和 selection 仅在明确附加时作为可见 user-message content 发送。

每次模型 request 都先在 session run lock 下 commit 新 user message 和当前 system prompt 的准确内容。approval continuation 只覆盖 prompt，不会重复 user record。run 进入 idle、error 或 stopped 状态后，bridge 使用相同 turn ID 追加完整的 Assistant 和 tool record。streaming fragment 永远不会写入。

## 工具与审批

工具定义位于 `src/modules/ai/tools/`：

- 只读工具是 `read_file`、`find_files`、`grep`。全文写入使用 `write_file`，已有文件精确编辑使用 `apply_patch`，移动、复制、删除和空目录创建使用 `file_operation`。
- 六个模型文件工具全部进入 `src-tauri/src/modules/fs/agent.rs`。该后端将聊天 owner 绑定到固定 Workspace 根，在 Rust 中统一执行路径解析、敏感路径、普通文件、分页、读取版本、修改快照和 Local、WSL、SSH 路由；前端不再实现文件路径安全或正文变换。
- `find_files` 同时覆盖直接目录列举和递归 glob。`grep` 复用 `fs_content_search` 匹配引擎，支持目录和显式单文件目标，并在 Agent 后端完成安全过滤、content/files/count 聚合、上下文和分页。
- 修改型工具（`write_file`、`apply_patch`、`file_operation`、`shell_exec`）设置动态 `needsApproval`。`shell_process` 只有 `write` action 需要批准，poll、EOF、terminate 与 `shell_list` 自动执行。AI SDK 暂停后，无论当前显示哪个 chat，UI 都会为每个 request 渲染一个持久 approval toast。
- Shell 工具只有 `shell_exec`、`shell_process`、`shell_list`。短命令和长任务共享按聊天 owner 隔离的原生进程表，stdin、EOF、增量 offset、固定文本等待、hard timeout 和完整进程树终止不通过前端模拟。POSIX 环境默认使用 Bash，Windows Local 默认使用 PowerShell。
- `write_file` 的 rewrite 模式和 `apply_patch` 强制执行 read-before-edit：模型必须在本 session 中提前读取相同版本。create 模式要求目标缺失并自动创建父目录。精确补丁按读取结果使用 LF 匹配，同时保留既有 CRLF 文件的换行风格。

审批后的自动发送使用 `lastAssistantMessageIsCompleteWithApprovalResponses`。

## 编辑 diff

文件修改审批由 Rust 准备不可变的逐文件 before/after snapshot 和原始文件版本，并显示 summary toast。用户可以为一个多文件调用打开多个只读 `ai-diff` tab，并从任一 surface 批准或拒绝整个 tool call。批准后后端重新验证 Workspace 根、canonical path 和全部文件版本，再逐文件条件写入。每个文件独立原子发布，多文件调用不承诺跨文件系统原子性，运行中失败会尽力回滚已发布文件。同一流程无需 Git 仓库也能工作。

## 实时上下文桥接

`App.tsx` 发布当前 Explorer root 供未发送 draft 使用，并提供 lazy terminal-buffer reader。draft 发送后，session 存储的 `cwd` 成为相对 tool path 的唯一基准。终端输出保持 live，仅在模型明确调用终端工具时读取。

## 不变量

- 保持 Vercel AI SDK v6 chat 结构（`streamText`、tool、step limit），其余 UI 依赖该结构。
- key 只能通过 `secrets_*` command 访问，绝不能写入磁盘、settings store 或 `localStorage`。
- 新 provider 必须说明 bundle cost 和独特价值的合理性。
- 修改型工具需要审批；只读工具仍必须通过 Rust Workspace 根、canonical path 和敏感路径检查。
- 内存 message list、持久化 message record 和模型 input 保留相同的 message content。发送时不注入 active tab、cwd 或 environment block。
- persisted session 的 `cwd` 不可变，每个相对 tool path 都基于它解析。
- `shell_exec` 未显式传 cwd 时延续该聊天最近同步完成的 Shell cwd；已经返回为长任务的进程不得在稍后退出时异步改变聊天 cwd。
- 获取 persisted session run 时，从经过验证的 JSONL header 恢复已保存 cwd 的授权，但不改变 Explorer root。
- session run lock 持有其内存 runtime，直到 commit 和 release 均成功；session navigation 不得绕过该生命周期。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和 command 目录
- [安全模型](security-model.md) - 每个工具都必须遵守的边界
