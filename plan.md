# 多进程多窗口修复、测试补全与再审计划

更新时间：2026-07-11
目标仓库：`D:\project\terax`
目标分支：`multi-window-process`
修复基线：`7fcd77bbb66ce0100d6de996fcff34ab6444c2f9`

## 1. 状态与文档定位

- 整体状态：已完成；实现修复、自动化补全和第二轮代码审核均已完成。
- 当前阶段：本次任务结束。阶段 6 的真实三平台/SSH/AI 手工矩阵按用户要求不属于本次任务范围，仅保留为后续产品验收清单。
- 本计划是对 `7fcd77b` 多进程多窗口实现的纠偏计划，覆盖审核中发现的功能缺口、并发风险、测试缺口和冗余代码。
- `development_plan.md` 继续拥有最高项目方向优先级；本计划只细化其“多窗口 Workspace 基础”和当前已经进入主线的 SSH/AI 能力。
- 原 `7fcd77b` 提交历史保持不变：不拆分、不 rebase、不 amend、不 force-push。后续修复直接追加在当前分支，提交粒度不作为本轮验收条件。

状态只使用“未开始、进行中、已完成、阻塞”。任何阶段只有在对应验证真实完成后才能标记为“已完成”。

## 2. 修复目标

本轮必须达到以下结果：

1. 首次打开 Local、WSL、SSH Workspace 时，环境 home、Space root、首个终端和连接状态均正确，不依赖先关闭再重开。
2. 一个 Workspace 进程只使用 bootstrap 绑定的环境；Space 不再承担环境切换职责。
3. AI session 的 run lock、最终 snapshot 和 UI 生命周期一致；运行中不能通过切换 session 使发布监听丢失。
4. 同一 session 的第二个进程不能写入；锁释放后可以显式重试，不需要重启应用。
5. agent、snippet、SSH profile、自定义主题和 settings 的并发修改不因旧列表或旧缓存互相覆盖。
6. shared-store 的本进程写入和其他进程写入都能传播最终 revision，不因 leading debounce 永久漏掉最后一次变化。
7. legacy AI 与首个 Workspace 状态迁移可重试、保留备份，并且完成 marker 真正最后落盘。
8. 删除审核确认的死路径和失效 UI，不扩展无关功能。
9. 补齐计划要求的 Rust、前端和真实多进程测试，并在完成后重新做一次独立代码审核。

## 3. 已确认的设计取舍

### 3.1 提交历史

- 保留 `7fcd77b` 原样。
- 不为了符合旧计划中的“六个提交”建议而重写历史。
- 本轮只关心最终 diff 可验证、可回退；是否拆成多个后续提交不影响验收。

### 3.2 Workspace 环境边界

- Workspace metadata 中的 `env` 是当前进程唯一的环境权威来源。
- Space 只表示标签页和 UI 分组，不再保存或切换 Local/WSL/SSH 环境。
- 首次和恢复路径必须共用一次环境初始化：
  - Local：显式 CLI 目录优先，否则使用本机 home。
  - WSL：先解析目标 distro home，再创建 Space 和首个终端。
  - SSH：先读取 profile 和安全存储中的凭据并尝试连接，再取得远端 home。
- SSH secret 不进入 CLI、event、日志或 Workspace 文件。
- 如果 SSH 子进程没有可用的持久凭据，或自动连接失败，在该 SSH 窗口内打开“连接当前 Workspace”的凭据流程；不得再生成第三个窗口。
- 源窗口的 launch-only 对话框若用户输入了密码却取消“记住”，必须明确阻止启动并解释跨进程限制，不能静默丢弃密码。

### 3.3 AI session 生命周期

