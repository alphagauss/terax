# 测试

本指南是对 `AGENTS.md` 和 `CONTRIBUTING.md` 的补充。如有冲突，以这两个文件为准。

## 在本地运行检查

以下标准命令与 CI（`.github/workflows/ci.yml`）中运行的命令一致：

```bash
pnpm lint
pnpm check-types
pnpm test

cd src-tauri
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked        # CI uses nextest
```

如果尚未安装 `cargo-nextest`，可在本地使用 `cargo test --locked` 作为替代。使用 `cargo install cargo-nextest` 安装 nextest。

`storage`、`workspace_process`、`ai_sessions` 和 `shared_store` Rust 测试套件还会将当前测试可执行文件作为辅助进程启动。它们验证真实的操作系统锁互斥、释放/重试行为，以及跨进程并发读取最新值/修改 key 的行为，而不只是共享同一内存状态的两个 task。修改 Workspace 锁、AI session 所有权或共享配置时，应将这些测试保留在常规 Rust 测试命令中。

## 必须添加测试的变更

`CONTRIBUTING.md` 要求，任何涉及以下关键路径行为的变更都必须有测试：

- Shell / 终端启动（启动哪个 Shell，以及使用哪个 cwd、环境变量和 login flag）
- Agent 进程（stdin、EOF、输出 offset、等待文本、数量上限、终态回收和完整进程树终止）
- Workspace 授权（同时覆盖允许和拒绝路径）
- Git command 层（仓库根目录解析、pathspec/参数防护和 status 解析）
- 文件系统变更（原子写入、symlink 处理，以及部分失败时不丢失数据）
- IPC command surface 和 AI tool surface
- 文件传输规划与变更（Workspace 边界、源文件 identity、staging 所有权、no-replace publication、取消和有界失败）
- 影响范围广的纯逻辑（cwd 继承、tab/split tree 变换、OSC/prompt 解析和 command guard）

标准是切实覆盖约定，而不是占位测试。应测试边界、拒绝路径，以及“home 的上一级会发生什么”。

## 不需要测试的变更

UI 渲染、主题、语法高亮表格以及类型检查器已经能够保证的内容不需要测试。

## 编写优秀的测试

优秀的测试会锁定所依赖的不变量。代码库中的示例包括：

- `src-tauri/src/modules/workspace.rs` 的 `auth_tests` 验证已授权路径、已授权根目录的子目录、未授权路径、不存在的路径和 symlink 越界均能得到正确处理。
- `src-tauri/src/modules/proc/job.rs` 的测试验证 Windows 进程在 Job Object 内恢复执行，且丢弃 Job Object 会终止分配给它的进程树。
- `src-tauri/src/modules/pty/session.rs` 的测试验证丢弃 `Session` 会终止子进程。
- `src-tauri/src/modules/pty/shell_init.rs` 的测试验证 Shell 分类和 WSL fish 启动规范。

## 跨平台 PTY 测试

平台特定行为必须使用条件编译限制：

```rust
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool { ... }

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool { ... }
```

ConPTY/Job Object 测试应放在 `#[cfg(windows)]` 后，Unix PTY 生命周期测试应放在 `#[cfg(unix)]` 后。不要假设在一个平台上可用的辅助函数也适用于另一平台。

## Agent 文件后端测试

修改 `src-tauri/src/modules/fs/agent.rs` 时，应覆盖：

1. owner 不能切换 Workspace 环境或已绑定的根目录，进程内 owner scope 总数必须有界。
2. 相对路径先基于 cwd 解析父级分量。请求批准模式下未提升调用要求根目录是已登记的 Workspace 根且目标 canonical path 不能越界；一次性批准和完全访问允许根外目标。
3. 不存在的目标向上解析最近存在祖先；未提升调用下已有符号链接不能绕过根目录或敏感路径，提升调用仍使用解析后的稳定物理路径。
4. Windows Local 的 NTFS alternate data stream、DOS 设备名和末尾点号或空格始终被规范化拒绝；请求批准模式还拒绝密钥文件名及其大小写变体，项目内普通 `etc`、`proc`、`sys` 目录不能误判为系统根。
5. `read_file` 去重同时匹配内容版本和读取范围，UTF-8 输出截断保持字符边界。
6. rewrite 与 patch 要求当前 owner 已读取相同版本；CRLF 文件的跨行精确补丁保留原换行；create、审批后变化和目标占用必须拒绝覆盖。
7. 多文件修改先校验全部基线，单文件原子发布；中途失败测试必须验证回滚和准确错误。
8. `file_operation` 始终拒绝文件系统根、隐式覆盖和未显式声明的目录递归删除；请求批准模式下操作 Workspace 根需要提升。copy 使用 no-clobber 发布，远端存在性错误不能当作目标缺失。
9. Local Windows 路径比较可以忽略大小写，WSL 与 SSH 路径必须保持大小写敏感；显式单文件 `grep` 只搜索该文件。

