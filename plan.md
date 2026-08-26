# AI Shell 统一进程工具重构计划

## 目标

将模型可见的 `bash_run`、`bash_background`、`bash_logs`、`bash_list`、`bash_kill` 直接替换为 `shell_exec`、`shell_process`、`shell_list`。项目仍处于开发阶段，不保留旧工具、旧 IPC 或历史 JSONL 渲染兼容层。

本次重构建立一个统一的 Agent 进程模型，完整覆盖短命令、长任务、stdin、EOF、增量输出、等待文本、超时、进程树终止和生命周期回收，并保持 Local、WSL、SSH Workspace 的统一工具语义。非 AI 模块仍需要的一次性 `shell_run_command` 保留，但复用新的安全执行基础设施。

## 核心不变量

- 模型只看到 `shell_exec`、`shell_process`、`shell_list`。
- 前台和后台不是两类进程，只由 `shell_exec` 首次等待时间决定是否立即返回运行句柄。
- 所有进程具有不可复用的字符串 ID、聊天 owner、Workspace、cwd、Shell、状态和有界输出。
- stdin、EOF、poll、固定文本等待、hard timeout 和 terminate 对所有支持的 Workspace 使用相同响应契约。
- 超时、取消、显式终止和应用退出必须清理完整进程树。
- 运行中输出保留 4 MiB 有界记录，终态压缩为最近 256 KiB；工具单次默认返回 64 KiB、最多 256 KiB，并使用单调 offset 增量读取，流式解码和截断不得破坏 UTF-8 字符边界。
- 同一聊天未显式传 cwd 的短命令延续 cwd；转成长任务的命令不能在稍后退出时异步改变聊天 cwd。
- cwd 与 Workspace 环境必须经过 Rust 授权；危险命令硬拒绝不能被 full-access 绕过。
- Agent 子进程只继承运行所需的最小环境，不向模型泄露宿主秘密变量。
- 不增加任意 Shell 路径、参数兼容别名、共享进程配置或未要求的通用抽象。

## 模型工具契约

### `shell_exec`

- 输入：`command`、`cwd?`、`timeout_secs?`、`yield_time_ms?`、`max_output_bytes?`、`shell?`、`login?`。
- `timeout_secs` 省略时为 300 秒，`null` 表示不设置 hard timeout；模型最大可指定 3600 秒。
- `yield_time_ms` 默认 10 秒、最大 30 秒；等待结束前退出则返回终态，否则返回运行中的 `process_id`。
- `shell` 使用封闭枚举，并按 Local、WSL、SSH 和操作系统验证；POSIX 环境默认使用 Bash，Windows Local 默认使用 PowerShell，`login` 只对支持登录语义的 Unix Shell 生效。
- 返回统一的进程状态、stdout、stderr、exit code、elapsed、offset、截断信息和 cwd。

### `shell_process`

- 使用 discriminated union 的 `action`：`poll`、`write`、`close_stdin`、`terminate`。
- `poll` 和 `write` 支持 `since_offset`、短等待、固定字符串 `wait_for`、等待上限和单次输出预算。
- `write` 原样写 stdin，可在同一次操作后关闭 stdin；不自动添加换行。
- `terminate` 使用固定的温和终止与强制终止策略，不向模型暴露信号和宽限期细节。

### `shell_list`

- 默认列出当前聊天 owner 在当前 Workspace 内运行中的进程，`include_exited` 可包含有界保留的最近终态。
- 返回命令、cwd、环境、Shell、状态、时间、退出码和未读输出信息，不向模型暴露其他聊天的进程或 owner。

## 实施步骤

### 1. 契约和统一状态模型

- [x] 在 `ShellState` 中建立统一 Agent 进程表、进程元数据、状态机和有界输出事件记录。
- [x] 定义 Local、WSL、SSH 共用的序列化请求与响应类型。
- [x] 为 offset、输出淘汰、状态转换、数量上限和终态回收编写单元测试。

验证：Rust 相关测试锁定无重复读取、溢出报告、超时和回收不变量。

### 2. 执行、交互和进程树

- [x] Local 使用 stdin/stdout/stderr 管道和平台进程树所有权；Unix 使用独立进程组，Windows 挂起启动并在恢复前加入 Job Object。
- [x] WSL 使用受控 Shell 启动、stdin 管道和 Linux 进程组终止协议。
- [x] SSH 使用长生命周期 exec channel 承载 stdin/stdout/stderr，并使用远端进程组完成状态与终止。
- [x] 实现首次 yield、持续读取、固定文本等待、EOF、hard timeout、取消和应用关闭清理。
- [x] 保留 `shell_run_command` 给非 AI 调用方，并确保其超时也清理完整进程树。

验证：Local 平台相关测试，以及 WSL、SSH 命令构造与协议测试覆盖子孙进程终止、stdin、EOF、超时和任意输出。

