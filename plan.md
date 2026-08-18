# SSH 远程文件性能与可选 Python 加速器实施计划

## 背景与目标

高延迟 SSH 连接会把每个串行协议阶段放大。当前目录读取、SFTP 预热和部分写入阶段已经并发，但普通文件读取仍受单 handle 串行 `READ` 限制，条件写入仍包含规范化、元数据、临时文件、耐久刷新、关闭、提交和最终元数据等多个依赖阶段。

本次改动需要在保持 Local、WSL 和现有 SSH 功能的前提下完成以下目标：

1. 建立稳定的 SSH 文件内容服务边界，使 Tauri command、编辑器和 AI 不依赖具体远程后端。
2. 优化默认 SFTP 后端，使没有 Python 的服务器也获得读取和写入性能提升。
3. 增加不落盘的可选 Python 远端任务后端，首期将高 RTT 条件写入压缩为一次远端业务调用，后续可扩展封闭的批量文件任务。
4. Python 缺失、版本不支持、启动失败或运行异常时安全回退 SFTP。
5. 在 SSH 状态栏显示当前文件后端和回退状态，不与本地 Python 解释器状态混淆。

## 实施状态

- [x] 建立 SSH 文件服务 façade，Local、WSL 和 Tauri command 契约保持不变。
- [x] 将普通文件正文改为 8 路 raw SFTP offset 读取流水线。
- [x] 在远端提交命令中返回最终 metadata，并保留不支持 stat 时的 SFTP 回退。
- [x] 接入不落盘的一次性 Python helper、长度前缀协议和单槽预开 channel。
- [x] 实现 Auto/Off 共享设置、按 epoch capability、失败回退和状态栏 I/O 标记。
- [x] 更新架构、安全、测试文档和项目权威约束。
- [x] 完成前端完整测试、类型检查、Python helper 测试和 Rust clippy。
- [x] 在 215 ms RTT 的真实 SSH Workspace 验证 Python、SFTP、设置切换、状态栏与条件写入。
- [ ] Rust 测试二进制在当前 Windows 环境运行时被 `STATUS_ENTRYPOINT_NOT_FOUND` 阻止；同一构建的真实 Tauri 应用可以正常启动和完成 SSH 验证。

双服务器标准基准确认采用操作级选择。219 至 314 ms RTT 下，64 KiB 读取中位数为 SFTP 2080 ms、Python 2154 ms，Python 慢 3.6%；条件写入中位数为 SFTP 2742 ms、Python 502 ms，Python 降低 81.7%。5 ms RTT 下，64 KiB 读取中位数为 SFTP 29 ms、Python 516 ms，1 MiB 读取为 SFTP 885 ms、Python 969 ms，条件写入为 SFTP 483 ms、Python 484 ms。低延迟连接并发启动时曾出现 70 ms 短时样本，因此读取固定使用 SFTP，条件写入使用保守的 100 ms RTT 阈值，避免抖动误启用。

## 核心约束

- Python 加速器不是 SSH 连接、目录浏览、Git、搜索或批量传输的新依赖。
- 不在服务器上安装或持久化 helper 文件。仓库内 Python 源码由 Rust `include_str!` 编译，并通过 `python3 -I -u -c` 启动。
- 未启用或不可用的 Python 加速器不得保留进程、channel、定时器或额外轮询。
- 远程路径、读取上限、秘密路径、版本冲突、权限保留、耐久刷新和原子发布语义不得弱化。
- 写入回退必须处理提交结果不明确的情况，不能在 helper 可能已经提交后盲目覆盖。
- 所有状态都绑定当前 `RemoteWorkspace` epoch，重连后不得复用旧 helper、channel 或迟到事件。
- 不新增远程代码执行的通用入口。Python 协议只接受封闭、版本化且有资源上限的单文件或批量任务类型。
- 新增或修改的 Rust、TypeScript 和 TSX 文件遵守中文文件级及重要项注释规范。

## 目标架构

```text
fs/file.rs
  |-- Local 与 WSL 现有实现
  `-- SSH
       `-- remote/file_service.rs
            |-- SFTP 默认后端
            `-- Python 可选高 RTT 写入与未来批量任务后端

RemoteWorkspace
  |-- SSH transport
  |-- RemoteFs SFTP 资源
  `-- Python capability、预开 channel 与 epoch 状态
```

`fs/file.rs` 继续负责 Tauri command、Local/WSL/SSH 分流和公共序列化结果。`remote/file_service.rs` 负责 SSH 文件内容操作、后端选择、阶段计时、回退和结果归一化。`remote/sftp.rs` 只实现 SFTP 传输与当前原子写入细节。Python helper 只实现与文件服务契约对应的复合操作。

