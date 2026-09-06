# AI 子系统

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

## 概览

AI 子系统采用 BYOK（bring your own key）模式。它通过 `@ai-sdk/*` 支持云 provider，并通过 OpenAI-compatible endpoint 支持本地/离线 provider。Agent 层基于 Vercel AI SDK v6 chat 语义构建，包括 `streamText`、工具定义和 `stopWhen` step limit。

主要入口：`src/modules/ai/lib/agent.ts` 中的 `runAgentStream`。

## Provider

内置 provider 的稳定事实统一定义在 `src/modules/ai/providerRegistry.ts`：

- OpenAI、Anthropic、Google、xAI、Cerebras、Groq、DeepSeek、Mistral、OpenRouter
- 用于任意自定义 base URL 的 `openai-compatible`
- 本地：LM Studio、MLX、Ollama

每条 `ProviderDefinition` 在一起声明展示信息、固定或可编辑地址、私网策略、凭据策略、模型目录 adapter 和运行时 adapter。注册表不保存用户密钥、模型 ID、价格、上下文长度或模型能力。`ProviderId` 从注册表 key 推导，不维护第二份联合类型。

`resolveProviderInstance` 把内置地址覆盖、自定义 Provider 和进程内凭据解析为统一 `ResolvedProviderConnection`。设置页、模型目录、聊天、Subagent、自动补全和 Git 提交只消费这个连接，不按供应商名称重新拼接地址或鉴权。

`src/modules/ai/lib/providerRuntime.ts` 根据注册表引用的 runtime adapter 构造 AI SDK provider instance。OpenAI、Anthropic、Google、xAI、Cerebras 和 Groq 使用各自的延迟加载 SDK adapter；DeepSeek、Mistral、OpenRouter、本地服务和自定义 Provider 复用 `openai-compatible` adapter。是否允许私网访问由连接定义决定，不由组件传入。

全部 SDK adapter 注入 `createHttpFetch`，云端和本地请求均经过 Rust。目录与推理只传同一个 Provider 实例身份，由原生层在请求开始时读取最新出口；语音服务另有独立路由。SDK 本地下载远端附件时也走原生传输并保留公开地址限制。配置格式与生命周期见 [内置网络与代理](network.md)。

模型身份统一使用结构化的 `ModelRef { providerId, modelId }`。内置 Provider 实例 ID 固定为 `builtin:<provider>`；用户新增的 OpenAI-compatible Provider 在创建时生成 `custom:<uuid>`，名称、地址和模型名变化都不会改变该实例 ID。自定义 Provider 的密钥也只按这个稳定 ID 绑定。

Terax 不维护静态模型目录。`modelCatalog.ts` 使用 `openai`、`anthropic`、`google` 和 `xai` 四种目录 adapter，从统一连接解析模型接口、分页和鉴权。成功结果进入五分钟、有界容量的进程内 LRU，同一连接的并发请求会合并；失败和刷新结果都不会直接改变用户配置。设置页最多同时渲染 100 个匹配项，避免大型目录产生无界 React 节点。

用户从远端结果添加或手动输入的模型保存到 `providerModels[providerId]` 数组，只记录 ID 和 `discovered` 或 `manual` 来源。远端目录始终是建议数据，刷新不会自动增加、删除或禁用已配置模型。接口失败时仍可手动输入模型 ID。

`resolveModel` 只根据完整 `ModelRef` 和 Provider 实例解析连接，禁止从模型名推断 Provider。模型接口没有统一的上下文长度字段，因此目录层不猜测或保存它，界面也不把内部历史清理预算显示为模型上下文长度。价格、营销说明和主观能力评分不进入配置。设置、当前选择、默认模型、Subagent 模型、自动补全、收藏和最近使用都使用完整引用；没有已添加模型时相关默认值为 `null`。

可编辑内置地址统一保存在 `providerBaseURLs[provider]`，未覆盖时使用注册表默认值。自定义 Provider 继续保存稳定实例 ID、名称、协议和地址。所有密钥只进入 keyring，目录缓存和持久化设置都不包含密钥。

