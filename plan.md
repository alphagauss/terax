# SSH 封闭任务运行时与统一远端服务重构计划

## 背景与目标

当前 SSH 高延迟优化已经覆盖 raw SFTP 目录与文件读取、Bash 条件写入和远端 ripgrep，但内部 Bash 能力仍分散在文件写入、搜索、属性扫描、SFTP 提交和后台进程模块中。不同模块分别维护 capability、协议、错误码、channel 和回退状态，同一类文件或搜索语义也仍存在重复的远端遍历入口。

本次允许破坏式重构，目标是建立两个明确边界：

1. 同一业务语义只有一个服务入口，搜索面板、Explorer、编辑器和 AI Agent 不再各自选择 SSH 后端。
2. 所有可回退的 Terax 内部 Bash 加速操作统一经过连接级封闭任务运行时，集中管理协议、依赖、取消、预开 channel、能力状态和降级。

用户 Shell、PTY、Git、LSP 和文件传输 Archive 不属于封闭加速任务，不并入任务协议。它们可以继续复用 SSH transport，但保持各自的权限和生命周期。

## 核心不变量

- SSH Workspace 仍只支持 Linux 与 Bash，helper 源码编译进应用且不写入服务器。
- Bash 任务只接受 Rust 枚举的固定操作，不暴露通用命令入口，不使用 `eval`。
- 动态标量逐项 shell 转义，文件正文只通过 stdin，结果使用有界的版本化 NUL 协议。
- 读取和写入的秘密路径检查、Workspace 环境绑定、版本冲突、原子发布和结果不明确收敛语义不得弱化。
- Bash 是所选复合操作的首选后端；依赖缺失、协议不支持或安全的执行前失败必须回退传统实现。
- 写入 dispatch 后失败不得盲目回退，必须先根据 expected 和 replacement revision 收敛。
- 单文件正文读取和单层目录读取继续使用 raw SFTP，不因统一运行时改回 Bash。
- capability、预开 channel 和永久降级状态绑定当前 SSH epoch，重连后不复用旧状态。
- 未使用的任务不启动进程、不创建常驻 worker、不额外轮询。

## 目标架构

```text
React UI / AI Agent
        |
Tauri 语义 command
        |
fs/search services | remote/file_service | remote/tree_service | shell background service
        |
RemoteTaskRuntime
   |              |
Bash primary   SFTP / legacy fallback
```

### 语义服务

- 内容搜索统一由 `fs_content_search` 实现，搜索面板和 AI `grep` 共享请求与结果模型。
- 文件列表和 path glob 共享同一远端文件枚举服务，AI Composer、AI `glob` 和其他调用方只做结果策略差异。
- Explorer 模糊搜索和目录属性汇总共享远端树服务的遍历能力，但保留各自的响应模型。
- Editor 与 AI 文件读取统一进入 `remote/file_service.rs`；正文读取固定 SFTP，版本读取和写入可选择 Bash。
- Explorer 与 AI 目录创建统一进入同一个 mutation service。

### 封闭任务运行时

新增 `remote/tasks/`：

```text
remote/tasks/
  mod.rs
  background.rs
  create_directory.rs
  delete.rs
  file_version.rs
  file_write.rs
  ripgrep.rs
  sftp_fallback.rs
  tree_list.rs
  tree_summary.rs
  scripts/
    background.sh
    create_directory.sh
    file_version.sh
    file_write.sh
    tree_list.sh
    tree_summary.sh
```

运行时只负责：

- 只允许 `remote/tasks/` 内的适配器执行 Rust `TaskKind` 对应的固定命令或内嵌脚本，通用命令执行接口不暴露到任务目录之外。
- 统一输入输出上限、超时、取消和 SSH channel 生命周期。
- 高 RTT 时维护一个内部任务预开 channel，并在消费后后台补充。
- 按实际依赖集合缓存单调的 `Unknown`、`Available` 和 `Unavailable` 状态；同一 epoch 的 `Unavailable` 不能被并发成功请求重新启用。
- 在通用执行层区分 `FailedBeforeDispatch` 与 `FailedAfterDispatch`，具体 task 适配器再解释成功、能力缺失、业务错误、取消、协议错误和传输错误。
- 提供当前 epoch 的 capability snapshot，记录缺失命令或不支持的参数特性。

业务 service 负责解释任务结果、决定回退、执行冲突收敛和归一化返回值。

### 协议与依赖

