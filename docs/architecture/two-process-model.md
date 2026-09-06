# 每个 Workspace 的进程对与 IPC command 参考

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

## 进程划分

一个 Terax Workspace 窗口由一对进程组成：Rust 后端（`src-tauri/`）及其 WebView 前端（`src/`）。打开另一个 Workspace 窗口会启动另一个独立应用进程，从而形成另一对进程。runtime resource 不会跨越该边界；只有明确共享的原子文件和操作系统 keychain 是全局资源。

- **Rust 负责所有操作系统访问**：PTY、文件系统、Git、Shell spawn、网络、秘密和 Workspace 授权。
- **WebView 绝不直接访问文件系统、进程或 Shell**。每项 host 操作都通过 `invoke()` 调用注册在 `src-tauri/src/lib.rs` 中的 command。

该边界是安全模型的基础。不受信任的输入（终端 escape sequence、文件内容、AI 工具结果）由 Rust 或严格限定范围的前端代码解析和验证，绝不会由 renderer 执行。

进程 bootstrap 只选择一个 Local、WSL 或 SSH 环境。Space 只划分该 Workspace 内部的 UI 状态。SSH Workspace 在 Tauri setup 中立即读取 profile 和系统密钥链并开始连接，不等待 WebView；事件桥注册后同时读取权威 Runtime 与待确认主机密钥，避免启动事件竞态。前端读取本地 Space 状态后、等待环境前提交一次前台资源提示。激活终端使用 prepared PTY 在同一 channel 中完成 Linux、bash、Home 与 root 探测并直接进入集成 bash；其他页面继续使用合并 exec 探测。目录、文件正文和后台日志共享标准 SFTP v3 raw session，READDIR 与按 offset 的文件 READ 都有明确上限；普通文件正文维持 8 路流水线，后台日志使用 256 KiB 响应区间和 64 KiB 单 in-flight READ，避免兼容性较差的服务器因同 handle 并发读取而断开 transport。根目录首读进入 single-flight；普通文件元数据和 SFTP 回退写入使用独立高层 session，批量传输仍使用任务独占 session。条件写入优先通过不落盘的内嵌 Bash 任务在一次调用中完成正文接收、摘要冲突校验、耐久刷新、权限恢复和原子发布；任务异常或协议不匹配时安全回退 SFTP。已有 RTT 样本不低于 100 ms 时，每个 Workspace 后台维持一个预开 session channel，仅用于隐藏下一次 channel-open 往返。连接发布且前台目录就绪后，一个固定脚本在单次 channel 中探测全部命令与实际参数能力；结果绑定当前 epoch，通过独立快照和事件驱动状态栏能力灯，重连后清除，用户可在安装依赖后显式重检。每个进程只有一个 SSH 健康监督器：业务入站流量证明 transport 新鲜，底层关闭立即唤醒重连，空闲保活、channel 预热与状态栏 RTT 复用同一低频 SSH ping。只有凭据对话框可以为单次连接提交内存覆盖值，秘密不会通过命令行或自动连接的 WebView 往返传递。

SSH 文件内容 command 统一进入 `remote/file_service.rs`。正文读取固定使用 SFTP；文件版本和三种条件写入优先通过 `remote/tasks/` 执行内嵌 Bash 任务，失败时由服务边界执行 SFTP 回退或版本收敛。任务源码编译进应用，通过 exec command 接收固定操作和已转义参数，正文只通过 stdin 传输，不写入远端脚本、不监听端口。通用任务执行方法只对 `remote/tasks/` 子模块可见，业务模块不能提交任意命令。Git、用户 Shell、PTY 和批量传输保持独立边界。

每个 `RemoteWorkspace` 拥有一个连接级 `RemoteTaskRuntime`。运行时按实际依赖集合缓存当前 epoch 的 Available 或 Unavailable 状态，业务观察到的永久失败保持单调降级；只有一次完整、带 generation 的用户重检可以替换状态。运行时集中管理输出上限、取消和高 RTT 单槽预开 channel，重连会创建全新状态。ripgrep 内容搜索与文件枚举、GNU grep 字面量搜索、三种 Bash 文件写入、SFTP 摘要与三种提交分别缓存能力，单个依赖缺失不会关闭无关路径。递归树、文件列表、属性汇总和目录创建使用 Bash 首选路径，并保留 raw SFTP 回退。`remote/sftp.rs` 只保留 SFTP primitive，SFTP 条件提交所需的固定摘要与原子发布命令也集中位于任务模块。