### 新增 provider

先确认新 Provider 使用的三种协议：credential、catalog 和 runtime。不要根据品牌创建重复 adapter。

使用现有协议的 Provider：

1. 在 `providerRegistry.ts` 的 `PROVIDER_DEFINITIONS` 中增加一条定义。地址必须是 API base URL，模型路径放在 `catalog.path`，不得写入模型 ID。
2. API key Provider 选择 `api-key` credential adapter，并声明是否必需、keyring account、输入提示前缀和目录鉴权方式。无凭据 Provider 使用 `none`。
3. 模型目录选择已有的 `openai`、`anthropic`、`google` 或 `xai` adapter。OpenAI-compatible 服务通常选择 `openai`。
4. 模型调用选择已有 runtime adapter。OpenAI-compatible 服务统一选择 `openai-compatible`，额外固定 header 放在该定义的 `runtime.headers`。
5. 可编辑地址使用 `endpoint.kind = "editable"` 并声明默认地址和私网策略。固定云地址使用 `fixed`，不得允许私网。
6. 可选地在 `ProviderIcon.tsx` 增加专属图标；未增加时自动使用通用图标。可编辑内置 Provider 还需为设置页说明补充英文和中文翻译。
7. 为非标准地址、鉴权或响应补充一个可观察行为测试。已有 adapter 的普通数据项不重复测试。

只有协议确实不兼容时才新增 adapter：

- 新目录协议在 `modelCatalog.ts` 增加一个 `CatalogAdapterId` 和对应分页、响应解析规则。目录输出仍只能是模型 ID。
- 新调用协议在 `providerRuntime.ts` 增加一个 `RuntimeAdapterId` 和延迟加载 factory。新增 `@ai-sdk/*` 依赖时必须说明 bundle cost。
- 新凭据协议扩展 `ProviderCredentialDefinition`、凭据服务和设置页凭据控件。OAuth 登录、回调、刷新、退出和 token 存储属于 credential adapter，不进入 catalog 或 runtime adapter。

OAuth 的 refresh token、PKCE verifier 和登录状态必须由 Rust 与 keyring 管理，不得写入 settings store 或 `localStorage`。运行时只消费 credential adapter 返回的短期凭据。完成首个 OAuth adapter 后，共享相同流程的 Provider 只需复用该 adapter。

新增 built-in 必须说明其相对于 `openai-compatible` 和 OpenRouter 的独特价值；`CONTRIBUTING.md` 对此有明确要求。

key 绝不会持久化到操作系统 keychain / Linux secrets 文件之外。

## Agent 配置

Terax 只有一个代码内定义的固定主 Agent。主 Agent 不进入共享存储，不可编辑或删除，并拥有完整内置工具集。Custom Agent 以独立记录保存在 `ai-agents` 共享存储中，只包含稳定 ID、名称、描述、专属指令、图标和工具白名单；旧定义缺失工具字段时按完整工具集读取，不保留旧版全局 active Agent 状态。

Agent 只在未发送的 draft 中选择。第一条 user message 被接受时，当前定义会投影为 `metadata.agent` 会话快照；之后该会话不能切换 Agent。Agent 的指令和工具列表使用快照，后续编辑只影响新会话；显示名称和图标优先使用仍存在的当前定义。旧会话缺少 `metadata.agent` 时归入固定主 Agent。

Custom Agent 的工具权限是实际 provider tool schema 白名单，不是 prompt 建议，也不改变审批策略。`agentTools.ts` 维护稳定工具 ID 和六个设置界面工具组；修改工作区依赖读取工作区。运行时按快照过滤 `buildTools` 的结果，未提供的工具不会发送给模型。

Custom Agent ID 同时是会话归属。历史列表可按 Agent 筛选；删除 Custom Agent 会在 Rust 中取得共享 Agent 配置锁和全部关联 session lock，然后删除所有 Workspace 中的关联会话，最后删除定义。任一关联会话正在运行时整个操作被拒绝。通用 `shared_store_delete` 不允许绕过该级联入口。

