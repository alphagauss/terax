# 多进程多窗口 Workspace 重构实施计划

更新时间：2026-07-11
目标仓库：`D:\project\terax`
目标分支：`multi-window-process`
实现基线：`1831d074ff409d29f413b637b2b000da22b87f01`（当前 `main`）

## 1. 状态与文档定位

- 整体状态：实现已完成，综合验证进行中。
- 当前阶段：阶段 6，综合验证与文档。
- 本轮改动：已按本计划修改 Rust、TypeScript、配置、测试和架构文档。
- 本计划对应 `development_plan.md` 第一阶段“多窗口 Workspace 基础”，同时覆盖已经进入 `main` 的 Local、WSL、SSH Workspace。
- 当本计划与 `TERAX.md` 中当前单窗口架构说明冲突时，以 `development_plan.md` 和本计划确定的新方向为准；实现完成后再同步更新 `TERAX.md`。

状态只使用“未开始、进行中、已完成、阻塞”。阶段必须在对应验证完成后才能标记为“已完成”。

## 2. 已确认的结论

### 2.1 架构结论

- 多窗口采用“一原生 Workspace 窗口对应一个独立 Terax 应用进程”的多进程方案。
- 不在同一个 Tauri 进程内动态创建多个 Workspace webview window。
- 每个应用进程继续运行现有单窗口 React App，并拥有自己独立的 Rust State、WebView、PTY、LSP、Shell、文件监听、SSH Workspace、隧道和 AI 运行态。
- 新窗口由当前进程请求 Rust 启动新的 Terax 可执行进程，并通过内部命令行参数传递环境和启动策略。
- 当前窗口在打开新窗口后保持原状，不切换环境、不清理标签页、不重置 Workspace。
- 同一个 Local、WSL distro 或 SSH profile 允许同时打开多个独立窗口。

### 2.2 选择多进程的原因

当前 `multi-window` 分支的进程内实现：

- 相对当前 `main` 只有一个独有实现提交 `3632a42`，当前为落后 16 个提交、领先 1 个提交。
- 单个实现提交修改 41 个文件，约 `+1637/-247`。
- 主要复杂度来自给 PTY、LSP、Shell、Workspace 授权、AI run 和持久化状态增加窗口 owner，以及动态窗口注册、绑定、聚焦和销毁。
- 与当前 `main` 模拟合并时已有 10 个文本冲突文件，核心冲突集中在 `lib.rs`、PTY、LSP、Shell、Workspace、Git、文件监听和 Workspace switcher。
- 该实现基于 Remote SSH 合入前的代码，只验证了 Local/WSL；其 Workspace record 校验不接受 SSH，RemoteManager 也没有窗口 owner。
- 当前 RemoteManager 以 `profile_id` 作为进程内连接唯一键；若继续进程内方案，同一 SSH profile 多窗口还需要继续改造 Remote、SFTP、tunnel 和 reconnect 生命周期。

多进程方案使上述运行资源天然按进程隔离，保留现有单窗口模块边界，减少后续同步上游时的冲突面。代价是每个窗口会重复一份 Tauri/WebView 运行时，并且所有全局可写数据必须显式解决跨进程一致性。

### 2.3 AI 会话结论

- 在开放多窗口 AI 前，先把当前单一 `terax-ai-sessions.json` 改造为 `sessions/<uuid>.json`。
- AI 会话运行中的 messages、审批、tool 状态、agentMeta 和 composer 内容只存在于所属进程内存，不做 token 级跨进程同步。
- 会话从 `submitted/streaming` 进入 idle、error 或 stopped 后，原子发布最终 session snapshot。
- 其他窗口通过定时刷新和窗口重新聚焦读取已经发布的 snapshot，采用最终一致性，不参与实时运行。
- 同一个 session 同一时刻只允许一个进程运行；其他进程可读取最后一次已完成 snapshot，但不能同时继续该 session。
- 当前 `terax-ai-todos.json` 中的内容不做兼容性适配。
- `activeSessionId`、AI 面板开关、输入草稿、附件、审批状态和 live context 属于窗口状态，不属于全局 session 文件。

### 2.4 共享配置结论

- 文件监听只能解决变更通知，不能解决多个进程基于旧缓存整份覆盖 JSON 的问题。
- 所有需要跨进程共享且可写的配置必须改为“跨进程锁 + 读取磁盘最新值 + 最小粒度 mutation + 原子替换”。
- Tauri event 只用于把 Rust 进程内检测到的变化通知本进程 webview，不作为跨进程通信机制。
- 全局设置变化应实时或近实时传播；AI session 历史只要求定时最终一致。
- `tauri-plugin-store` 可继续用于每个 Workspace 独占写入的状态文件，但不再直接用于多个进程共同写入的全局文件。

## 3. 产品规则

### 3.1 Workspace、窗口与进程

- Workspace 是一个原生窗口的持久化状态身份，使用 UUID 标识。
- 一个 Workspace 同一时刻最多被一个应用进程独占。
- 一个应用进程只承载一个 Workspace 主窗口；Settings 等辅助窗口仍属于该进程，不构成独立 Workspace。
- 同一环境允许存在多个 Workspace，因此也允许存在多个独立进程和窗口。
- 每个 Workspace 独立维护：
  - Spaces、当前 Space 和 Space 内标签页。
  - 文件树、编辑器、终端、预览和 Git UI 状态。
  - 侧栏选中项、折叠状态和宽度。
  - AI active session、面板状态、输入草稿、附件和运行上下文。
  - 窗口几何状态、窗口标题和最近打开时间。
  - Local/WSL/SSH 环境绑定及该进程内的连接生命周期。