### 3. 前端三工具切换

- [x] 在 native bridge 中只暴露新的 Agent 进程 IPC。
- [x] 将模型工具替换为 `shell_exec`、`shell_process`、`shell_list`，使用严格 Zod schema。
- [x] 更新动态审批：exec 审批，write 审批，poll/list/EOF/terminate 自动执行。
- [x] 更新工具状态文案、prompt、进度摘要和工具 UI，删除旧五工具分支。
- [x] 删除旧 `ShellSession`、后台进程类型、旧 IPC 和对应测试，不保留兼容代码。

验证：工具 schema、动态审批、native 参数映射、工具渲染和 prompt 测试通过。

### 4. 安全、资源和生命周期

- [x] 将命令和 cwd 的关键安全检查落实到 Rust 边界，前端检查只作为审批前反馈。
- [x] 使用最小环境基线和明确的必要变量白名单。
- [x] 每聊天最多 4 个运行进程、每应用最多 16 个；终态最多保留 50 个并按 30 分钟回收。
- [x] 聊天删除和应用退出清理 owner 进程；UI 卸载不影响仍在运行的 Agent。
- [x] 同一聊天隐式 cwd 的命令串行结算，显式 cwd 和长任务不更新默认 cwd。

验证：越权 cwd、危险命令、秘密环境、owner 隔离、并发 cwd 和资源上限测试通过。

### 5. 文档与最终清理

- [x] 更新 `AGENTS.md` 中 AI 工具、Shell 与 Workspace 边界。
- [x] 更新 `docs/architecture/ai-subsystem.md`、`two-process-model.md`、`security-model.md`。
- [x] 更新 `docs/contributing/testing.md` 的 Agent 进程不变量与测试要求。
- [x] 全局搜索确认旧工具名、旧 IPC、旧类型和误导性的持久 Shell 描述已经删除。

### 6. 提交前审核修正

- [x] 将 `shell_process` 与 `shell_list` 限定为当前聊天 owner，Rust 对错误 owner 统一返回未找到。
- [x] 将容量检查、进程启动和登记放入同一临界区，避免并发调用穿透每聊天和每应用上限。
- [x] Windows Shell 进程挂起启动，在执行用户代码前加入 Job Object 并恢复。
- [x] 修正终态 elapsed 持续增长、终止后输出再次突破终态上限、UTF-8 分片损坏和 SSH 空根路径问题。
- [x] 补齐 Rust IPC 的 cwd、进程 ID、action 参数组合和控制字符校验。
- [x] 对照 nanobot 后将 POSIX 默认 Shell 统一为 Bash，并为 Python 长任务启用无缓冲输出；不引入兼容别名、额外配置层或会误杀主动长任务的 idle timeout。

## 最终验证

1. `pnpm lint`
2. `pnpm check-types`
3. `pnpm test`
4. `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
5. `cd src-tauri && cargo nextest run --locked`，本地没有 nextest 时使用 `cargo test --locked`
6. 条件允许时在真实 WSL 与 SSH Workspace 复验 stdin、长任务、增量日志、等待文本、超时和完整进程树终止

## 完成标准

- 三个模型工具覆盖旧五工具和新增交互能力，且没有兼容层。
- Local、WSL、SSH 共用清晰、稳定的进程响应契约。
- 不存在超时或终止后遗留的受管子孙进程。
- 输出、进程数量、终态记录和生命周期全部有界。
- 所有相关代码具有符合项目规范的中文文件级和重要逻辑注释。
- 相关文档与实现一致，最小且充分的检查全部通过。

## 验证记录

- `pnpm lint` 通过，保留仓库既有的 32 条 warning，没有修改无关告警代码。
- `pnpm check-types` 通过。
- `pnpm test` 通过，共 205 个测试文件、1079 个测试。
- `cargo clippy --all-targets --locked -- -D warnings` 通过。
- 本机没有 `cargo nextest`，回退的 `cargo test --locked` 通过，共 518 个单元测试、27 个搜索集成测试和 40 个 Git 集成测试。
- Shell 测试在 Windows 上真实验证挂起启动后恢复、stdin、owner 隔离、显式终止、根 Shell 正常退出、Job Object 后代清理、终态计时、UTF-8 输出边界和应用状态析构清理。
- 统一 SSH capability 脚本通过 Bash 语法与契约测试；`setsid --wait` 在本机 Ubuntu 24.04 WSL 中真实返回输出，避免普通 `setsid` fork 后使 `wsl.exe` 提前结束。
- SSH 长生命周期 channel、Workspace 物理路径边界、`setsid --wait` supervisor 和进程组清理由 Rust 协议测试覆盖；本次未连接真实 SSH Workspace。
- `git diff --check` 通过，全局搜索确认源码和长期文档不再引用旧五工具与旧 IPC。