## Agent 运行循环

Claude Code、Codex 等完整 CLI Agent 不进入本节的 Provider 与 `runAgentStream` 路径。它们在 Chat transport 层分流到统一 External Agent Runtime，复用当前 Workspace 的受管进程，并将结构化 CLI 输出转换为相同的 AI SDK 消息流。详细边界见 [External Agent Runtime](external-agent-runtime.md)。

一次主 Agent 请求会：

1. `createSessionTransport` 在 Chat runtime 首次发送时读取 Workspace 根 `AGENTS.md`，并根据统一核心提示、执行环境、固定 cwd、会话 Agent 快照和自定义指令构造 system prompt。该 Promise、Agent 快照和最终字符串由 transport 闭包持有，后续轮次不再读取或重建。
2. `runAgentStream` 通过 `providerRuntime.ts` 的 `buildConfiguredLanguageModel` 解析当前模型。模型可以切换，但不改变已经冻结的 system prompt。
3. 联系模型前，准确的 prompt 和所有新 user message 都会 commit 到磁盘。
4. 将 UI message 转换为 model message 并保留 reasoning content；超过内部历史清理预算时 compact 旧 message。
5. 使用 `buildTools(ctx, agent.tools)` 过滤后的 tool set 和 `stopWhen: stepCountIs(MAX_AGENT_STEPS)`，通过 `streamText` 进行流式传输，并发出 step label、usage delta 和 finish metadata。

完整 tool set 在 `src/modules/ai/tools/tools.ts` 中，由 `fs`、`patch`、`search`、`shell`、`subagent`、`terminal` 和 `todo` builder 组装而成。

## 运行中用户引导

`AgentTurnCoordinator` 持有当前会话运行的 `TurnInbox` 和 Subagent 资源。用户引导与后台结果共用接入队列，用户引导优先，同类用户输入按发送顺序消费。前台工具和 `wait=true` Subagent 仍须执行完成；审批请求不会被新增输入绕过；恢复时先由 SDK 落实批准或拒绝对应的工具结果，再接入待处理消息，保持审批响应处于 SDK 要求的末尾位置。等待后台任务时，新引导可以唤醒主循环。

桌面内置 Agent 运行时，输入为空显示中止，有可发送内容时显示引导按钮并保留次级中止入口。引导发送后仅显示待接入数量；安全边界消费时结束前一个活动块，先 checkpoint 完整步骤与用户消息，再在正文显示“已引导”和新的活动块。主循环已关闭接入但终态仍在提交时，桌面发送等待锁释放后作为下一轮处理。外部 CLI Agent 不使用此循环，尚不提供运行中引导，继续显示中止操作。

引导用户记录使用 `guided: true` 与 `message_id` 保存显示身份，保持原始正文和媒体。Chat 流内用 `data-user-steering` 保持 append-only 前缀，历史恢复使用同一结构，展示层按该消息分段。provider 边界转换为标准 user 消息并添加补充说明，不透传展示标记或内部 data part。

中止同步封闭接入并取消所有未消费输入，不恢复为草稿、不留到下一轮；已消费历史不回滚。消息接入、检查点提交和轮次结束由同一运行时裁决，完整轮次始终持有原 session run lock。

## Sub-agent

`run_subagent` 是通用委派工具，只接受自包含的 `task`、可选 `label` 和默认值为 `false` 的 `wait`。它不提供角色类型、temperature 或单次模型覆盖。Subagent 使用独立消息历史，并复用父聊天冻结的 system prompt、cwd、provider 配置和 Custom Agent 工具白名单。

Subagent 模型默认跟随本轮主模型，也可以通过模型设置页的 `defaultSubagentModel` 单独指定完整模型引用。每个聊天最多并发 `maxConcurrentSubagents` 个任务，默认 3、允许 1 至 8；超过上限立即返回拒绝结果，不建立等待队列。