## 文件服务契约

文件服务操作范围：

- `read_snapshot`：有界读取内容和元数据。
- `read_version`：不传输正文地获得稳定版本。
- `write_checked`：匹配旧版本后原子提交。
- `write_missing`：目标仍缺失时原子创建。
- `write_overwrite`：调用方明确允许时覆盖。

公共内部结果保持后端无关：

- 读取正文或 TooLarge。
- SHA-256 revision、size 和 mtime。
- Written 或 Conflict。
- 明确的不可用、业务失败、transport 失败和结果不明确状态。

Rust 负责计算和校验 replacement revision。Python helper 不决定调用方期望版本，不返回可被直接信任的任意命令或路径。

## 阶段一：建立边界

### 实现

1. 新增 `src-tauri/src/modules/remote/file_service.rs`。
2. 将 `fs/file.rs` 中 SSH 内容读取、版本读取和三种写入路由到文件服务。
3. 第一阶段文件服务只调用现有 SFTP 实现，不改变 Tauri command 和前端调用。
4. 保持目录、普通 stat、canonicalize、Git、Markdown、搜索和传输对 SFTP primitive 的现有使用。
5. 在服务边界加入不记录路径或内容的阶段计时结构，为后续对比保留一致指标。

### 验证

- 现有 Rust 文件读取与写入测试通过。
- 新增契约测试锁定 SFTP 映射结果。
- `cargo clippy --all-targets --locked -- -D warnings` 通过。
- 重构前后 Tauri 序列化结构不变。

## 阶段二：优化默认 SFTP

### 读取

1. 为已知文件大小规划固定 offset 和 length 的读取块。
2. 使用 raw SFTP 请求在同一 handle 上维持有上限的 in-flight `READ`。
3. 默认并发度与现有写入保持同级，初始为 8，并以服务端 limits 和内存上限约束。
4. 响应可乱序到达，最终必须按 offset 组装。
5. 拒绝重叠、缺失、超长、提前 EOF 和超出声明大小的响应。
6. 失败后使失效 session 收敛到现有重建逻辑，不静默返回部分内容。

### 写入

1. 远端提交命令同时返回提交状态和最终 mtime，删除成功后的额外 metadata 请求。
2. 保留 SFTP 写请求流水线、一次 fsync、显式 close、权限恢复和同目录原子发布。
3. Conflict 和 Missing 分支只在 UI 确实需要时读取当前元数据。
4. 记录 resolve、metadata、open、upload、fsync、close、commit 和 reconcile 阶段耗时。

### 验证

- 读取块规划和乱序组装纯函数测试。
- 0 字节、边界块、超过单包、超过八包和最大允许文件测试。
- 写入成功、冲突、收敛、缺失创建、权限保留和提交输出解析测试。
- 在 200 ms RTT 环境分别记录冷、热和不同文件大小的 p50 与 p95。

## 阶段三：Python 远端任务加速器

### Capability 与启动

1. 在现有 Workspace probe 中附带 `python3` 可用性和版本，不增加独立探测往返。
2. 每个 `RemoteWorkspace` 创建独立 `RemoteFileRuntime`。
3. 仅在策略为 Auto、capability 可用且已有 RTT 样本不低于 100 ms 时后台预开一个 session channel。
4. helper 源码保存在仓库内并通过 `include_str!` 编译，不写入远端磁盘。
5. 使用 `python3 -I -u -c`，请求通过 stdin，响应通过 stdout，stderr 只提供有界诊断。
6. helper 每次只处理一个请求并退出，不实现常驻 RPC、多路复用或远端 daemon。

首期 Python 后端只启用条件写入，读取仍由 raw SFTP 流水线处理。后续功能需要批量 stat、批量读取、目录摘要、批量条件提交或其他可合并任务时，应在同一版本化协议中新增明确 operation 和独立资源预算，不得退化为传入任意 Python、Shell 或命令字符串。若单次启动无法满足未来批量吞吐，再以基准数据评估有界 worker，而不是预先引入常驻 daemon。

### 协议

1. 使用版本化、长度前缀的封闭帧，正文不使用 Base64。
2. 请求包含操作类型、路径、大小限制、写入条件和正文长度。
3. 响应包含协议版本、业务状态、规范路径、版本、正文长度和稳定错误码。
4. Rust 在分配内存和读取正文前校验所有长度。
5. Python 仅允许绝对无控制字符路径，并在打开或提交前重新解析物理目标。

