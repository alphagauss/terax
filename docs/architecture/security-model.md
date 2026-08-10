# 安全模型

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

Terax 会运行 Shell、读写文件并向 AI provider 发送数据。其安全模型采用 defense-in-depth：单一防护不足以保证安全，因此每个边界都要在执行操作前验证输入。

## 边界

主要信任边界包括：

1. **IPC 边界** - 注册在 `src-tauri/src/lib.rs` 中并受 `src-tauri/capabilities/default.json` 限制的 command。
2. **文件系统边界** - AI 工具通过 `src/modules/ai/lib/security.ts`；PTY spawn 通过 Workspace 授权 registry。
3. **网络边界** - `src-tauri/src/modules/net.rs` 中带有 SSRF 和 DNS rebinding 防护的 AI HTTP proxy。
4. **秘密存储边界** - key 存储在操作系统 keychain 中，绝不存入磁盘或 `localStorage`。
5. **终端 escape sequence 边界** - 解析 OSC sequence 并执行对应操作，但绝不直接信任它来改变状态。

## 秘密路径 deny-list

`src/modules/ai/lib/security.ts` 会拒绝读取和写入明显包含秘密的路径。该规则**同时适用于读取和写入**，绝不能绕过。

阻止的类别包括：

- 文件：`.env*`、`*.pem`、`*.key`、`*.p12`、`id_rsa*`、`known_hosts`、`credentials`、`service-account*.json` 等。
- 目录：`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.config/gh`、`~/.git`、系统目录（`/etc`、`/proc`、`/sys`）和 Windows credential store。
- 系统写入 prefix：`/etc/`、`/var/db/`、`/usr/bin/`、`/windows/`、`/program files/` 等。

路径比较前会进行规范化：将反斜杠转换为正斜杠、移除 Windows drive letter、移除 NTFS alternate data stream、移除末尾点号/空格、转换为小写并合并重复斜杠。受保护目录按完整路径或其 descendant 匹配，而不是使用原始 substring 匹配。

`checkReadableCanonical` 和 `checkWritableCanonical` 还会 canonicalize 路径并重新检查解析后的形式，因此可以发现无害路径中的 symlink 指向 `~/.ssh` 的情况。

## Workspace 授权 registry

`WorkspaceRegistry`（`src-tauri/src/modules/workspace.rs:20`）跟踪允许 PTY spawn、Git command 和 AI 工具操作的目录。

- `workspace_authorize` 添加目录。
- `authorize_spawn_cwd` 拒绝在已授权 root 之外使用 spawn cwd。
- `authorize_user_spawn_cwd` 将用户选择的 cwd 注册为新 root，而不是拒绝它。
- registry 在 bootstrap 时加入启动目录和用户 home 目录（`workspace.rs:135`）。

这是文件系统边界的 allow side。任何需要在当前 Workspace 之外启动 Shell 或修改文件的新功能都必须与此 registry 交互。

## AI 工具审批流程

在 `src/modules/ai/tools/tools.ts` 中：

- 只读工具（`read_file`、`list_directory`、`grep`、`glob`）通过 deny-list 后自动执行。
- 修改型工具（`write_file`、`edit`、`multi_edit`、`create_directory`、`run_command`、`shell_session_run`、`shell_bg_spawn`）设置 `needsApproval: true`。AI SDK 会暂停，前端将每个请求路由到以 session 和 approval ID 为 key 的持久 toast。
- 文件修改在审批前准备待 review 的内容，并在写入前重新验证 canonical path、原始内容和文件存在状态。diff 不依赖 Git。
- `edit` / `multi_edit` 强制执行 read-before-edit 不变量：模型必须在本 session 中提前读取过该文件。

审批后的自动发送使用 `lastAssistantMessageIsCompleteWithApprovalResponses`。

## SSRF 与 DNS rebinding 防护

`src-tauri/src/modules/net.rs` 代理 AI provider 请求和本地模型 ping。连接前会：

1. 解析一次 hostname（`resolve_and_classify`）。
2. 将解析得到的每个 IP 分类为 public、private、loopback 或 blocked metadata。
3. 阻止云 metadata endpoint（`169.254.169.254`、`metadata.google.internal`、AWS IPv6 metadata 等）。
4. 将 reqwest 固定到解析得到的 IP，防止第二次 DNS 查询返回不同地址（DNS rebinding）。

本地 LLM endpoint 会被明确允许，因为用户通过将 Terax 指向这些 endpoint 主动选择了它们，但系统仍会对其分类并记录日志。

## 秘密存储

API key 通过 `secrets_*` command（`src-tauri/src/modules/secrets.rs`）存储：

- macOS：通过 `keyring` 使用 Keychain
- Windows：通过 `keyring` 使用 Credential Manager
- Linux：使用应用本地数据目录中 mode 为 `0600` 的 JSON 文件（原子写入 `.tmp` 后 rename）

服务常量为 `terax-ai`。key 绝不会写入 keychain/Linux secrets 文件以外的磁盘位置，不会进入 `localStorage`，也不会出现在日志中。

## OSC 信任限制

终端从 PTY 字节流中解析 OSC sequence：

- **OSC 7** 更新 tab cwd。
- **OSC 133 A/B/C/D** 标记 prompt/command 边界。
- **OSC 777** 由 Agent detector 用来标记编码 Agent 的状态转换。

Agent detector（`src-tauri/src/modules/pty/agent_detect.rs`）由 `OSC 133;C;<cmd>` 或 self-armed marker 启用，并发出 `terax:agent-signal` event。它**仅由 OSC sequence**驱动，绝不由原始输出驱动，因此 repaint 中的 TUI 不会造成状态反复变化。

## 不变量

- `security.ts` 中的 deny-list 同时适用于读取和写入，绝不能绕过。
- 新增涉及文件系统的 command 必须遵守 Workspace 授权 registry。
- 新增面向网络的 command 必须通过 `net.rs` proxy，或重新实现相同的分类和 DNS pinning。
- 新 plugin API 必须添加到 `src-tauri/capabilities/default.json`。
- key、token 和 credential 只能保存在 keychain / Linux secrets 文件中。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [双进程模型](two-process-model.md) - IPC 边界和 command 目录
- [AI 子系统](ai-subsystem.md) - 工具、审批流程和 provider 处理