权限在任务启动时冻结。主 Agent 为请求批准模式时，Subagent 工具进一步收窄到 `read_file`、`find_files`、`grep` 和 `get_terminal_output` 的父白名单交集；Subagent 没有独立 UI 审批通道，越界或敏感读取继续以请求批准模式进入 Rust，并将明确拒绝返回模型。完全访问模式继承父白名单。两种模式都移除 `run_subagent`，所以 Subagent 不能递归创建 Subagent。

`wait=true` 时，最终结果直接作为原工具调用的 tool result。`wait=false` 时，原工具调用立即返回 started，后台完成结果以 append-only 的 `role=event` 记录进入同一 turn，`content` 只保存结构化 `subagent_result`。SDK 流用隐藏 data part 承载事件；会话模块在模型投影时生成标准 user 正文，在展示投影时将结果归属工具卡片，不重复保存格式化正文或任务 ID 列表。它不改写既有 tool result 或历史前缀。

主 Agent 在普通工具边界消费已经完成的后台结果。若模型到达候选终态但仍有后台任务，session run lock 保持占用，等待后台结果或用户引导唤醒，持久化待消费消息后恢复完整 Agent 循环。恢复后的模型仍可继续调用普通工具或创建新的 Subagent，只有模型给出终态且没有运行中任务或待消费结果时才结束本轮。

每个 `run_subagent` 在聊天中使用专用卡片。运行时只报告模型调用中、工具开始、工具完成和终态，不传输 Subagent 推理正文或中间回答。标题当前显示的工具动作至少保持一秒，期间的新状态合并为最新动作；该计时只属于 UI，不阻塞真实执行。展开卡片可查看原始 task、工具过程和最终结果，结果仍来自 wait=true 工具输出或 wait=false 内部结果事件。

运行中的展示状态按 session 保存在当前进程，跨聊天切换和工具审批等待时继续更新。本轮终态提交会为每个 Subagent 追加一个 `role=display`、`content` 为最终快照的记录，历史加载时投影为 `data-subagent-display`。快照只包含 task ID、父工具调用 ID、label、状态、耗时和有界脱敏的工具摘要，不重复 task、结果正文、完整参数或工具输出。进程在本轮结束前崩溃时不保证恢复详细过程。

`role=display` 和 `data-subagent-display` 永远不会转换为 model message。它们不改变原 `subagent_result` 的正文和顺序，所以 provider 请求和 prompt cache 前缀与没有展示数据时相同。损坏或找不到对应 `run_subagent` 工具调用的展示记录会被忽略，不会暴露为用户消息。

## Session

对话按 session 组织。已接受的 user message 和完整 response record 以每个 UUID 一个原子 JSONL 文件的形式存储在 `~/.terax/sessions/` 下（`src-tauri/src/modules/ai_sessions.rs`、`src/modules/ai/lib/sessions.ts` 和 `src/modules/ai/lib/conversation.ts`）：

- `<uuid>.jsonl`：第一行是固定 metadata record，其余每行是一条 role message
- `<uuid>.lock`：一个进程运行该 session 时使用的 OS lock
- 不使用共享 session index；list 操作只读取第一行 metadata
- `ai_sessions_list` 将每个 header 投影为包含 Agent 身份的显式 lightweight summary，绝不返回 `systemPrompt` 等仅供检查的 metadata

```json
{"_type":"metadata","key":"<uuid>","createdAt":"2026-07-26T10:00:00.000Z","updatedAt":"2026-07-26T10:00:01.000Z","environmentKey":"local","cwd":"/workspace/project","metadata":{"title":"Session title","agent":{"id":"a-review","name":"Reviewer","icon":"reviewer","instructions":"...","tools":["read_file","grep"]},"todos":[],"systemPrompt":"..."}}
```