### 文件语义

- 条件写入先写同目录排他临时文件，恢复权限并 fsync，再在提交前校验旧摘要。
- Match 在当前摘要等于 replacement 时收敛为 Written。
- Missing 使用 no-clobber 发布，响应丢失后通过 replacement revision 收敛结果。
- Overwrite 仍由调用方显式声明。
- helper 关闭、超时或协议错误后清理临时文件；无法确认提交结果时进入 reconcile，不直接覆盖。

### 回退

- Python 不可用或 helper 尚未 dispatch：立即使用 SFTP。
- Conflict、TooLarge、NotFound 等业务结果：直接返回，不触发后端回退。
- 写入结果不明确：先读取当前版本；等于 replacement 时返回 Written，等于 expected 时才允许重新提交，否则返回 Conflict。
- helper 初始化或协议版本失败后标记当前 epoch 为 unavailable，重连后重新探测。

### 验证

- Python helper 独立测试覆盖 Match、Missing、Overwrite、权限、fsync 和协议拒绝。
- Rust 协议测试覆盖截断帧、超长字段、错误版本、错误正文长度和无效状态。
- 后端契约测试对 SFTP 与 Python 使用同一组业务用例。
- 覆盖 Python 缺失、启动失败、执行中断、响应丢失、重连和旧 epoch 事件。

## 阶段四：设置与状态栏

### 设置

新增 SSH 文件加速策略：

- `auto`：读取使用 SFTP；Python 可用且 RTT 不低于 100 ms 时加速条件写入，其他情况使用 SFTP。
- `off`：始终使用 SFTP，不探测、不预开 channel、不启动 Python。

不提供强制 Python 模式。设置使用既有共享设置白名单，不新增 localStorage 状态。

### 状态模型

Rust 暴露绑定 epoch 的权威快照：

- capability：detecting、available、unavailable。
- active backend：sftp、python。
- Python 版本。
- 是否从 Python 回退。
- 稳定且可翻译的状态原因，不向前端发送路径、命令或 stderr 原文。

提供独立 snapshot command 和事件，前端先监听再读取快照，并丢弃旧 epoch 状态。

### 状态栏

将现有 SSH RTT 指示器扩展为综合 SSH 状态：

- Python 正在加速高 RTT 写入时，在 RTT 后显示紧凑快速 I/O 标记。
- capability 可用但设置关闭时显示弱化标记。
- Python 运行失败并回退时显示警告色标记。
- Python 不可用且处于 Auto 时保持普通 RTT 外观，不制造持续告警。
- tooltip 展示 RTT、当前文件后端、远端 Python 版本、策略和回退状态。

所有文本同步更新英文和简体中文资源。

## 文档与验证

更新：

- `docs/architecture/two-process-model.md`
- `docs/architecture/security-model.md`
- 必要时更新 `docs/contributing/testing.md`

最终验证集：

1. `pnpm lint`
2. `pnpm check-types`
3. `pnpm test`
4. `cargo clippy --all-targets --locked -- -D warnings`
5. `cargo nextest run --locked`，不可用时运行 `cargo test --locked`
6. Python helper 测试
7. 真实 Tauri SSH Workspace 验证 SFTP、Python、回退、重连和状态栏事件
8. 200 ms RTT 环境的冷启动、热读取、小文件写入和大文件读取性能记录

## 完成标准

- 无 Python 的 SSH 服务器保持全部现有功能，并获得 SFTP 性能改进。
- Python 可用且策略为 Auto 时，受支持的文件操作使用一次远端业务调用。
- 任一 helper 故障不会绕过版本冲突、秘密路径、大小限制或原子写入约束。
- 状态栏准确显示当前实际后端，重连后不展示旧 epoch 状态。
- 未启用的加速器不消耗额外运行时资源。
- 所有必要静态检查、测试和文档同步完成。

## 性能选择基线

当前策略为 RTT 与操作联合选择：单文件读取固定走 SFTP，条件写入只在已有 RTT 样本不低于 100 ms 时启用 Python。没有 RTT 样本时先使用 SFTP，不为选择后端新增 ping、定时器或网络请求。阈值使用健康监督器的既有低频样本，并保留 Auto/Off 用户开关和故障回退。

未来每一种批量任务都必须单独比较低 RTT、高 RTT、不同载荷和不同批量大小，不能因为条件写入使用 Python 就默认选择 Python。只有结果稳定优于现有 SFTP 或 exec 实现时，才能加入 Auto 路由。