- 全局设置、Provider/模型配置、密钥、SSH profiles、自定义主题、AI agent 定义和 snippets 跨 Workspace 共享。

### 3.2 新窗口入口

只保留以下入口，不增加 Launcher 或 Workspace Picker：

1. Command Palette 第一项 `New Window`。
2. Windows/Linux `Ctrl+Shift+N`，macOS `Cmd+Shift+N`。
3. 左下角环境选择器。

行为规则：

- `New Window` 使用当前环境创建全新的默认 Workspace，并启动新进程。
- 再次选择当前环境与 `New Window` 等价，创建全新的默认 Workspace。
- 选择不同环境时，当前窗口保持不变；新进程优先恢复目标环境最近且未被占用的 Workspace，没有可恢复状态时创建默认 Workspace。
- 不跨进程查找并聚焦已有窗口；目标环境最近 Workspace 正在被其他进程占用时直接创建新的 Workspace。
- 不复制当前窗口的标签页、Spaces、侧栏、AI 草稿或连接状态。
- `Ctrl/Cmd+T` 和现有“+”菜单继续只创建当前窗口内的新标签页，不改变语义。

### 3.3 冷启动与显式目录启动

- 无内部 Workspace 参数的普通冷启动，优先恢复 Local 环境最近的 Workspace。
- 如果最近 Local Workspace 已被其他进程锁定，创建新的 Local Workspace，不回退并复活更旧的 Workspace。
- 没有 Local 记录时创建新的默认 Local Workspace。
- 用户通过命令行显式传入目录时，目录优先：创建新的 Local Workspace，并以该目录作为初始目录，不恢复最近状态。
- 内部多窗口参数与用户目录参数使用严格解析，不能继续依赖“忽略所有 `-` 开头参数后把第一个可 canonicalize 的值当目录”的宽松逻辑。
- 内部参数不得携带密码、私钥或任何 secret，只传 Workspace UUID、环境 scope、启动策略和可选目录。

### 3.4 状态保留与清理

- Workspace 状态文件关闭后保留，以支持后续恢复。
- 第一版不自动删除旧 Workspace 文件，不实现历史管理 UI，也不在任意进程启动时 prune 其他 Workspace。
- 原因是多进程下无法仅凭文件时间判断某个状态是否仍由其他活跃进程使用；错误清理比少量小文件累积风险更高。
- 每个 Workspace 通过进程持有的 OS 文件锁表示占用；进程正常退出或崩溃后锁由操作系统释放，不使用仅靠创建/删除 `.lock` 文件的脆弱协议。
- 后续如需清理，只能删除超过明确保留期限且能够成功取得独占锁的状态文件；不属于本轮范围。

### 3.5 窗口关闭与进程退出

- 关闭 Workspace 主窗口即退出其所属应用进程。
- Settings 辅助窗口随所属 Workspace 主窗口关闭。
- 进程退出只清理本进程的 PTY、LSP、Shell、SSH、SFTP、tunnel、watcher 和 AI runtime，不影响其他窗口。
- Windows 继续依赖已有 Job Object 关闭 PTY/LSP 子进程树；Unix/macOS 保留已有显式清理和 Drop 语义。
- 不增加跨进程 owner registry，也不在 PTY、LSP、Shell、Remote command 参数中增加 window label。

## 4. 范围与非目标

### 4.1 本轮必须完成

- AI session 单文件存储、旧数据迁移、单 session 写锁、最终 snapshot 发布和其他窗口定时刷新。
- Workspace UUID、启动 bootstrap、进程启动和状态文件独占锁。
- Local、WSL、SSH 环境的新进程启动与恢复。
- Spaces、标签页、侧栏、AI 活动状态和窗口几何的 Workspace 级隔离。
- 全局可写配置的跨进程安全 mutation 和变更通知。
- 同一 SSH profile 在两个进程中拥有独立连接、终端、SFTP、tunnel 和 reconnect 生命周期。
- New Window UI、快捷键、环境选择行为、自动化测试和三平台手工矩阵。

### 4.2 明确不做

- 进程内多个 Workspace webview window。
- Workspace Launcher、Picker、最近 Workspace 管理页和手工删除历史 UI。
- 跨进程窗口枚举、聚焦、置顶或进程间 RPC broker。
- 跨窗口实时显示 AI token、审批卡、tool 运行过程或 composer 草稿。
- 多人协作式同时编辑同一个 AI session。
- 运行中 AI draft 崩溃恢复；进程崩溃时允许丢失本轮尚未发布的增量，但必须保留上一次完整 snapshot。
- 自动清理旧 Workspace/session backup。
- 为多窗口重构无关的 PTY、SSH、编辑器、AI 功能重写。

## 5. 总体架构

```text
Workspace Window A                    Workspace Window B
┌──────────────────────────┐          ┌──────────────────────────┐
│ Terax process A          │          │ Terax process B          │
│ React + Tauri            │          │ React + Tauri            │
│ PTY/LSP/Shell/SSH A      │          │ PTY/LSP/Shell/SSH B      │
│ workspace.<uuid-a>.json │          │ workspace.<uuid-b>.json │
└────────────┬─────────────┘          └────────────┬─────────────┘
             │                                     │
             ├──── locked/atomic global config ────┤
             │                                     │
             └──── sessions/<session-uuid>.json ───┘
                       completed snapshots
```

关键边界：