会话消息规则集中在 `lib/conversation.ts`：`projectSessionMessages` 恢复 SDK 状态，`serializeSessionMessages` 编码完整记录，`convertToAgentModelMessages` 和 `projectConversationDisplay` 分别投影模型与展示。实时接入和历史恢复共用事件适配与有序展开规则。模型投影只选取协议内容，展示投影剥离内部事件并提供卡片数据；UI 不解释 SDK 事件结构。每个会话只持久化一份 JSONL，不建立模型、展示副本或额外历史 store。展示投影按 SDK 不可变消息快照使用弱引用缓存，流式更新不会反复处理已完成历史。

JSONL message schema 属于 Terax，而不是 Vercel AI SDK。user 和 Assistant 文本使用直接的 `role` 和 `content` field，reasoning 使用 `reasoning_content`，tool result 使用 `role: "tool"`。tool call 刻意遵循 OpenAI-compatible envelope：

```json
{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}],"timestamp":"2026-07-26T10:00:00.000Z"}
{"role":"tool","tool_call_id":"call_1","name":"read_file","content":{"content":"..."},"timestamp":"2026-07-26T10:00:00.000Z"}
```

`function.arguments` 始终为 JSON string。经过审批的 tool record 保存原始 approval ID、决定、原因和可选签名，保证批准、拒绝和执行失败在恢复后的 approval request/response 与实时 provider 前缀逐字一致。chat hydrate 时，显式 adapter 会将这些 record 投影为 AI SDK `UIMessage` 值。每个 persistence phase 只将其新增 record 发送给 Rust；Rust 在 session lock 下读取现有 JSONL、追加 record，并原子替换完整文件。这使磁盘格式保持可读，也使未来切换 SDK 的影响限制在 adapter 内。

streaming state 保留在所属进程中。发送操作首先获取 session run lock。每个 locked session 都保留自己的 runtime bridge，因此 active UI 可以切换 session，而不会停止后台 streaming、Subagent 展示更新或 approval。运行中的 session 不能删除。transport 在创建模型 request 前 commit 已接受的 user record 和 Chat runtime 冻结的 prompt。metadata 中的 `systemPrompt` 只用于事后检查，不参与会话恢复。普通运行由 `AgentRunBridge` 在 session 进入 idle、error 或 stopped 状态且没有 pending approval 后追加完整记录和 Subagent display 快照；`wait=false` Subagent 恢复主循环前则通过 checkpoint 追加此前完整的 Assistant、tool 和内部结果事件，但不提交仅供展示的运行中过程。只有 terminal commit 和 Rust lock release 都成功后，才清除前端可观察 lock。background-running 和 completed-unread indicator 是进程内 memory state：查看对应 session 会将其清除，且永远不会写入 session file。focus/poll/normal-close 路径也会 flush 已完成的 run。进程 crash 会保留最近接受的 user message 和已经 checkpoint 的完整步骤，但不会写入未完成的流式 fragment 或 Subagent 详细过程。

其他 Workspace 进程每三秒 poll metadata（窗口隐藏且 AI panel 关闭时暂停），在 focus 或 Agent 配置变化时 refresh，并且绝不覆盖本地正在运行的 session。fingerprint 变化会在复用前驱逐 inactive cached runtime；发现会话已被外部删除时，还会清理该进程中对应的 Shell 和文件工具 owner 状态。稳定主窗口把 active session ID 存储在按环境隔离的 Workspace 文件中，只恢复仍然存在的明确记录；没有记录、记录失效或活动会话被其他窗口删除时进入未持久化 draft。临时 Workspace 窗口始终从 draft 开始，但仍可在会话列表中主动选择历史记录。

## Channel 会话

`src/modules/channels/agentSession.ts` 复用现有 Chat、transport 与终态 Bridge。每个连接绑定固定 session，目录为 Local 的 `~/.terax/workspace`，Agent 为主 Agent，模型跟随全局默认模型并在本轮内固定，权限固定为完全访问。它不会修改活动聊天、桌面模型或权限选择。