- 第一版继续只在一个进程内展示和驱动一个 active AI runtime。
- active session 持有 run lock 时，禁止新建、切换或删除其他 session；用户必须先 stop 或等待本轮完成并发布。
- 不为本轮引入“一个窗口内多个后台 AI runtime”管理器。
- run lock 状态进入 Zustand，作为 UI 和轮询合并的单一前端事实来源；不再用不可观察的模块级 Set 单独决定 UI。
- Bridge 在“持有 run lock 且状态已稳定、无待审批”时发布，不依赖只在本次挂载期间观察到 streaming 的临时 ref。
- snapshot 发布和 Rust run lock release 都成功后，前端才能清除持锁状态。
- 发布失败时保留内存消息、锁和可重试状态；不得把失败会话标记为已同步。
- 正常关闭窗口前，等待已经结束但尚未发布的 snapshot；仍在 streaming 的运行按既定边界保留旧 snapshot，并由进程退出释放 OS lock。

### 3.4 Shared store

- entity store 的生产写入只操作目标 record：`upsert(id)` 或 `delete(id)`；只有 legacy migration 可以遍历旧数组。
- Rust watcher 不丢弃 200ms 内的不同 revision。
- 当前写入进程在 mutation 成功后主动 emit；其他进程由文件 watcher 获知。
- 前端监听器用 trailing revision check 合并重复事件，并在订阅建立后立即校验一次，关闭“读取 baseline 与注册 listener 之间”的竞态窗口。
- settings 变更只更新真正改变的 preference，避免单 key 写入触发全部 preference 的重复 set。

### 3.5 迁移

- AI migration 使用确定性 UUID；中断后重复执行不得生成重复 session。
- legacy 原文件或已有 backup 均可作为重试来源。
- 迁移顺序为：取得 migration lock → 校验来源 → 写/验证全部 snapshot → 建立备份 → 写完成 marker。
- 首个 Local Workspace 在自身只有 metadata、尚无有效 Space 状态时，可以一次性导入旧 `terax-spaces.json`；已有有效 Workspace 状态时不得覆盖。
- 旧数据只保留或改名为 backup，本轮不自动删除。

## 4. 已知问题与对应修复

| 编号 | 严重度 | 问题 | 修复方向 |
| --- | --- | --- | --- |
| W1 | 阻断 | fresh Space 分支跳过 WSL home/SSH connect | 环境初始化前置，首次与恢复走同一路径 |
| W2 | 高 | Space 仍可携带并切换独立 env | 删除 per-Space env 与旧 switch path，只使用 bootstrap env |
| W3 | 高 | launch-only SSH 丢弃未记住密码 | 明确阻止不安全启动；子窗口失败时连接当前进程 |
| A1 | 阻断 | AI 运行中切换 session 后 Bridge 卸载，snapshot/lock 不闭环 | 持锁时禁止切换；Bridge 根据可观察锁状态发布 |
| A2 | 高 | lock conflict 后发送按钮永久禁用，Enter 行为不一致 | 输入可保留并显式重试，每次发送重新竞争锁 |
| A3 | 高 | 初始 activeSessionId 不选择最近记录也不持久化 | 恢复 saved id，否则最近 snapshot，否则 fresh，并立即保存 |
| A4 | 中 | inactive cached session 外部更新/删除后仍使用旧 Chat | fingerprint 变化时驱逐非运行 cache；active fallback 先 seed 再切换 |
| C1 | 高 | agent/snippet 全列表保存会删除并发新增 record | 改为单 record upsert/delete API |
| C2 | 高 | shared-store leading debounce 丢最终事件 | 写后主动通知、watcher 全量通知、前端 trailing revision check |
| C3 | 中 | 单 setting 变化重新 set 全部 preferences | 保存 previous snapshot，仅通知发生变化的字段 |
| M1 | 中 | AI marker 早于 backup，失败后不能补齐 | backup 成功后再写 marker，并覆盖中断恢复测试 |
| M2 | 中 | legacy Spaces/sidebar/AI active state 没有明确迁移 | 只向空的首个 Local Workspace 做一次安全导入 |
| R1 | 低 | 旧进程内 `switchWorkspace` 及清理参数无调用者 | 删除死路径和只为它存在的 App 接线 |
| R2 | 低 | default Workspace environment UI 与新语义冲突 | 删除失效设置 UI、setter 和 per-Space fallback |
| R3 | 低 | `renameSession` 无调用者但维护新存储分支 | 删除未使用 API，不新增 rename UI |