`src/modules/ai/tools/authorization.ts` 只负责决定是否请求批准。测试必须分别锁定 cwd 内自动执行、越界与敏感路径审批、Shell 网络与不透明命令审批；Rust 测试继续承载 canonical 路径、启动 cwd 和灾难性命令不变量。

会话消息测试必须比较工具成功、结构化错误、执行错误和审批拒绝在实时与 JSONL 恢复后的最终 provider `ModelMessage`，包括 approval ID、决定、原因和签名；只比较 UI part 或磁盘字段不足以锁定 prompt cache 前缀。

## 文件传输测试

文件传输变更必须保持以下不变量：

1. 传输路径是规范化的绝对路径，同时远端清理不能遗留对应任务专属的目标父目录。
2. 失败或取消的任务只删除其专属 staging path。
3. 最终 publication 不能替换由其他任务或进程创建的目标。
4. 规划完成后重新检查源文件 identity 和预期大小。
5. 已暂停的排队任务不占用 scheduler permit，取消操作会唤醒所有 waiter。
6. SSH 连接中断必须在远程 I/O 时间上限内进入 terminal state。
7. Archive 解压由 manifest 驱动，而不是由不受信任的 archive path 驱动。
8. 传输前后同路径均为目录时，Direct、Archive 和所有目录冲突决策都不得替换该目录的文件系统身份。
9. 异常退出恢复只能自动删除已持久化为 disposable 的精确 backup 路径；recovery 票据、改绑的 SSH endpoint 和不匹配 task ID 的路径必须拒绝清理。

WSL 或 SSH 验证应使用真实 Tauri 进程，因为仅运行 Vite 的页面无法覆盖 Workspace bootstrap、原生 command、任务独占的 SFTP session 或文件系统通知。发布级文件传输变更需要覆盖两个方向、文件与目录、Unicode 与空条目、暂停/恢复、取消、目标冲突、连接中断、重试和目标空间不足，并跨边界比较文件 hash。

## 不变量

- SSH 文件后端契约测试必须同时锁定正文、revision、TooLarge、Conflict、Missing 和 Overwrite 语义。
- raw SFTP 文件读取测试必须覆盖空文件、块边界、超过流水线并发度和乱序响应组装。
- Bash task 测试必须覆盖固定协议、实际参数探测、权限、fsync、三种条件提交和临时文件清理。
- SSH task 测试必须覆盖依赖缺失、协议截断、取消、epoch capability 隔离、统一能力探测和传统后端回退；递归树、文件版本、目录创建和 GNU grep 搜索均需独立契约测试。
- Agent Shell 测试必须分别锁定 owner 隔离、输入边界、终态计时、Local stdin、Unix process group、Windows 挂起启动与 Job Object，以及 WSL/SSH `setsid` 命令构造和远端进程组清理协议。只验证直接 Shell 进程退出不能替代子孙进程清理测试。
- Agent 文件测试必须分别锁定 Local 的真实文件行为、WSL 路径映射和 SSH SFTP/task 路由；仅测试前端 schema 不能替代 Rust Workspace、安全、版本和提交测试。
- helper 响应丢失后的 Rust 测试必须锁定 Overwrite 收敛以及 Match、Missing 的安全回退。
- 状态栏能力灯只能接受当前 epoch 的能力事件；自动探测失败必须保留 lazy probe，瞬时 transport 错误不得显示为永久依赖缺失。
- 影响范围全局的局部修复必须能被测试捕获，只依赖 review 不够。
- 不仅测试 happy path，还要测试拒绝路径和边界。
- 将平台特定测试放在正确的 `#[cfg(...)]` 条件后。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) - 质量标准、项目布局和贡献方式
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [文件传输](../architecture/file-transfers.md) - 生命周期、安全边界、资源限制和验证矩阵