会话 metadata 与轻量摘要中的 `channelId` 表示不可变来源。Composer 沿用跨环境输入禁用机制，人工不能续写 Channel 会话；入口本身通过匹配的连接身份取得运行锁。来源、历史与会话一起持久化，重启或从历史列表打开仍保持相同行为。连接仍绑定时，普通删除命令拒绝删除其会话。

Channel 在运行锁释放后提取最后一步的 Assistant 可见文本，不投递 reasoning、工具或内部事件。详细职责、恢复限制和设置窗口通信见 [Channels](channels.md)。

## Composer

`AiComposerProvider`（`src/modules/ai/lib/composer.tsx`）是 React context，为 docked input bar 和其他 surface 保存共享输入状态（文本、附件、语音）。附件可以是图片、文本文件或来自终端/编辑器的 `selection` chip。提交时，selection 会包装为 `<selection source="terminal|editor">…</selection>` block，而不会粘贴进 textarea。

composer 根据 active session 在 `agentMetaBySession` 中的 entry 派生 `isBusy`，因此它可以在 session hydrate 前安全挂载，同时其他 session 继续在后台运行。

draft 会显示并优先跟随当前 Explorer root。没有 Explorer root 时，AI 面板仅在可见后延迟准备环境默认目录：Local 与 WSL 使用各自的 `~/.terax/workspace`，SSH 使用连接时验证的 profile Workspace root。SSH profile root 只提供默认位置，用户明确打开的任意可访问远端目录都可以成为 Explorer root。draft 可以选择 Agent；第一条被接受的 user message 会将 draft 提升为 persisted session，并同时冻结实际目录和 Agent 快照。persisted session 始终显示已保存的 Agent，不能中途切换。文件和 selection 仅在明确附加时作为可见 user-message content 发送。

每次模型 request 都先在 session run lock 下 commit 新 user message 和当前 Chat runtime system prompt 的准确内容。approval continuation 复用同一 prompt，且不会重复 user record。Subagent 内部事件恢复模型循环前，以相同 turn ID 追加完整步骤和原始 event record；运行时的 `pendingTurns` 在原子提交成功后推进 part 游标，终态 bridge 使用该游标选择剩余记录。序列化函数完整转换传入内容，不根据内部事件标记推断已保存前缀。streaming fragment 永远不会写入。

## 工具与审批

工具定义位于 `src/modules/ai/tools/`：

- 只读工具是 `read_file`、`find_files`、`grep`。全文写入使用 `write_file`，已有文件精确编辑使用 `apply_patch`，移动、复制、删除和空目录创建使用 `file_operation`。
- 六个模型文件工具全部进入 `src-tauri/src/modules/fs/agent.rs`。该后端将聊天 owner 绑定到固定 cwd，在 Rust 中统一执行权限模式、路径解析、普通文件、分页、读取版本、修改快照和 Local、WSL、SSH 路由。请求批准模式下，cwd 内非敏感操作自动执行，cwd 外、敏感路径和递归删除请求一次性批准；完全访问模式只用 cwd 解析相对路径，允许自动访问系统用户可访问的绝对路径。
- `find_files` 同时覆盖直接目录列举和递归 glob。`grep` 复用 `fs_content_search` 匹配引擎，支持目录和显式单文件目标，并在 Agent 后端完成安全过滤、content/files/count 聚合、上下文和分页。
- 文件工具和 `shell_exec` 使用基于输入的动态 `needsApproval`。审批只提升原 tool call，不改变会话 cwd 或后续调用。`shell_process` 只有 `write` action 需要批准，poll、EOF、terminate 与 `shell_list` 自动执行。AI SDK 暂停后，无论当前显示哪个 chat，UI 都会为每个 request 渲染一个持久 approval toast。
- 用户拒绝时工具不执行，并以 `output-denied` 和稳定原因结束。该拒绝作为 `status=denied` 的 tool record 持久化并返回模型，区别于批准后发生的 `output-error`；模型不得通过其他工具或等价命令绕过拒绝。
- Shell 工具只有 `shell_exec`、`shell_process`、`shell_list`。请求批准模式自动运行可明确判断为 cwd 内的普通开发命令，外部路径、网络和无法可靠分类的命令请求批准；该静态分类不是进程沙箱。完全访问跳过分类并允许任意可访问 cwd。短命令和长任务共享按聊天 owner 隔离的原生进程表，stdin、EOF、增量 offset、固定文本等待、hard timeout 和完整进程树终止不通过前端模拟。
- `write_file` 的 rewrite 模式和 `apply_patch` 强制执行 read-before-edit：模型必须在本 session 中提前读取相同版本。create 模式要求目标缺失并自动创建父目录。精确补丁按读取结果使用 LF 匹配，同时保留既有 CRLF 文件的换行风格。