## 5. 预计文件边界

### 5.1 Workspace 与 SSH

- `src/app/App.tsx`
- `src/app/hooks/useWorkspaceSwitcher.ts`
- `src/lib/launchDir.ts`（只有环境正确启动确实需要时才修改）
- `src/modules/spaces/lib/activeSpace.ts`
- `src/modules/spaces/lib/store.ts`
- `src/modules/spaces/lib/useSpaces.ts`
- `src/modules/spaces/lib/useSpacesBoot.ts`
- `src/modules/statusbar/WorkspaceEnvSelector.tsx`
- `src/modules/remote/RemoteSshDialog.tsx`
- `src/modules/workspace-process/index.ts`
- 必要的对应测试文件

### 5.2 AI sessions

- `src-tauri/src/modules/ai_sessions.rs`
- `src/modules/ai/components/AgentRunBridge.tsx`
- `src/modules/ai/components/AiMiniWindow.tsx`
- `src/modules/ai/hooks/useAiBootstrap.ts`
- `src/modules/ai/lib/composer.tsx`
- `src/modules/ai/lib/sessionLifecycle.ts`
- `src/modules/ai/lib/sessions.ts`
- `src/modules/ai/store/chatRuntime.ts`
- `src/modules/ai/store/chatStore.ts`
- `src/modules/ai/store/todoStore.ts`
- `src/app/hooks/useAppCloseGuard.ts`
- 必要的对应测试文件

### 5.3 Shared config

- `src-tauri/src/modules/shared_store.rs`
- `src/lib/sharedStore.ts`
- `src/modules/ai/lib/agents.ts`
- `src/modules/ai/lib/snippets.ts`
- `src/modules/ai/store/agentsStore.ts`
- `src/modules/ai/store/snippetsStore.ts`
- `src/modules/settings/store.ts`
- 必要的对应测试文件

### 5.4 Migration、文档和测试

- `src-tauri/src/modules/workspace_process.rs`
- `TERAX.md`
- `docs/architecture/ai-subsystem.md`
- `docs/architecture/two-process-model.md`
- `docs/contributing/testing.md`（仅在新增多进程测试入口时更新）
- `plan.md`

未列出的文件只有在测试或编译证明必须修改时才进入 diff；不得顺带重构。

## 6. 分阶段实施

### 阶段 0：建立纠偏计划与基线

- 状态：已完成
- [x] 保留 `7fcd77b` 提交历史，不做拆分或改写。
- [x] 把首次环境启动、AI lifecycle、共享配置、迁移和冗余问题映射为可验证任务。
- [x] 记录修复前基线：前端 48 个测试文件 315 项通过，新增 Rust 模块定向 15 项通过，clippy 通过，lint 为 0 error/97 warnings。

验证：此阶段只修改 `plan.md`。

### 阶段 1：首次 Workspace 环境与 SSH 启动

- 状态：已完成
- [x] 先增加失败测试：fresh WSL/SSH 必须在创建 Space/首个 tab 前解析目标 home。
- [x] 先增加失败测试：fresh Local 有显式目录时使用目录，否则使用 home。
- [x] 把环境初始化移到 `spaces.length` 分支之前。
- [x] fresh Space root、首个 terminal cwd 和文件树 root 使用目标环境路径。
- [x] 恢复状态时忽略/规范化旧 Space env，禁止 Space 改变进程环境。
- [x] 删除旧 `switchWorkspace`、`workspaceScopeEqual`、`clearWorkspaceState` 和只为该路径存在的参数。
- [x] SSH 自动连接失败时，在当前 SSH 窗口进入凭据/host-key 恢复流程。
- [x] launch-only 模式对未持久化 secret 给出明确阻止信息。
- [x] 删除 default Workspace environment 的失效 UI 和 per-Space `setEnv`。