- 运行资源按进程隔离。
- Workspace UI 状态按 Workspace UUID 文件隔离。
- 全局配置按文件锁安全共享。
- AI 完成历史按 session UUID 文件共享。
- Tauri event、Zustand store 和模块级 Map 都只在本进程内有效。

## 6. 启动协议与进程创建

### 6.1 内部启动参数

计划使用严格的内部参数：

```text
--terax-workspace-env <local|wsl:<distro>|ssh:<profile-id>>
--terax-workspace-policy <fresh|recent>
--terax-workspace-id <uuid>          # 仅恢复已选择状态时使用
--terax-launch-dir <absolute-path>   # 可选，仅 Local
```

约束：

- `fresh` 必须生成新 UUID，不读取已有 Workspace 状态。
- `recent` 选择指定环境最新状态；若该状态锁定或无效则生成新 UUID。
- 显式 `workspace-id` 必须验证为 UUID，读取状态后还要验证文件内 id 和 env 与参数一致。
- `wsl:` 后必须是通过现有 WSL distro 安全校验的名称。
- `ssh:` 后只传 profile id；凭据继续从全局安全存储读取。
- 内部参数解析失败必须给出明确启动错误，不得静默回落到 Local。
- 用户提供的普通目录参数与内部参数分开处理，避免参数值被误识别为目录。

### 6.2 Rust 模块职责

新增一个边界明确的小模块，暂定 `src-tauri/src/modules/workspace_process.rs`：

- 解析并验证启动参数。
- 选择或创建 Workspace UUID。
- 在 AppData 中扫描 Workspace metadata。
- 获取并在进程生命周期内持有 Workspace 独占文件锁。
- 向前端暴露一次性 `get_workspace_bootstrap`。
- 提供 `spawn_workspace_process(env, policy, launch_dir)` command。
- 为当前进程选择独立 window-state 文件名。

不在该模块中管理 PTY、LSP、Shell、Remote 或 AI runtime；这些资源继续由现有模块管理，并因进程边界自然隔离。

### 6.3 三平台进程启动

- Windows：优先直接启动 `std::env::current_exe()`，使用参数数组，不经过 `cmd.exe` 或 PowerShell。
- macOS：验证直接启动 `.app/Contents/MacOS/Terax` 是否产生独立 GUI 实例和正确激活；若系统行为不稳定，使用 `open -n <bundle> --args ...` 的平台分支。
- Linux 开发/普通安装：使用 `current_exe()`。
- Linux AppImage：存在 `APPIMAGE` 时优先启动原始 AppImage 路径，避免依赖当前临时 mount 中的内部可执行文件。
- 子进程不得继承任何用于 agent hook 的 `__terax_notify` 特殊模式。
- 父进程关闭后子进程必须继续运行；子进程不得被加入父 Workspace 的 PTY Job Object。

每个平台都需要真实打包产物测试，不能只用 `cargo tauri dev` 作为结论。

## 7. Workspace 持久化设计

### 7.1 文件与锁

```text
AppData/
  terax-workspace.<workspace-uuid>.json
  terax-workspace.<workspace-uuid>.lock
```

- JSON 文件只由持有对应 OS 独占锁的进程写入。
- `.lock` 是锁载体，不以文件是否存在判断占用；崩溃遗留空文件不影响后续重新加锁。
- 锁实现必须跨 Windows、macOS、Linux，并有同进程/跨进程竞争测试。
- Workspace 状态继续可以使用 `tauri-plugin-store`，因为每个文件只有一个写进程；必须关闭该文件的跨窗口共享假设。

### 7.2 Workspace metadata

每个 Workspace 文件至少包含：

```ts
type WorkspaceMetadata = {
  schemaVersion: 1;
  id: string;
  env:
    | { kind: "local" }
    | { kind: "wsl"; distro: string }
    | { kind: "ssh"; profileId: string };
  createdAt: number;
  lastOpenedAt: number;
};
```

其余 key 包含：

- `spaces`
- `activeSpaceId`
- `spaceState:<space-id>`
- `sidebar:view`
- `sidebar:collapsed`
- `sidebar:width`
- `ai:activeSessionId`
- `ai:activeAgentId`
- 后续明确属于窗口的持久化 UI 状态

AI composer 草稿、附件、审批和运行态第一版只在内存中，不写 Workspace 文件。

### 7.3 不建立共享 Workspace index

- 不使用旧分支的 `terax-workspaces.json` 全局索引，避免新的跨进程共享写热点。
- 最近 Workspace 通过扫描 `terax-workspace.*.json` 的 metadata 得到。
- 扫描时忽略文件名非法、JSON 损坏、schema 不支持或 metadata 与文件名不一致的文件，并记录 warning。
- 排序规则为 `lastOpenedAt`、`createdAt`、UUID，保证确定性。
- 最近状态锁定时创建新状态，不打开第二近的旧状态。

### 7.4 窗口几何

当前 `tauri-plugin-window-state` 在进程退出时整份写默认 window-state JSON，多进程不能共享该文件。

实现时在构建插件前根据 Workspace UUID设置：

```text
terax-window-state.<workspace-uuid>.json
```

- 每个进程只写自己的 window-state 文件。
- 主窗口仍可使用标签 `main`，因为文件已经按 Workspace 隔离。
- Settings window 状态随所属 Workspace 保存在同一文件，不跨进程共享。
- 继续排除 `VISIBLE` 恢复，由前端首帧后显示窗口。

## 8. 全局配置的跨进程设计

### 8.1 数据分类

全局共享且可写：