## 新增 IPC command

1. 在合适的 `src-tauri/src/modules/<area>/` 模块中编写 `#[tauri::command]` async 函数。
2. 在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![...]` block（`src-tauri/src/lib.rs:191`）中注册。
3. 如果 command 使用 Tauri plugin API（window、clipboard、dialog 等），将 plugin permission 添加到 `src-tauri/capabilities/default.json`。
4. 在对应的 `src/modules/<area>/lib/` 目录中添加带类型的前端 wrapper，并通过 Tauri 的 `invoke()` API 调用。
5. 如果 command 涉及文件系统、网络或 Shell，必须通过现有 guard（Agent 文件 Rust 策略、Workspace 授权 registry、SSRF guard、Shell 安全检查和 AI 工具审批）。

自定义 command 无需逐项列入 `default.json`，capability 会覆盖整个窗口；plugin permission 则必须列出。

## Command 目录

下面按模块列出注册在 `src-tauri/src/lib.rs` 中的 command。名称均为前端所见的 Rust 函数名。

### PTY（`src-tauri/src/modules/pty/`）

长生命周期交互式终端 session。

- `pty_open` - 创建新的 PTY session
- `pty_write` - 发送输入字节（文本或 control sequence）
- `pty_resize` - 调整 PTY 大小
- `pty_close` / `pty_close_all` - 销毁一个或全部 session
- `pty_has_foreground_process` / `pty_has_foreground_job` - 检测是否正在运行 command
- `pty_shell_name` / `pty_list_shells` - Shell 检测与枚举

输出从 `pty_open` 通过 Tauri `Channel<PtyEvent>` 流式传输。

### 文件系统（`src-tauri/src/modules/fs/`）

#### Tree

- `list_subdirs` - 列出子目录
- `fs_read_dir` - 读取目录

#### File

- `fs_read_file` - 读取文件内容
- `fs_file_version` - 在数据源计算文件 metadata 和 digest，但不返回内容
- `fs_write_file` - 写入文件内容
- `fs_write_file_checked` - 显式匹配文件 version、仅在缺失时创建或允许覆盖，然后原子提交文件
- `fs_stat` - 文件 metadata
- `fs_canonicalize` - canonical path

#### 修改

- `fs_create_file` / `fs_create_dir`
- `fs_rename` / `fs_delete` / `fs_copy`

#### 监听

- `fs_watch_add` / `fs_watch_remove` - 文件系统变更通知

#### 搜索

- `fs_search` - fuzzy file finder
- `fs_list_files` - 递归文件列表

#### Grep

- `fs_content_search` - 用户搜索面板与 AI `grep` 共用的内容搜索，支持普通文本、正则、大小写、整词、包含和排除 glob；搜索面板请求可以取消上一轮扫描
- `fs_glob` - glob 匹配

内容搜索按需扫描并遵守 ignore 文件，不建立持久索引、文件 watcher 或搜索历史。Local 与 WSL 使用内嵌 Rust grep 实现；SSH 优先使用远端 `rg`，缺少 `rg` 的字面量搜索使用 GNU `find + grep` 服务端兼容路径，仍不可用时通过共享 tree service 回退有界 SFTP 扫描。GNU grep 只负责返回候选行，路径过滤和最终匹配区间仍由 Rust matcher 收敛。文件列表与 glob 共享同一 `rg --files` 主路径，缺失时依次使用 GNU find 树任务和 SFTP；Explorer 模糊搜索复用同一树服务。交互式新请求会取消并关闭旧远端 task channel。AI `grep` 复用匹配引擎，但通过 Agent 文件后端独立执行权限模式、聚合和分页；Workspace 根与敏感路径过滤只在请求批准模式启用。

#### Agent 文件服务

- `agent_file_read` - owner 隔离的带行号文本读取和版本登记
- `agent_file_find` - 直接目录列举与递归 glob 的统一路径发现
- `agent_file_grep` - literal/regex 搜索及 content/files/count 聚合
- `agent_file_prepare_mutation` / `agent_file_commit_mutation` / `agent_file_clear_mutation` - Rust 预备快照与条件提交生命周期
- `agent_file_operation` - move、copy、delete、create_directory 结构操作
- `agent_file_clear_owner` - 聊天删除时清理读取版本、固定 scope 和预备快照

模型只看到 `read_file`、`find_files`、`grep`、`write_file`、`apply_patch`、`file_operation`。所有请求在 Rust 中把 owner 绑定到已授权 Workspace 根，再路由到 Local、WSL 或 SSH primitive。`write_file` 创建父目录并区分 create/rewrite；`apply_patch` 只对当前聊天已读取的现有 UTF-8 文件执行精确替换。多文件提交先验证全部基线，再逐文件原子发布，不提供跨文件系统事务保证。

### 文件传输（`src-tauri/src/modules/transfers/`）

后台传输在进程内执行，并绑定到不可变的 Workspace 环境。低频 task 历史由 Rust Journal 持久化。Direct 和 Archive 是显式 strategy，共享同一 planner、scheduler、staging、conflict 和 commit protocol。

- `transfer_enqueue` - 使用 request 中的显式 strategy 创建 task
- `transfer_list` - 列出当前 Workspace task snapshot，首次访问时加载 Journal 历史
- `transfer_resolve_conflict` - 使用绑定到 task 的 decision 解决当前 conflict
- `transfer_retry_failure` / `transfer_ignore_failure` - 更新一项 Direct file failure
- `transfer_pause` / `transfer_resume` / `transfer_cancel` - 控制排队中或运行中的 task
- `transfer_retry` - 根据 failed 或 canceled request 创建新 task
- `transfer_remove` - 删除一条 terminal history entry

安全不变量和资源限制参见[文件传输](file-transfers.md)。

### Git（`src-tauri/src/modules/git/`）

所有 Git command 都通过 Workspace 授权 registry 限制。

- `git_resolve_repo` / `git_panel_snapshot`
- `git_status`
- `git_diff` / `git_diff_content`
- `git_stage` / `git_unstage` / `git_discard`
- `git_commit`
- `git_fetch` / `git_pull_ff_only` / `git_push`
- `git_log` / `git_show_commit` / `git_commit_files` / `git_commit_file_diff`
- `git_remote_url`
- `git_list_branches` / `git_checkout_branch`

### Shell（`src-tauri/src/modules/shell/`）

两个明确 surface：

- `shell_run_command`：供编辑器格式化等非 AI 模块使用的一次性 subshell exec，输出和超时有界。
- `shell_exec` / `shell_process` / `shell_list`：AI 短命令与长任务共享且按聊天 owner 隔离的 Agent 进程表。`shell_exec` 同时接收冻结的会话 cwd 和本次调用的访问级别，未提升调用只能从会话根内启动，单次批准和完全访问允许任意可访问 cwd。启动调用首次等待后返回统一 `process_id`；后续可以增量读取 stdout/stderr、等待固定文本、写 stdin、发送 EOF 或终止完整进程树。
- `shell_clear_owner`：聊天删除时终止并移除该 owner 的全部 Agent 进程和 cwd 状态。

运行中的 Agent 进程保留 4 MiB 全局字节 offset 输出，流式解码和截断保持 UTF-8 字符边界；进入终态后压缩为最近 256 KiB，单次 IPC 最多返回 256 KiB。每聊天最多运行 4 个、每应用最多运行 16 个，容量检查与进程登记在同一 spawn 临界区完成；最近终态最多保留 50 条并在 30 分钟后回收。Local 使用 Unix process group 或 Windows Job Object，Windows 进程挂起启动并在恢复前加入 Job Object；WSL 与 SSH 使用 `setsid` 建立远端进程组。POSIX Agent 命令默认使用 Bash。SSH stdin/stdout/stderr 保持在长生命周期 exec channel 上，不写远端日志文件。

### Workspace（`src-tauri/src/modules/workspace.rs`）

- `workspace_authorize` / `workspace_current_dir` - spawn/Git/AI cwd 授权 registry
- `workspace_prepare_default_root` - 无 Explorer 根时延迟创建并授权 Local/WSL 默认 Agent 目录；SSH 返回连接时验证的 profile Workspace root
- `wsl_list_distros` / `wsl_default_distro` / `wsl_home` - WSL bridge

### Workspace 进程（`src-tauri/src/modules/workspace_process.rs`）

- `get_workspace_bootstrap` - 在 WebView 渲染前选定的不可变 Workspace UUID、环境、启动目录和 state filename
- `spawn_workspace_process` - 为新建或现有 Workspace 启动另一个 executable instance，绝不 reset caller

每个进程在其整个生命周期内持有 Workspace OS lock。

### Workspace 运行时交换（`src-tauri/src/modules/workspace_runtime.rs`）

- `workspace_runtime_list_temporary_windows` - 返回当前环境中仍持锁的临时窗口
- `workspace_runtime_send_page` - 向已经运行的同环境临时窗口投递工作页描述
- `workspace_runtime_spawn_with_page` - 投递工作页并启动指定 UUID 的临时 Workspace 进程
- `workspace_runtime_take_messages` - 原子取走当前窗口的激活、打开文件和工作页消息

运行时交换文件是可丢弃的窗口登记表和一次性消息队列，不是共享配置或恢复状态。窗口存活判断复用 Workspace OS lock，不建立心跳。

### 共享配置（`src-tauri/src/modules/shared_store.rs`）

- `shared_store_read` / `shared_store_revision`
- `shared_store_set` / `shared_store_delete` - 加锁、读取最新 object、修改一个 key，并原子替换文件

白名单逻辑存储 `channels` 映射到 `~/.terax/channels/config.json`，`channels-state:<uuid>` 映射到独立协议状态文件。UUID 必须规范化，前端不能提供任意路径。协议检查点不广播高频配置事件。

写入进程会立即收到 change event，其他进程则收到 file-watcher event。前端 listener 执行 trailing revision check，因此 event coalescing 不会永久隐藏最终写入。

### AI session（`src-tauri/src/modules/ai_sessions.rs`）

- `ai_sessions_list` / `ai_session_read` / `ai_session_commit` / `ai_session_delete`
- `ai_session_run_acquire` / `ai_session_run_release` - 跨进程独占 run ownership

### 网络（`src-tauri/src/modules/net.rs`）

- `http_request` / `http_cancel` - 通用 HTTP 传输与按 WebView 隔离的取消。响应通过 started、headers、chunk、end 事件返回，配置有界总超时和响应大小，保留 SSRF guard。全部网络 Provider、模型目录与 Channels、语音共用该边界；`networkTarget` 声明连接身份，由 Rust 读取最新路由。
- `network_validate_proxy` - 供设置页验证不含密码的代理 URL，实际保存仍在共享存储入口再次校验。详见 [内置网络与代理](network.md)。

### 秘密（`src-tauri/src/modules/secrets.rs`）

- `secrets_get` / `secrets_set` / `secrets_delete` / `secrets_get_all` - 操作系统 keychain 访问；AI 与 Channels 分别使用自己的 service，连接凭据以实例 UUID 隔离

### Agent hook（`src-tauri/src/modules/agent.rs`）

- `agent_enable_hooks` / `agent_hooks_status` - 安装/查询终端编码 Agent hook（Claude Code、Codex、Gemini CLI）

### 历史（`src-tauri/src/modules/history/`）

- `history_suggest` / `history_commands` / `history_record` / `history_list` - Shell history 集成

### 辅助窗口

- `get_launch_dir` - CLI 启动目录，首次读取时 drain
- `auxiliary_window::open_auxiliary_window` - 按封闭类型定义创建或复用轻量辅助 WebView 窗口
- `auxiliary_window::get_auxiliary_window_request` - 返回当前辅助窗口带 revision 的最新受控打开请求

### 文件属性

- `fs_properties_get` - 按当前进程绑定的 Local、WSL 或 SSH 环境读取目标自身属性
- `fs_properties_scan` / `fs_properties_scan_cancel` - 启动或取消不跟随符号链接的目录递归汇总

SSH 目录汇总优先在一个受控只读 exec channel 内完成服务端聚合，避免文件夹数量放大为网络往返；远端 helper 不可用时回退有界并发 SFTP 读取。helper 路径参数经过转义，不接受任意命令，也不读取文件正文或修改远端状态。

## 不变量

- WebView 除通过上述 command 外，不得 spawn 进程、读取文件或发起网络调用。
- 新 command 必须在 `lib.rs` 中注册，并在边界处受到保护（Workspace auth、deny-list、SSRF、approval flow）。
- 如果 command 使用 plugin API，必须将 plugin permission 添加到 `src-tauri/capabilities/default.json`。
- 绝不通过进程参数或 Workspace 文件传递 SSH password、proxy password 或其他秘密。
- 共享 entity writer 只能修改其目标 key，绝不能持久化过时的完整 list snapshot。
- 工作页交接、窗口激活和打开文件请求只能进入 Workspace 运行时交换文件，不能写入共享设置。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY Shell 集成](pty-shell-integration.md) - session 与 Shell 集成的工作方式
- [安全模型](security-model.md) - 每个 command 都必须遵守的边界