验证：首次 Local/WSL/SSH 均不需要关闭重开；SSH 失败不会无限生成新窗口。

### 阶段 2：AI run lock、发布与刷新

- 状态：已完成
- [x] 先增加失败测试：运行中 new/switch/delete 被拒绝，Bridge 保持挂载。
- [x] 先增加失败测试：ready/error/stop 发布，成功后才 release。
- [x] 先增加失败测试：publish 或 release 失败时保留消息与持锁状态。
- [x] 把 run lock 所有权放进可观察 store state。
- [x] Bridge 根据“持锁 + 稳定状态 + 无审批”发布，删除挂载期 `runDirty` 假设。
- [x] 锁冲突不永久禁用 composer；保留输入并允许再次发送重试。
- [x] 恢复 activeSessionId：saved → 最近 snapshot → fresh，并立即写 Workspace state。
- [x] 外部更新驱逐非运行 cached Chat；外部删除 active session 时先加载 fallback。
- [x] 窗口正常关闭前等待已完成但未发布的 snapshot。
- [x] 删除无调用者 `renameSession`。

验证：切换操作不能再制造后台无人监听的 Chat；同 session 双写被 OS lock 阻止；锁释放后无需重启即可继续。

### 阶段 3：Shared store 并发与传播

- 状态：已完成
- [x] 组合单 record API 与真实子进程测试，证明基于旧状态的不同 record 写入不会互删。
- [x] 将 agent/snippet store action 改成单 record upsert/delete。
- [x] 删除生产路径中的“根据本地完整列表删除磁盘缺失项”。
- [x] mutation 成功后向当前进程主动 emit 最新 revision。
- [x] 删除 Rust leading debounce，并用内容 revision 避免等长快速写入碰撞。
- [x] 前端 listener 使用 trailing revision check，订阅建立后立即复核。
- [x] preferences 只回调实际变化字段。
- [x] 增加真实子进程同时修改 shared store 不同 key 的测试。

验证：快速连续写入和两个进程并发写入均保留最终数据，已聚焦窗口无需失焦即可刷新。

### 阶段 4：Legacy migration 与状态恢复

- 状态：已完成
- [x] AI migration 等待现有 migration lock，而不是让第二窗口永久空白初始化。
- [x] 支持从 legacy 原文件或已有 `.v0.backup.json` 重试。
- [x] backup 成功后最后写 marker。
- [x] 增加 snapshot 校验失败、backup 失败、backup-only 恢复和 marker 写入失败后的重试测试。
- [x] 在 migration lock 下识别首个空 Local Workspace，并导入旧 Spaces key 命名。
- [x] 不覆盖已经含有效 Space 状态的 Workspace。
- [x] legacy sidebar/mini geometry/active agent 等只在目标 key 缺失时导入；原值保留。
- [x] 文档准确描述迁移顺序和无法迁移时的保留行为。

验证：任何注入中断点都能安全重试；旧数据不被空状态覆盖，也不重复生成。

### 阶段 5：自动化测试补全与全量检查

- 状态：已完成
- [x] Workspace store filename/UUID 隔离测试。
- [x] fresh/recent/显式目录与首次 WSL/SSH home 启动顺序测试。
- [x] session lock conflict、retry、publish/release 顺序测试。
- [x] metadata 外部新增/更新/删除与 cached Chat 驱逐测试。
- [x] activeSessionId/activeAgentId Workspace 隔离测试。
- [x] shared config change listener 与 trailing revision 测试。
- [x] Rust 实际子进程 Workspace/session/shared-store lock 竞争测试。
- [x] Linux secrets 多进程 mutation 无法在当前 Windows 执行，已准确标为 Linux CI/目标环境待执行项。
- [x] 运行第 8 节全部自动化命令并记录两个既有环境/格式基线限制。