- `terax-settings.json`
- `terax-ssh-profiles.json`
- `terax-custom-themes.json`
- `terax-ai-agents.json` 中的 agent 定义
- `terax-ai-snippets.json`
- Windows Credential Manager/macOS Keychain 中的密钥及其变更通知
- Linux `secrets.json` fallback

不再作为全局共享文件：

- `terax-spaces.json`，迁入 Workspace 文件。
- `terax-ai-sessions.json`，迁入 sessions 目录。
- `terax-ai-todos.json`，迁入对应 session snapshot。
- AI `activeSessionId` 和 `activeAgentId`，迁入 Workspace 文件。

### 8.2 安全写入层

新增 Rust 共享 JSON 存储边界，暂定 `src-tauri/src/modules/shared_store.rs`：

- 只接受固定 allowlist 中的 store 名称，禁止前端传任意路径。
- 每个 store 使用独立 OS 锁文件。
- mutation 在锁内完成：读取磁盘最新 map、验证 schema、修改最小 key、写临时文件、flush/fsync、原子替换。
- JSON 损坏时不得用空 map 覆盖原文件；返回错误并保留原文件供恢复。
- 读取可缓存，但任何外部文件变化必须使缓存失效；写入不能基于未验证的旧缓存。
- 全局设置已经是每设置项一个 key，可直接使用 `set_key`。
- entity 集合不能继续以一个旧数组整体覆盖：
  - SSH profile 改为 `profile:<id>` 记录。
  - 自定义主题改为 `theme:<id>` 记录。
  - 自定义 agent 改为 `agent:<id>` 记录。
  - snippet 改为 `snippet:<id>` 记录。
- 集合迁移必须幂等，全部成功后才停止写旧数组 key。
- `tauri-plugin-store` 不再直接写这些全局文件。

### 8.3 变更传播

- Rust 使用独立 AppData 配置 watcher 监听 allowlist 文件，不复用受 Workspace 授权约束的项目文件 watcher API。
- 变更 debounce 150–300ms，向本进程 emit `terax://shared-store-changed`，payload 只包含 store 名称和 revision/fingerprint，不包含 secret。
- 前端收到事件后重新读取对应小型配置，并更新本进程 Zustand/React state。
- 当前进程自己的写入也走相同刷新路径，避免本地和外部更新使用两套状态逻辑。
- 窗口重新获得焦点时执行一次轻量 revision 检查，补偿丢失的文件系统事件。
- AI sessions 不使用该 watcher，按第 9 节轮询。

### 8.4 密钥

- Windows/macOS 继续使用系统 keychain，不把 key 写入共享 JSON。
- 密钥新增/删除成功后更新一个不含 secret 的共享 epoch 文件，由其他进程收到变化后重新批量读取 keychain。
- Linux fallback 当前使用进程内缓存；必须改为写操作锁内重新读取最新 `secrets.json` 后 mutation，并保持 `0600`、临时文件、fsync 和原子替换。
- 不在任何 event、日志、CLI 参数或 Workspace/session 文件中携带 secret 值。

## 9. AI sessions 单文件设计

### 9.1 目录与 schema

```text
AppData/
  sessions/
    <session-uuid>.json
    <session-uuid>.lock
    .migration-v1-complete
```

每个已发布文件：

```ts
type SessionSnapshot = {
  schemaVersion: 1;
  id: string;             // 必须等于文件名 UUID
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
  todos: Todo[];
};
```

- 新 session id 使用 `crypto.randomUUID()` 或 Rust UUID，文件名只接受规范 UUID。
- 不创建 `sessions/index.json`；session 文件自身是权威记录。
- 空的 `New chat` 只存在于当前窗口内存，第一次完成有效对话后才发布文件。
- title 在发布时根据最终 messages 派生；手工 rename 也是对单 session 文件的原子 mutation。
- 删除只删除对应 UUID 文件，并且必须先成功取得 session 独占锁。

### 9.2 Rust session 文件 API

新增或放入 AI 模块的 Rust 命令边界：

- `ai_sessions_list`：返回 metadata、mtime、size/fingerprint，不返回所有 messages。
- `ai_session_read(id)`：读取并验证一个完整 snapshot。
- `ai_session_publish(snapshot)`：锁内写临时文件并原子替换。
- `ai_session_delete(id)`：锁内删除。
- `ai_session_run_acquire(id)`：为当前进程持有运行锁。
- `ai_session_run_release(id)`：发布或取消后释放运行锁。
- `ai_sessions_migrate_legacy`：执行一次幂等迁移。

所有命令都固定在 `sessions` 目录内，UUID 必须严格校验，不能接受路径片段。

### 9.3 运行时与发布时机

- `Chat<UIMessage>`、流式 messages、tool approvals、agentMeta 和 pending todos 在运行中只保存在当前进程内存。
- 删除当前每 token 触发的 300ms `saveMessages` 持久化路径。
- 在以下情况发布完整 snapshot：
  - `submitted/streaming` 正常转为 idle。
  - 用户 stop 后 Chat 状态稳定。
  - error 后保留可显示的最终 messages。
  - session switch/unmount 前存在已结束但尚未发布的 snapshot。
  - 应用正常退出前存在已结束但尚未发布的 snapshot。
- 运行中进程崩溃时不发布半成品；保留旧 snapshot，允许丢失本轮未完成增量。
- 发布成功后更新本进程 session metadata，并释放 session run lock。
- 发布失败时保留内存内容并显示明确错误，不把会话标记为已同步。

### 9.4 同 session 并发规则

