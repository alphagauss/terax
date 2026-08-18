# 文件传输架构

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

## 范围

Terax 支持在 Host 与 Workspace 进程启动时选定且不可变的 WSL 或 SSH 环境之间，后台传输文件和目录。Rust 后端负责 task 状态、文件系统访问、调度和最终 publication。WebView 仅通过带类型的 Tauri command 创建和控制 task。

task 在进程内执行，低频 task 历史以每个 task 一个 JSONL Journal 的形式持久化到 `~/.terax/transfers`。进程重启不会恢复已传输的字节，而是将中断的 active task 恢复为 failed，并保留稳定的 aggregate count。Journal 还保存低频 cleanup ticket，用于安全收敛提交成功后未删除的 backup。

## 执行流程

每个 task 都遵循相同流程：

1. 规范化 request，并将其绑定到当前 Workspace 环境。
2. 扫描 source、拒绝不支持的 entry，并构建与 strategy 无关的 manifest。
3. 在进程内预留所有最终 top-level destination。
4. 检查 destination conflict 并等待用户明确决定；等待期间保留 destination reservation，但不占用 data-transfer permit。
5. 等待当前 Workspace 进程中的两个 execution permit 之一。
6. 将每个 root 写入名为 `.terax-part-<task-id>-<index>` 的 task-owned sibling path。
7. 重新检查 source identity、已传输大小以及每项 conflict decision 所覆盖的 destination state。
8. 使用该 task 获得授权的 commit mode 发布 root。新目标直接 rename；已存在且最终仍为目录的路径在原位协调条目。
9. 仅删除 task 自己拥有的 temporary path，并释放 reservation。

Direct 和 Archive 是统一 enqueue request 中携带的显式选择。二者共享相同的生命周期、manifest、reservation、progress 和 commit protocol。Terax 绝不会自动选择 strategy，也不会从 Archive 静默 fallback 到 Direct。

## Strategy

### Direct

Direct 逐个复制文件。一个目录是一个 aggregate task：可恢复的文件失败会被记录，同时继续处理其他文件；连接中断、存储耗尽、不可靠的 Journal 和 commit 失败则会终止 task。子级 conflict 可以选择 skip 或 replace，并可将选择复用于本次执行中的其余 conflict。被 skip 的 source entry 不会进入 staging，并保留现有 destination。失败文件可以在原 aggregate row 中 retry 或 ignore。每次 retry 都会重新检查 source 和 conflict，不复用之前的 bulk decision。

目录合并不替换已存在的目录本身。来源与目标同路径且最终都为目录时，只在该目录内移动发生变化的条目，使终端 cwd、目录句柄和文件监听器继续绑定同一文件系统对象。

SSH 传输使用 task 独占的 SFTP session、有上限的 in-flight request、基于 offset 的写入和 close result 验证。WSL Direct 使用 Host 文件系统 bridge。空目录以及可移植的 permission 和 modification-time metadata 会被保留。Unix mode 保留其 permission 语义；Windows `ReadOnly` 仅针对文件保留，因为目录 attribute 不代表 POSIX 写访问权限。

### Archive

Archive 构建 tar.gz stream，并跨环境边界一次性传输。上传在传输前于本地验证，并安全解压到私有远程工作目录。下载在远程创建，再依据 planner manifest 于本地验证并解压。destination 目录已存在时，source-first merge 保留仅存在于 destination 的 entry 并替换 conflict；destination-first merge 保留仅存在于 source 的 entry，同时保持 conflict 不变。

Archive 的目录提交与 Direct 共享同一 inode 不变量：传输前后同路径都为目录时，不删除、改名或重建该目录。Replace 仅删除最终结果中不再存在的条目；目录最终被删除或变为文件时不保留 inode。SSH 和 WSL Archive 在目标端以一次批处理完成协调，不产生逐文件跨环境往返。

Archive 拒绝绝对路径、parent traversal、link、特殊文件、重复 manifest entry、意外 entry、大小不符、无效 gzip 数据和过量尾随数据。SSH Archive 要求 Linux；SSH 和 WSL Archive 都要求 bash、tar、gzip 和私有临时目录。缺少工具时会产生明确失败。

## 安全性与完整性