验证：新增测试在修复前能失败、修复后通过；不得只有纯函数测试而没有接线层测试。

### 阶段 6：真实多窗口与三平台手工验收矩阵

- 状态：未开始；不属于本次任务范围
- [ ] 完成 Windows 开发与打包产物矩阵。
- [ ] 完成 macOS `.app` 多实例、激活和父子进程关闭矩阵。
- [ ] 完成 Linux deb/rpm 与 AppImage 矩阵。
- [ ] 完成真实 SSH 主机、host-key、记住/不记住凭据、proxy 和双窗口矩阵。
- [ ] 完成真实 AI provider 的双窗口同/不同 session 矩阵。
- [ ] 完成 settings、keys、profiles、theme、agent、snippet 跨窗口传播矩阵。
- [ ] 记录 PID、Workspace UUID、状态文件和可观察结果；不能用 mock 代替端到端结论。

验证：所有可用平台通过；缺少的平台必须准确记录环境限制和待执行项，不得标记为已完成。

### 阶段 7：第二轮独立审核

- 状态：已完成
- [x] 按 `7fcd77b` 功能提交与当前完整工作区 diff 重新阅读，不只检查本轮新增测试。
- [x] 逐项复核 W1–R3 是否真正关闭，不能仅凭测试名判断。
- [x] 搜索共享 LazyStore、全列表覆盖、per-Space env、旧 switch path 和未使用导出。
- [x] 检查错误路径、并发时序、应用关闭和迁移中断。
- [x] 对照 `development_plan.md`、`TERAX.md` 和架构文档消除冲突。
- [x] 输出按严重度排序的审核结论、剩余风险和真实验证结果。
- [x] 本次代码范围不存在已知阻断或高严重度残留，建议进入后续提交与手工验收；不声称阶段 6 已通过。

## 7. 自动化测试设计

### 7.1 Frontend

- `useSpacesBoot`：fresh Local explicit-dir/home；fresh WSL/SSH 在 Space/tab 创建前取得目标 home；旧 Space env 不改变 bootstrap env。
- AI lifecycle：运行时禁止切换；ready/error/stop 发布；失败不 release；lock conflict 可重试；外部更新/删除驱逐 cache。
- Shared store：listener 注册竞态；多个快速事件只回调最终 revision；entity action 只调用目标 key；preferences 只通知变化字段。

### 7.2 Rust

- Workspace metadata、env、UUID、filename 和 lock 一致性。
- 真实子进程不能同时绑定同一 Workspace UUID，进程退出后可以重新取得。
- 两个真实子进程同时 mutation 不同 shared key，最终都存在。
- session run lock 的跨进程 acquire/release/delete/publish 排他性。
- migration 在每个持久化步骤中断后的幂等恢复。
- atomic write 失败不损坏旧文件；watcher/emit payload 不包含 secret。

### 7.3 测试约束

- 不用同进程线程测试冒充跨进程语义；线程测试可以保留，但必须另有真实子进程覆盖。
- 不用 mock 的“connect 成功”冒充真实 SSH 端到端；mock 只验证前端分支和调用顺序。
- 时间相关测试使用可控 scheduler/fake timers，避免依赖任意 sleep。
- 测试产生的 AppData、lock、session 和 backup 必须位于临时目录。

## 8. 自动化命令

必须执行并记录：

```text
pnpm check-types
pnpm test -- --run
pnpm build
pnpm lint
pnpm analyze:eager
cargo test --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
cargo fmt --all -- --check
git diff --check
```

- lint 要求 0 error；warning 必须说明是既有还是本轮新增。
- `cargo test` 的平台权限失败必须给出具体 test 和 OS error，不得概括为“基本通过”。
- `cargo fmt --check` 若仍被未改动旧文件阻塞，要证明本轮 Rust 文件自身已格式化，并单独记录仓库既有差异。