- 只查看 snapshot 不持有 run lock。
- 用户准备发送新消息或继续既有 session 时取得 run lock。
- lock 已被其他进程持有时，当前窗口将 session 置为只读，并提示“该会话正在另一个窗口运行”。
- 不允许通过新建不同 Chat runtime 绕过该锁。
- rename/delete 遇到运行锁时失败，不等待无限时间。
- 新 UUID session 不存在冲突，但第一次发送前仍建立对应锁，统一生命周期。

### 9.5 其他窗口刷新

- AI session 列表默认每 3 秒刷新一次；窗口不可见且 AI 面板未打开时暂停轮询。
- 窗口重新获得焦点或打开 AI 面板时立即刷新。
- 列表比较 UUID、mtime 和 size/fingerprint，只重新读取发生变化的 metadata。
- 完整 messages 仅在用户打开对应 session 时读取。
- 当前窗口正在运行的 session 不被轮询结果覆盖；运行结束发布后再合并磁盘状态。
- 外部删除当前只读 session 时关闭对应缓存并选择下一个 session；外部更新当前只读 session 时重新加载。

## 10. 旧 AI 数据迁移

### 10.1 迁移来源

- `terax-ai-sessions.json`
  - `sessions` 元数据数组。
  - `activeId`，不迁入全局 session 文件。
  - `messages:<legacy-id>`。
- `terax-ai-todos.json`
  - `todos:<legacy-id>`。

### 10.2 迁移规则

- 迁移前取得全局 migration lock，避免多个进程同时迁移。
- 如果 `.migration-v1-complete` 存在，只使用新目录，不重复迁移。
- 每个 legacy session 生成新的 UUID；保留 title、createdAt、updatedAt、messages 和对应 todos。
- legacy `activeId` 不作为全局状态迁移；单窗口迁移后的首次启动选择最近 session，Workspace 状态建立后再保存每窗口 active id。
- 对每条记录独立校验；缺失 messages 视为空数组，损坏的结构必须报错，不能静默丢弃整个历史。
- 所有 session 文件均成功原子写入后才创建 migration marker。
- marker 创建成功后将旧文件重命名为只读备份：
  - `terax-ai-sessions.v0.backup.json`
  - `terax-ai-todos.v0.backup.json`
- 第一版不自动删除备份。
- 迁移失败时不创建 marker，不重命名旧文件；下次启动可幂等重试，已经生成的 UUID 文件按本次迁移映射覆盖或清理，不能产生重复会话。

### 10.3 迁移验证

- session 数量一致。
- 每条 title、createdAt、updatedAt、messages 和 todos 一致。
- 新文件名与内部 id 一致且为 UUID。
- 迁移后新代码不再加载或写 legacy 文件。
- 抽样包含 text、reasoning、tool、approval、attachment 的消息可完整恢复。

## 11. `multi-window` 分支代码复用策略

不整体 merge、rebase 或 cherry-pick `3632a42`。只在当前 `main` 上手工移植仍符合多进程方案的最小代码和测试。

### 11.1 可复用的概念或局部代码

| 旧分支位置 | 复用内容 | 调整要求 |
| --- | --- | --- |
| `src/modules/workspace-window/model.ts` | UUID、状态文件名校验、环境比较、最近记录排序 | 改为扫描独立 Workspace metadata；加入 SSH；删除 compact/prune 逻辑 |
| `src/modules/workspace-window/model.test.ts` | 安全 ID、排序和环境选择测试思路 | 改为 UUID、锁定最近状态时创建新 Workspace 的规则 |
| `src/modules/workspace-window/types.ts` | WorkspaceRecord/Context 类型思路 | 改名为 process/bootstrap 语义并加入 SSH |
| `src/modules/spaces/lib/store.ts` | 根据 Workspace context 选择状态 store | 保留当前 `main` 的 SSH env 和 Spaces 行为，不直接套用旧文件 |
| `src/modules/sidebar/useSidebarPanel.ts` | 把侧栏状态从共享 localStorage 移到 Workspace store | 重新基于当前文件做最小修改 |
| `src/modules/ai/lib/sessions.ts` | activeSessionId 属于 Workspace 的结论 | message/session persistence 完全改用 sessions 目录，不复用旧事件同步实现 |
| `src/modules/command-palette/*` | `New Window` command、排序和测试 | handler 改为启动进程，不调用 Tauri window open |
| `src/modules/shortcuts/shortcuts.ts` | `window.new` 快捷键注册 | 保留当前 main 的快捷键变更后手工加入 |
| `src/app/App.tsx` | `openNewWindow` UI wiring 思路 | 只移植入口，不移植旧 Workspace reset/owner 逻辑 |
| `src/main.tsx`、`src/lib/launchDir.ts` | React render 前完成 bootstrap 的思路 | 使用进程启动参数和 Rust-held Workspace lock |

### 11.2 明确不复用

- `src-tauri/src/modules/workspace_window.rs` 的进程内窗口注册表、动态 WebviewWindowBuilder、window label 和销毁回调。
- PTY、LSP、Shell、fs watch、Git、WorkspaceRegistry 中的 window owner 参数和 owner cleanup。
- `WorkspaceWindowState` 的 `by_window`、`by_workspace` 和进程内 AI run owner map。
- 通过 Tauri event 同步 AI sessions 的实现；事件不能跨应用进程。
- `terax-workspaces.json` 全局索引和冷启动按环境强制 prune。
- 已打开 Workspace 时聚焦已有 Tauri window 的规则。
- 旧分支只接受 Local/WSL 的 record 校验。
- 为进程内动态窗口增加的 capability 权限，除非新进程启动 API 确实需要独立权限。