- WSL 和 SSH 传输路径必须是规范化绝对路径，且不含 parent traversal 或控制字符。Explorer 中的显式选择可以位于 profile 的 startup root 之外。
- 不传输 symbolic link、hard link、socket、device 和其他特殊文件。
- 最终 destination 在执行前通过 ancestor 与 descendant 重叠检查进行预留，并在 commit 时再次检查。
- 新 destination 使用 no-replace publication。仅在有明确 conflict decision 时修改现有 target。Direct 目录 merge 还会重新验证 conflict 检查期间发现的所有可达 source path，包括当时不存在的 path。
- Direct 可以逐个暴露 root。后续 root 失败时，已经 commit 的 root 会保留，Workspace 会收到 filesystem-change event。Archive 将所有 root 作为一个可回滚 transaction 提交，任一 root 失败时一并 rollback。原位目录协调会逐项可见，不承诺整棵目录的瞬时切换。
- cancel 和 failure cleanup 只处理从 task ID 派生的 path。root 成功发布后，相同的受限 cleanup path 还会删除其派生 backup。commit 或 rollback 失败后保留的 backup 属于恢复数据，绝不进入通用 cleanup 调度。远程 cleanup 还要求 task 捕获的精确 canonical destination parent，且绝不递归删除最终 destination。
- 破坏性提交前会同步写入 `recovery` cleanup ticket，它永不自动删除路径。只有提交已成功且 backup 仍未清完时，票据才会转为 `disposable`。当前进程会继续受限重试；下次首次加载传输历史时只为 disposable 票据启动一次精确路径清理。失败时复用既有的最长十分钟任务内重试，不扫描 Workspace，也没有常驻的全局周期任务。
- Owned staging 和 committed-backup cleanup 首先执行一次 same-filesystem traversal。若目录 permission 阻止删除，只恢复该 temporary tree 内所需的 owner permission 并 retry。它不跟随 symbolic link、不跨越 nested mount、不修改已发布 destination，也不 elevate privilege；如果 temporary root 本身是 mount point，则拒绝处理。
- Direct 会重新检查规划时的 source identity 和文件大小。SSH transport 提供 packet integrity。Archive 还验证 gzip 和完整 manifest。当前 threat model 不要求第二套 content-hash protocol，因此未包含；若要添加，必须明确 algorithm、性能预算和用户可见约定。

## 失败与重试模型

task snapshot 提供稳定 error code、诊断 detail、aggregate file count、未解决的 Direct file failure，以及 whole-task retry 是否有意义。前端本地化稳定 code，不解析后端英文文本。whole-task retry 根据原 request 创建新 task。Direct file retry 复用原 aggregate task，但创建新的 execution identity 和 staging path。

每个 SSH 文件系统操作的上限为 15 秒，避免故障 transport 无限期占用 execution permit。如果断开连接导致无法立即 cleanup，当前 Workspace 进程会等待相同 host、port 和 username 的稳定 endpoint 重新连接，最长十分钟，然后重试删除。即使使用相同 profile ID，重新绑定到另一个 endpoint 也不会转移 cleanup authorization。

延迟的 local、WSL 和 SSH cleanup 会保留进程内 task ownership，直到确认删除完成。只要 task 仍有任何 pending cleanup operation，手动删除历史、批量清除和自动 pruning 都会跳过它。

进程突然退出仍可能在 target 侧留下具有唯一名称的 staging path。它们绝不会被视为已完成 destination 或被复用。已持久化为 disposable 的 backup 会在下次加载时自动清理；中断于提交中的 recovery backup 保守留存。Journal 将中断的 task 保留为 failed，但首个版本不提供 byte-level resume。

## 资源上限

- 最多并发执行 2 个 task。
- 最多允许 64 个 task 处于 non-terminal 状态或保留 pending cleanup ownership。
- 最多保留 100 条 terminal history entry。
- 一个 request 最多包含 1,024 个 source。
- 每个 source 或 destination path 最长 32 KiB。
- SSH transfer 和 cleanup session 与 Explorer 缓存的 SFTP session 分离。

这些限制可防止畸形 IPC request 或无人值守的 task producer 造成无限的内存、网络或 file descriptor 压力。

## IPC 与 event

- `transfer_enqueue` 根据 `request.strategy` 创建 Direct 或 Archive task。
- `transfer_list` 在首次访问时从 Journal 恢复当前 Workspace 的 task 历史。
- `transfer_resolve_conflict` 提交绑定到当前 task 和 conflict ID 的 decision。
- `transfer_retry_failure` / `transfer_ignore_failure` 更新 aggregate task 中的一项 Direct file failure。
- `transfer_pause`、`transfer_resume` 和 `transfer_cancel` 控制 active task。
- `transfer_retry` 根据 failed 或 canceled task 创建新 task。
- `transfer_remove` 删除一条 terminal history entry。
- `terax://transfer-updated` 携带完整 task snapshot。
- `terax://transfer-removed` 删除被 pruning 或手动删除的 entry。

Rust manager 是唯一的 task-state authority。前端状态是 list result 和 event 的 projection。

## 验证矩阵

实现已在真实 Tauri Workspace 进程中针对本地 WSL 和已授权 Linux SSH host 进行验证：

- 通过 Direct 和 Archive 上传、下载嵌套目录、Unicode 名称和空文件
- 双向比较传输文件内容的 SHA-256
- 暂停和恢复 64 MiB Direct 传输
- 取消排队中和运行中的 task，并清理 staging
- 在不覆盖的前提下拒绝已存在 destination
- source 出现后重试 missing-source
- WSL destination-full 失败且不发布部分输出
- SSH 连接中断、有界失败收敛、重连 cleanup、retry 和最终 hash 验证
- SSH 畸形路径拒绝和 task-owned cleanup escape 拒绝

自动化测试锁定了 request limit、path boundary、source identity、archive validation、no-replace 与 transactional commit、目录 inode 保持、conflict precondition、staging ownership、scheduler reservation、Journal replay、history bound、结构化错误和前端 event convergence。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [双进程模型](two-process-model.md) - IPC 所有权和 command 目录
- [安全模型](security-model.md) - Workspace 和文件系统边界
- [测试](../contributing/testing.md) - 必需的质量检查和核心子系统测试