审批后的自动发送使用 `lastAssistantMessageIsCompleteWithApprovalResponses`。

## 编辑 diff

需要审批的文件修改由 Rust 准备不可变的逐文件 before/after snapshot 和原始文件版本，并显示 summary toast。用户可以为一个多文件调用打开多个只读 `ai-diff` tab，并从任一 surface 批准或拒绝整个 tool call。批准后后端重新验证 canonical path 和全部文件版本，再逐文件条件写入。cwd 内自动修改也经过相同 prepared mutation 和条件提交，只省略 UI 暂停。每个文件独立原子发布，多文件调用不承诺跨文件系统原子性，运行中失败会尽力回滚已发布文件。

## 实时上下文桥接

`App.tsx` 发布当前 Explorer root 和 AI 面板可见性，`useAiLiveBridge` 在需要时准备默认目录并单独发布 `draftCwd`，不伪造 Explorer 状态。draft 发送后，session 存储的 `cwd` 成为相对 tool path 的唯一基准。终端输出保持 live，仅在模型明确调用终端工具时读取。

## 不变量

- 保持 Vercel AI SDK v6 chat 结构（`streamText`、tool、step limit），其余 UI 依赖该结构。
- key 只能通过 `secrets_*` command 访问，绝不能写入磁盘、settings store 或 `localStorage`。
- 新 provider 必须说明 bundle cost 和独特价值的合理性。
- system prompt 在一个 Chat runtime 内逐字稳定。它只在首次发送时读取 `AGENTS.md`；Chat 被 LRU 淘汰、外部刷新替换或应用重启后，再次发送会从当前文件和设置重新构造。
- 磁盘 metadata 中的 `systemPrompt` 是只写的检查快照，运行时不得读取或复用，也不增加 prompt version、revision 或迁移状态。
- 会话 Agent ID、专属指令和工具白名单来自首次发送时保存的 `metadata.agent` 快照；Agent 不能在 persisted session 中更换。
- Custom Agent 删除必须经过 `ai_agent_delete` 级联删除其全部会话；主 Agent 不进入共享存储且不可删除。
- 请求批准模式下 cwd 内非敏感操作自动执行，越界、敏感、网络、递归删除和无法可靠分类的 Shell 操作需要批准；完全访问模式免除这些审批和路径上界。两种模式继续执行文件类型、大小、版本、进程隔离与灾难性操作保护。
- 内存 message list、持久化 message record 和模型 input 保留相同的 message content。cwd 和 execution environment 只进入 system prompt，不得注入 user message；active tab 不自动注入任何消息。
- persisted session 的 `cwd` 不可变，每个相对 tool path 都基于它解析。
- `shell_exec` 未显式传 cwd 时延续该聊天最近同步完成的 Shell cwd；已经返回为长任务的进程不得在稍后退出时异步改变聊天 cwd。
- 获取 persisted session run 时，从经过验证的 JSONL header 恢复已保存 cwd 的授权，但不改变 Explorer root。
- session run lock 持有其内存 runtime，直到 commit 和 release 均成功；session navigation 不得绕过该生命周期。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和 command 目录
- [安全模型](security-model.md) - 每个工具都必须遵守的边界