## 12. 预计文件边界

以下是计划边界，不要求文件名机械一致；实现时每个新增文件都必须有单一职责。

### 12.1 Rust

- `src-tauri/src/modules/ai_sessions.rs` 或 `modules/ai/sessions.rs`
  - session list/read/publish/delete/lock/migration。
- `src-tauri/src/modules/shared_store.rs`
  - allowlist、跨进程锁、原子 JSON mutation、revision 和 watcher。
- `src-tauri/src/modules/workspace_process.rs`
  - CLI/bootstrap、Workspace scan/lock、spawn child process。
- `src-tauri/src/lib.rs`
  - 注册上述 state/commands；按 Workspace UUID配置 window-state filename。
- `src-tauri/src/modules/secrets.rs`
  - Linux fallback 跨进程安全 mutation 和缓存失效。
- `src-tauri/Cargo.toml`
  - 仅添加必要的小型 UUID/跨平台文件锁依赖；不引入数据库或 IPC 框架。

### 12.2 Frontend

- `src/modules/ai/lib/sessions.ts`
  - 改为调用单 session Rust API。
- `src/modules/ai/store/chatStore.ts`
  - 内存运行、完成发布、metadata refresh、session lock 状态。
- `src/modules/ai/components/AgentRunBridge.tsx`
  - 删除 per-token 落盘，按状态转换触发发布。
- `src/modules/ai/lib/todos.ts`、`store/todoStore.ts`
  - todos 进入 session snapshot，不再写独立全局 JSON。
- `src/modules/workspace-process/`
  - bootstrap types、context、API 和纯模型测试。
- `src/main.tsx`、`src/lib/launchDir.ts`
  - render 前初始化当前 Workspace。
- `src/modules/spaces/lib/store.ts`、`useSpacesBoot.ts`
  - 使用当前 Workspace 独立 store。
- `src/modules/sidebar/useSidebarPanel.ts`
  - Workspace 级持久化。
- `src/modules/settings/store.ts`、`src/modules/remote/store.ts`、自定义主题/agent/snippet store
  - 改走 shared store API 和变更订阅。
- `src/app/App.tsx`、Command Palette、shortcuts、StatusBar
  - 新窗口入口和环境选择。

### 12.3 文档与测试

- 更新 `TERAX.md` 的单窗口说明为“一进程一 Workspace 窗口，多进程多窗口”。
- 更新 Tauri capabilities，只增加实际需要的 command/plugin 权限。
- 新增 Rust 单元/集成测试、前端模型和 store 测试。
- 不修改与本计划无关的第三方来源说明；只有实际引入新依赖时才更新 `THIRD_PARTY_NOTICES.md`。

## 13. 分阶段实施

### 阶段 0：建立分支和计划

- 状态：已完成
- [x] 从 `main@1831d07` 创建 `multi-window-process`。
- [x] 对比 `main` 与 `multi-window` 的提交、冲突和改动面。
- [x] 确认采用一窗口一进程。
- [x] 确认先完成 AI session 单文件迁移，再开放多窗口 AI。
- [x] 确认共享配置采用安全写入和监听，不依赖 Tauri event 跨进程。
- [x] 完成本计划，不修改实现代码。

验证：`git diff` 只包含 `plan.md`；分支基线正确。

### 阶段 1：AI sessions 单文件存储

- 状态：进行中
- [x] 定义 Rust `SessionSnapshot` 和严格 UUID/path 校验。
- [x] 实现 list/read/publish/delete 和临时文件原子替换。
- [x] 实现 session run lock。
- [x] 把 todos 纳入 snapshot。
- [x] 实现 legacy sessions/todos 幂等迁移与备份。
- [x] 前端改为按需加载单 session。
- [x] 删除运行中 300ms 整体 JSON 持久化。
- [x] 完成后发布 snapshot，失败保留内存并提示。
- [x] 增加 3 秒 metadata 轮询和 focus refresh。
- [x] 删除对旧 session/todo store 的生产写入依赖。

验证：仍在单窗口模式下完成全部 AI 会话回归；迁移前后历史一致；模拟 publish 中断不损坏旧 snapshot。

### 阶段 2：全局共享配置安全化

- 状态：已完成
- [x] 实现 allowlist shared store、跨进程锁和原子 mutation。
- [x] 迁移 settings 为 shared key store。
- [x] 迁移 SSH profiles 为 per-record key。
- [x] 迁移 custom themes、agents、snippets 为 per-record key。
- [x] 拆出 `activeAgentId` 到后续 Workspace state。
- [x] 实现 AppData watcher、revision 和 focus refresh。
- [x] 修复 Linux secrets fallback 的跨进程旧缓存覆盖。
- [x] 增加 keychain epoch 通知。
- [x] 验证两个测试线程并发修改不同 key 不丢数据，底层使用同一 OS 跨进程锁语义。

验证：任何全局可写 JSON 都不存在两个进程直接使用独立 LazyStore 缓存整份保存的路径。

### 阶段 3：Workspace identity、状态和进程 bootstrap

- 状态：已完成
- [x] 实现严格 CLI parser 和 bootstrap state。
- [x] 实现 Workspace UUID 文件、metadata scan 和进程生命周期锁。
- [x] 实现 fresh/recent/explicit-dir 选择规则。
- [x] 按 Workspace UUID配置独立 window-state filename。
- [x] React render 前建立 Workspace context 和 env。
- [x] Spaces、tabs、sidebar、AI active state 切换到 Workspace store。
- [x] 保持现有 Local/WSL/SSH command 参数和资源管理不增加 owner。