每个有结构化输出的任务使用独立的版本化协议标记，例如：

```text
TERAX_FILE_VERSION_V1\0status\0...
```

运行时不重复包装一个无业务字段的公共协议头，避免两层解析；协议源码和解析器由同一个 task 模块配对维护。

依赖检测采用懒执行。第一次运行任务时在同一次 Bash 调用内检查实际需要的能力，不增加独立 RTT；缺失后在当前 epoch 直接回退。诊断入口可以按需用一次调用检查全部已注册任务。

检测目标包括命令和实际参数能力，例如 `rg --json`、`rg --files`、GNU `find -printf`、`stat -c`、`readlink -f`、`dd conv=fsync`、`mv -T`、`ln -T` 和可用的 SHA-256 provider。内容搜索、文件枚举、三种文件写入及 SFTP 摘要与提交使用独立 capability，某个依赖集合缺失不能污染无关操作。

## 实施批次

### 批次一：运行时基础与现有 helper 迁移

- [x] 新增任务类型、统一 channel、取消与输出边界、版本化协议和 capability 状态。
- [x] 将 `RemoteWorkspace` 的文件 helper 失败状态与预开 channel 移入 `RemoteTaskRuntime`。
- [x] 将现有 Bash 条件写入迁入任务运行时，保持三种写入条件和 SFTP 回退不变。
- [x] 将属性目录扫描迁入 tree task，删除 `FilePropertiesState.ssh_helper_supported`。
- [x] 将远端 `rg` 调用迁入 search task，缓存当前 epoch 的 capability。
- [x] 保持现有 Tauri command 和前端类型不变。

验证：

- Bash 协议、依赖缺失、输出截断、取消和执行阶段分类测试。
- 现有文件 helper、属性扫描和搜索测试通过。
- Rust clippy 和相关 Rust 测试通过。

建议提交：`refactor(remote): centralize internal Bash tasks`

### 批次二：统一搜索与路径枚举

- [x] 将内容搜索、文件列表、glob 和模糊搜索整理为统一搜索域，Tauri command 保持薄包装。
- [x] 搜索面板与 AI `grep` 继续共享 `fs_content_search`。
- [x] `fs_list_files` 与 `fs_glob` 共享 Bash 优先的远端文件枚举实现。
- [x] Explorer 模糊搜索使用 Bash tree task，失败时回退有界并发 SFTP 遍历。
- [x] 远端缺少 `rg` 时复用 tree service，不重复建立逐目录实现。
- [x] 把交互式取消改为 `CancellationToken`，新请求关闭旧 SSH exec channel。
- [x] 保留 AI 命中结果的秘密路径过滤。

验证：

- Local、WSL、SSH 的 literal、regex、glob、隐藏文件、深度、上限和截断语义测试。
- 取消测试确认旧远端任务停止，不只是在返回后丢弃结果。
- Bash 与 SFTP fallback 使用同一组结果契约测试。
- 前端搜索与 AI 工具相关测试、类型检查和 lint 通过。

建议提交：`refactor(search): unify remote search backends`

### 批次三：文件版本与文件系统变更

- [x] 新增 Bash `file_version`，一次完成物理路径解析、大小检查、前后 stat 和摘要。
- [x] 高层 `read_version` 使用 Bash 优先、现有 SFTP/exec 实现回退。
- [x] 新增 Bash `create_directory`，一次完成父链处理和最终目录语义。
- [x] 根据收益和契约复杂度评估 rename 与递归 delete 是否迁入 mutation task；没有明确收益时保留现状。
- [x] 将 SFTP fallback 中仍需执行的摘要与原子提交命令移出 `sftp.rs`，由文件服务和任务运行时集中管理。
- [x] 确保 `remote/sftp.rs` 最终只保留 SFTP primitive。

评估结论：rename 的 Bash `mv -n` 会引入跨文件系统复制和 no-clobber 语义差异，且只减少一个往返；文件删除的 SFTP `stat + remove` 与新开 Bash exec 阶段数相当，递归目录删除已经使用单次受控命令。因此本批保留现状，不为它们新增 helper。

验证：

- 文件版本 Missing、TooLarge、读取期间变化和摘要稳定性测试。
- 目录创建已存在、嵌套父目录、符号链接父级、权限失败和竞态测试。
- Bash 主路径与传统回退契约一致。
- Editor SSH 轮询和条件保存测试通过。

建议提交：`refactor(remote): batch file metadata and mutations`