### 8.1 本轮自动化结果

| 命令 | 结果 |
| --- | --- |
| `pnpm check-types` | 通过 |
| `pnpm test` | 通过，53 个测试文件、334 项测试 |
| `pnpm build` | 通过 |
| `pnpm lint` | 通过，0 error；97 warnings / 1 info 均为既有基线，本轮修改文件未新增 lint error |
| `pnpm analyze:eager` | 通过；main 248 个本地 eager 模块，settings 97 个 |
| `pnpm size` | 通过；main eager 352.05 kB / 540 kB，总客户端 1.47 MB / 1.5 MB |
| `cargo check --all-targets --locked` | 通过 |
| `cargo clippy --all-targets --locked -- -D warnings` | 通过 |
| `cargo test --all-targets --locked` | 228 项库测试中 227 通过；既有 `authorize_spawn_cwd_blocks_symlink_escape` 因 Windows 缺少符号链接权限失败，OS error 1314 |
| 同一 Rust 全量命令跳过上述环境受限用例 | 227 项库测试、25 项 fs_search、27 项 git_operations 全部通过 |
| `cargo fmt --all -- --check` | 被未修改旧文件的既有格式差异阻塞；本轮 4 个 Rust 文件单独 `rustfmt --check` 通过 |
| `git diff --check` | 通过，仅输出仓库行尾转换提示 |

补充：`pnpm knip` 仍报告仓库既有 advisory 清单；它不是本轮质量门禁，本轮删除了确认无调用者的 `renameSession`、旧进程内 Workspace switch 路径和无用 shared revision 导出。

## 9. 真实多窗口与三平台手工验收矩阵

### 9.1 Workspace 与环境

1. 空 AppData 启动 Local，Space root 和首个终端为 home。
2. 显式目录启动 Local，root 和终端为目标目录。
3. Local 窗口打开 fresh Local、WSL、SSH，原窗口状态不变。
4. fresh WSL 首次即显示 distro home 文件树，终端 pwd 正确。
5. fresh SSH 首次即连接并显示远端 home，不需要关闭重开。
6. SSH 无已存 secret 时在当前 SSH 窗口提示输入，不生成新窗口。
7. 同环境多个窗口拥有不同 PID、UUID、Workspace/window-state 文件。

### 9.2 AI

1. A、B 运行不同 session，可并发完成并分别发布。
2. A 运行 session X，B 继续 X 被拒绝且输入保留。
3. A 完成后 B 重试 X 成功，不重启应用。
4. 运行中尝试 new/switch/delete 被阻止；stop 后发布完成再允许。
5. 正常完成、stop、error 都发布完整 snapshot。
6. 运行中强杀只保留旧 snapshot；重新启动后 lock 可取得。
7. 外部更新/删除 active 和 inactive session，UI 不显示旧缓存或空白错误会话。

### 9.3 Shared config

1. A、B 同时新增不同 agent/snippet，所有 record 都保留。
2. A 删除一个 record 不影响 B 刚新增的其他 record。
3. 快速连续修改两个 setting，两个窗口都看到最终值。
4. profile/theme/key epoch 的更新在已聚焦窗口自动出现。
5. 人为损坏 JSON 后写入报错，原文件不被空 map 覆盖。

### 9.4 进程与平台

1. 关闭父窗口后新窗口继续运行。
2. 关闭任意 SSH 窗口不影响同 profile 的另一个进程。
3. Windows 安装包和开发模式。
4. macOS direct executable 与必要时 `open -n`。
5. Linux deb/rpm 和 AppImage 原始路径。

## 10. 第二轮审核门槛

本节是产品最终合并门槛。按用户确认，本次任务的完成范围不包含第 6 阶段手工矩阵；本次任务以实现、自动化和代码再审完成为准。

以下条件全部满足才建议合并：