验证：单进程运行行为与 `main` 一致；状态文件名和锁正确；两测试进程不能绑定同一 UUID。

### 阶段 4：启动新进程与 UI 入口

- 状态：进行中
- [x] 实现 Windows/macOS/Linux/AppImage 启动器。
- [x] Command Palette 添加首项 `New Window`。
- [x] 注册 `Ctrl/Cmd+Shift+N`。
- [x] 环境选择改为启动目标环境新进程，当前窗口不切换。
- [x] 再选当前环境创建 fresh Workspace。
- [x] 选择不同环境使用 recent 策略，锁定时创建 fresh。
- [x] 保持 `Ctrl/Cmd+T` 和“+”菜单原语义。
- [x] 窗口标题显示环境和必要的 Workspace 信息。

验证：连续打开/关闭三个窗口不冻结；关闭父窗口不关闭子进程；未保存编辑器只影响所属窗口。

### 阶段 5：开放多窗口 AI 与 SSH

- 状态：进行中
- [x] 删除任何临时的 secondary-window AI 限制。
- [ ] 验证不同窗口运行不同 session 可并发。
- [ ] 验证同 session 第二写入者被锁定为只读。
- [ ] 验证完成 snapshot 在其他窗口 3 秒内出现。
- [ ] 验证 settings、keys、profiles 的跨窗口更新。
- [ ] 验证同一 SSH profile 两进程拥有独立连接和终端。
- [ ] 验证一个窗口 disconnect/close 不影响另一窗口。

验证：多窗口 AI 和 SSH 生命周期完全按进程隔离，共享数据只通过文件边界同步。

### 阶段 6：综合验证与文档

- 状态：进行中
- [ ] 完成三平台开发和打包矩阵。
- [x] 更新 `TERAX.md` 和相关架构说明。
- [x] 核对 capabilities 和新增依赖来源。
- [x] 运行全部自动化检查。
- [x] 检查 diff，每一处变更都能追溯到本计划。
- [x] 记录无法在本机完成的真实环境测试，不用 mock 冒充端到端结果。

## 14. 自动化测试要求

### 14.1 Rust 单元/集成测试

- CLI 参数严格解析、未知/冲突参数拒绝。
- Workspace UUID、env、metadata 和文件名一致性校验。
- recent 选择、最新被锁定时 fresh、显式目录优先。
- 同 Workspace lock 竞争与崩溃释放语义。
- session UUID path traversal 拒绝。
- session atomic publish 保留旧 snapshot。
- legacy migration 成功、失败、重复运行和部分文件恢复。
- session run lock 竞争、release、delete/rename 拒绝。
- shared store 两进程不同 key mutation 不丢失。
- shared store JSON 损坏不覆盖。
- Linux secrets 多实例 mutation（Linux CI/环境执行）。

### 14.2 前端测试

- New Window command 排序和 shortcut handler。
- 环境选择 current/different env 对应 fresh/recent policy。
- Workspace store path 和状态隔离。
- AI session metadata merge、外部新增/更新/删除。
- 当前运行 session 不被 poll 覆盖。
- session lock 冲突进入只读。
- idle/error/stop/unmount 发布时机。
- activeSessionId 和 activeAgentId 按 Workspace 隔离。
- shared config change event 触发 reload。

### 14.3 自动化命令

- `pnpm check-types`
- `pnpm test -- --run`
- `pnpm build`
- `pnpm lint`，要求 0 error；既有 warning 单独记录。
- `node scripts/eager-graph.mjs`
- `cargo test --all-targets --locked`
- `cargo clippy --all-targets --locked -- -D warnings`
- `cargo fmt --all -- --check`
- `git diff --check`

任何因环境权限失败的既有测试必须准确记录，不能描述为通过。

## 15. 手工测试矩阵

### 15.1 Workspace 与窗口

1. 无状态普通启动，创建默认 Local Workspace。
2. 关闭后普通启动，恢复最近 Local Workspace。
3. 最近 Local Workspace 正在运行时再次启动应用，创建 fresh Workspace。
4. 显式目录启动，创建 fresh Local Workspace 并使用目标目录。
5. 连续使用快捷键创建三个同环境窗口，状态文件和锁均不同。
6. 两窗口分别修改 Spaces、标签页和侧栏，互不覆盖。
7. 关闭任意窗口，其余窗口、PTY、LSP、dev server 持续运行。
8. 强制结束一个进程，重新启动后其 Workspace lock 可重新获取。

### 15.2 Local、WSL、SSH

1. Local 选择 WSL：新窗口打开，Local 窗口保持。
2. WSL 再选当前 distro：创建 fresh WSL Workspace。
3. SSH profile 首次打开、恢复和重复打开。
4. 同一 SSH profile 双窗口分别创建多个终端。
5. 一个 SSH 窗口 disconnect/reconnect/close，另一个不受影响。
6. 两窗口独立使用 SFTP、Git、AI shell 和 tunnel。

### 15.3 AI sessions

1. legacy history 和 todos 迁移后数量、内容一致。
2. 运行中其他窗口只看到旧 snapshot。
3. 正常完成后其他窗口在 3 秒内看到新消息和标题。
4. stop/error 后发布可恢复 snapshot。
5. 运行中强制结束进程，旧 snapshot 保持有效，未完成增量丢失但文件不损坏。
6. 两窗口运行不同 session 可并发。
7. 两窗口尝试继续同 session，第二个只读并给出提示。
8. rename/delete 在运行锁存在时失败，释放后成功。
9. 外部删除只读当前 session，UI 安全切换。