### 批次四：后台进程查询与清理

- [x] `bash_logs` 在一次任务中返回增量日志和运行状态。
- [x] `bash_list` 一次批量检查全部远端 PID，不逐项串行 exec。
- [x] 已确认退出的远端进程在本地缓存终态，后续列表不再访问服务器。
- [x] 传统多 exec 查询保留为 capability 或协议失败时的回退。
- [x] 删除剩余可回退内部任务的 inline capability 和重复 channel 管理。
- [x] `SshHealthSnapshot` 从任务运行时派生统一降级状态，保留前端需要的兼容字段或同步升级前端。
- [x] 后台日志在服务器端按固定分块读取，客户端输出上限不再导致重复下载剩余整段日志。

验证：

- 0、1、多个运行中和已退出进程的日志、列表、kill 与状态测试。
- 日志含任意文本、NUL、超限和 offset 续读测试。
- 重连后旧 PID 和 capability 不得污染新 epoch。

建议提交：`refactor(shell): batch remote background queries`

## 最终清理标准

- `fs` 业务模块不直接拼接远端 Bash helper。
- `remote/sftp.rs` 不调用 `workspace.exec`，不包含 shell 命令构造。
- 所有可回退的内部 Bash 加速任务只通过 `RemoteTaskRuntime`。
- helper capability 不再散落在各模块 Boolean 中。
- capability 按真实依赖集合拆分并在当前 epoch 单调降级，正文上传前完成对应 SFTP 提交能力检查。
- 搜索、文件列表和目录遍历没有重复的 SSH 递归实现。
- 用户 Shell、PTY、Git、LSP 和 transfer Archive 仍保持独立边界。
- 文档同步更新 `AGENTS.md`、`docs/architecture/two-process-model.md`、`docs/architecture/security-model.md` 和 `docs/contributing/testing.md`。

## 最终验证

1. `pnpm lint`
2. `pnpm check-types`
3. `pnpm test`
4. `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
5. `cd src-tauri && cargo nextest run --locked`，不可用时运行 `cargo test --locked`
6. 所有 Bash helper 独立测试
7. 在高延迟 SSH Workspace 验证 Bash 主路径、依赖缺失回退、取消、重连和状态快照
8. 对文件枚举、内容搜索、文件版本、目录创建和后台日志记录 p50、p95、上传下载字节与 SSH 请求数量

## 完成标准

- 所有实施批次和清理项完成。
- Bash 依赖缺失不会导致功能不可用，传统路径可以完整回退。
- 同一语义的 UI 与 AI 调用共享服务层和远端后端。
- 高延迟环境不再出现按目录、按文件或按后台进程线性放大的串行 SSH 往返。
- 全量验证通过，高延迟服务器测试没有数据损坏、残留临时文件或旧 epoch 状态。

## 本次验证记录

- `pnpm lint` 通过，保留仓库既有的 32 条 warning，未修改无关文件。
- `pnpm check-types` 通过。
- `pnpm test` 通过，共 204 个测试文件、1076 个测试。
- `cargo clippy --all-targets --locked -- -D warnings` 通过。
- 本机没有 `cargo nextest`，已回退 `cargo test --locked`，495 个单元测试、27 个搜索集成测试和 40 个 Git 集成测试全部通过。
- 原方案完成时，文件写入、树枚举、目录汇总、文件版本、目录创建和后台状态的 6 组 Bash 独立契约测试通过。
- 2026-08-25 使用现有无交互 SSH 配置连接 `177.55.234.153:22`，在 5 秒连接截止时间内超时，因此未执行真实服务器性能和变更验证。没有请求密码，也没有修改远端状态。
- 后续静态审查修复了 capability 交叉污染与并发重新启用、搜索回退取消、旧版 ripgrep 参数回退、文件版本身份校验、后台日志服务器端限流和本地/SSH 剪枝差异。真实 SSH 兼容性、重连和性能验证按用户要求留到下一任务。
- 静态审查修复后的 `cargo clippy --all-targets --locked -- -D warnings` 通过；`cargo test --locked` 通过，共 500 个单元测试、27 个搜索集成测试和 40 个 Git 集成测试。
- 12 个 Bash task 与契约脚本通过 `sh -n` 语法检查。Cygwin 本地执行中，tree list、file version 和 background 三组契约通过；file write 权限、tree summary 符号链接和 create directory 符号链接断言依赖真实 Linux 语义，留到下一任务执行。