1. W1、A1、C1、C2 没有残留可复现路径。
2. 所有全局 entity 写入均能追溯到单 record mutation；不存在生产路径的整数组覆盖删除。
3. 所有 active AI run 都有明确的 acquire、publish/cancel、release 或进程退出路径。
4. Workspace 环境只来自 bootstrap；搜索不到生产调用的 `Space.setEnv` 或旧进程内 workspace switch。
5. 首次 WSL/SSH 真实功能通过，而不只是 PID/metadata 烟测。
6. 自动化命令通过，三平台与真实 SSH/AI 结果准确记录。
7. `git diff 7fcd77b..HEAD` 中每个改动都能对应 W1–R3、测试或文档同步。
8. 没有为本轮引入新的 owner registry、跨进程 RPC broker 或多 runtime 抽象。

## 11. 风险与控制

| 风险 | 控制 |
| --- | --- |
| SSH auto-connect 早于 host-key listener | 测试 listener/连接启动顺序；失败时在当前窗口恢复 |
| 阻止运行中切换影响现有 UX | 明确提示“先停止或等待完成”，不静默忽略 |
| publish 成功但 release 失败 | 前端继续视为持锁并重试 release，不提前清状态 |
| watcher 重复事件导致频繁 reload | 前端 trailing revision check 合并，不在 Rust 丢不同 revision |
| legacy migration 覆盖新 Workspace | 只向无有效 Space state 的 Local Workspace 导入，锁内复核 |
| 删除 per-Space env 影响旧 JSON | 读取时忽略旧字段并用 bootstrap env；保存后自然规范化 |
| 修复范围继续膨胀 | 只处理 W1–R3 及其测试/文档，不重写 PTY、Remote manager 或 AI transport |

## 12. 执行日志

| 日期 | 阶段 | 状态变化 | 摘要 |
| --- | --- | --- | --- |
| 2026-07-11 | 阶段 0 | 未开始 → 已完成 | 基于 `7fcd77b` 审核结论重写纠偏计划；确认保留提交历史，后续允许必要重构，并以修复、测试补全和第二轮审核为目标。 |
| 2026-07-11 | 阶段 1 | 未开始 → 已完成 | 将进程 bootstrap env 设为唯一环境来源；远端 home 与 host-key 监听完成前不解冻终端；补齐当前 SSH 窗口凭据恢复并删除 per-Space env、旧 switch 路径和失效设置。 |
| 2026-07-11 | 阶段 2 | 未开始 → 已完成 | AI run lock 改为可观察状态；持锁时阻止 session 导航；稳定状态发布成功并 release 后才清锁；补齐 active 恢复、外部 cache 驱逐、关闭前 flush 和 fallback 预载。 |
| 2026-07-11 | 阶段 3 | 未开始 → 已完成 | agent/snippet 改为单 record mutation；shared store 改为写后主动通知、内容 revision 和前端 trailing check；真实双子进程并发写测试通过。 |
| 2026-07-11 | 阶段 4 | 未开始 → 已完成 | AI/Workspace migration 改为 backup 与 marker 最后落盘、可从 backup 重试且不覆盖已初始化 Workspace；补齐旧 sidebar/mini/active agent 导入。 |
| 2026-07-11 | 阶段 5 | 未开始 → 已完成 | 前端 334 项与可执行 Rust 余集全部通过；Workspace/session/shared-store 真实子进程测试通过。Linux secrets 多进程项已准确标为 Linux 环境待执行。 |
| 2026-07-11 | 阶段 7 | 未开始 → 已完成 | 完整重读功能提交与修复 diff，复核 W1–R3、并发/错误/关闭/迁移路径并同步架构文档；未发现残留阻断或高严重度代码问题。 |
| 2026-07-11 | 阶段 6 | 范围外 | 定位为后续真实多窗口与三平台手工验收；按用户确认，不属于本次修复、测试补全与代码再审任务。 |