### 15.4 全局配置

1. A 修改主题，B 自动更新。
2. A 修改字体、B 同时修改另一设置，两个值都保留。
3. A 新建 SSH profile，B 环境选择器刷新出现。
4. A 删除 profile，B 不再使用旧缓存启动新连接。
5. A 修改 custom theme/agent/snippet，B 刷新同步。
6. A 更新 key，B 收到 epoch 后重新读取 keychain，不泄露 key。
7. 人为损坏配置文件，应用报错且不以空配置覆盖。

### 15.5 平台

- Windows 安装包与开发模式。
- macOS `.app` 直接启动/`open -n` 路径、激活和关闭行为。
- Linux deb/rpm 普通可执行文件。
- Linux AppImage 从原始 `APPIMAGE` 路径启动子进程。
- 每个平台验证父进程关闭后子进程继续运行。

## 16. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 多进程内存占用高于进程内多窗口 | 先以常见 2–4 窗口为目标测量；不提前做共享后台 broker |
| 两进程旧缓存覆盖全局 JSON | 全局文件禁止直接 LazyStore 整份写；锁内读取最新值并最小 mutation |
| 文件监听丢事件 | 窗口 focus 时检查 revision；写入者也走统一 reload 路径 |
| AI 运行中崩溃丢失增量 | 明确接受第一版边界；保留上一次完整 snapshot，不写半成品 |
| 同 session 双写 | OS session run lock，发送前获取，发布后释放 |
| Workspace 状态被两个进程共享 | 进程生命周期独占锁；锁定最近状态时创建 fresh |
| AppImage 子进程依赖临时 mount | 优先使用 `APPIMAGE` 原始路径 |
| macOS 第二实例激活不一致 | 打包验证 direct executable；必要时平台分支使用 `open -n` |
| window-state 默认文件互相覆盖 | 每 Workspace 独立 plugin filename |
| Linux secrets 缓存覆盖 | 锁内重新读取最新文件，保持 0600 和原子替换 |
| 旧 session 迁移中断 | marker 最后写、旧文件成功后才备份、迁移幂等 |
| 上游合并冲突 | 不 owner 化核心 PTY/LSP/Shell/Remote；新增边界模块并对现有文件做最小接线 |

## 17. 建议提交边界

实现时保持可回退的小提交，不把全部阶段压成一个提交：

1. `refactor(ai): store sessions as per-session snapshots`
2. `fix(config): make shared stores multi-process safe`
3. `feat(workspace): add process bootstrap and isolated state`
4. `feat(window): launch workspace processes from the UI`
5. `test: cover multi-process workspace isolation`
6. `docs: document multi-process workspace windows`

每个提交必须独立通过与其范围相称的测试。第 1、2 个提交在仍为单窗口 UI 时即可验证，降低多项重构同时发生的排查难度。

## 18. 最终成功标准

1. 每个 Workspace 窗口对应独立 Terax 进程，当前 React App 仍保持单窗口假设。
2. New Window 和环境选择创建新进程，当前窗口状态和资源不变。
3. Local、WSL、SSH 均允许同环境多窗口，连接和运行资源完全隔离。
4. 不需要在 PTY、LSP、Shell、Git、fs watch 和 Remote 中传播 window owner。
5. Spaces、tabs、sidebar、AI active state 和 window geometry 不跨 Workspace 覆盖。
6. 所有全局可写配置在并发修改时不丢数据，并能传播到其他窗口。
7. AI history 使用 `sessions/<uuid>.json`，不存在共享 sessions index 写热点。
8. AI 运行态只在所属进程；完成 snapshot 能被其他窗口定时发现。
9. 同 session 不能跨进程并发运行，不同 session 可以并发。
10. legacy AI history/todos 无损迁移且保留备份。
11. 关闭或崩溃一个窗口不影响其他窗口，不损坏已发布 Workspace/session/config 文件。
12. 自动化检查通过，三平台真实启动矩阵有准确记录。
13. 相比旧 `multi-window` 分支，核心上游文件改动显著减少，所有复用均为手工、可追溯的局部移植。

## 19. 执行日志

| 日期 | 阶段 | 状态变化 | 摘要 |
| --- | --- | --- | --- |
| 2026-07-11 | 阶段 0 | 新建 -> 已完成 | 从 `main@1831d07` 创建 `multi-window-process`；只读分析旧进程内分支和当前存储边界；确认一窗口一进程、AI session 单文件优先、共享配置安全写入；仅重写 `plan.md`，尚未开始实现。 |
| 2026-07-11 | 阶段 1–5 | 未开始 -> 进行中/已完成 | 完成 session snapshot/迁移/run lock、共享配置 mutation/watcher、Workspace bootstrap/独占状态、新进程启动和全部 UI 入口；Windows release 双进程 fresh Local 烟测得到两个独立 PID 和 UUID，`Ubuntu-24.04` WSL release 烟测得到独立进程、UUID 和正确环境 metadata。 |
| 2026-07-11 | 阶段 6 | 未开始 -> 进行中 | 前端 48 个测试文件 315 项测试、类型检查、生产构建、eager graph、`git diff --check` 和 Rust clippy 通过；lint 为 0 error/97 个既有 warning。Rust 全量测试仅既有 Windows symlink 权限用例因 Win32 1314 失败，跳过该用例后其余目标通过；`cargo fmt --check` 因未改动的既有 Rust 文件格式失败，本次未扩大 diff。macOS/Linux、真实 AI provider 与 SSH 主机矩阵待对应环境执行。 |
