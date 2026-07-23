# 文件传输分支计划

## 分支目标

为 WSL 和 SSH Workspace 建立统一、可靠且不阻塞终端与 Explorer 的后台文件传输内核。先完成领域边界、调度、数据面和安全提交，再在同一任务模型上增加由用户显式选择的 Archive、中断恢复和文件夹同步。

本文件是当前分支的临时执行账本。每个后续提交登记前一个实现提交的哈希、完成内容、验证结果和计划偏差。全部目标完成后删除本文件，再合并到主分支。

本次重构同时完成三个参考项目中与 Terax 目标相关的能力吸收。完成时所有采用或拒绝的能力均有明确记录，源码、依赖、测试和构建脚本不读取参考项目目录；即使手动移除三个参考项目，Terax 也能继续独立开发。

## 成功标准与关键不变量

- Rust 是任务、调度、文件系统操作和最终状态的唯一事实来源。
- 所有 Host、WSL 与 SSH 之间的跨环境传输只能进入 `TransferManager`，不保留平行 IPC 或兼容入口。
- Workspace 环境由进程启动上下文确定，前端任务参数不能指定或切换 SSH profile。
- Explorer 使用缓存 SFTP 会话；传输的扫描、复制、提交和清理全部使用任务独占会话。
- Task、Scheduler、Planner、Transport、Committer 和 Progress 的职责分离，Tauri command 保持为薄适配层。
- Direct 与 Archive 使用独立 IPC 入口，由用户在前端显式选择；两种策略复用同一任务生命周期、Manifest、调度、提交和 UI 状态。
- 不根据文件数、平均大小、远端空间或经验阈值自动选择策略。Archive 不可用时明确失败，不静默回退 Direct。
- 暂停的排队任务不占用运行许可；取消必须唤醒排队和暂停任务。
- 同一进程内先 reservation 最终目标，禁止多个任务为同一目标重复传输。
- 最终提交不覆盖已有目标；已提交的顶层目标不做破坏性批量回滚，失败任务明确保留已成功提交的项目。
- 符号链接、特殊文件、路径逃逸和递归复制必须在数据写入前拒绝。
- 未启用的策略不启动进程、不扫描目录，也不增加常驻资源。

## 最终架构

```text
transfers/
  commands.rs       Tauri command 薄适配层
  models.rs         IPC 请求、任务快照和领域枚举
  manager.rs        任务事实状态、控制命令和事件发布
  scheduler.rs      排队、公平调度、并发许可和目标 reservation
  planner.rs        来源扫描、名称映射、边界校验和通用 manifest
  progress.rs       进度聚合、速度采样和单调 updatedAt
  commit.rs         staging、no-replace 提交和任务所有权清理
  direct.rs         Direct 策略入口
  archive.rs        Archive 策略入口
  local.rs          Host 与 WSL Direct 数据面
  ssh/
    mod.rs           SSH 执行策略入口
    session.rs       任务独占 SFTP channel
    direct.rs        Direct 流水线读写
    archive.rs       Archive 打包、传输和安全解包
```

实现时允许合并职责过薄的文件，不为目录结构本身增加抽象。Local/WSL 与 SSH 优先使用 enum dispatch，不引入只为动态分发服务的运行时依赖。

## 外部代码吸收矩阵

### meatshell `d4246a9`

- 吸收独立 raw SFTP channel、有界 inflight 下载、按 offset 写入、取消后排空在途请求和部分目标清理。
- 保留 Terax 自有 Workspace、任务、staging 和事件协议。
- 不吸收巨型 command loop、直接写最终目标、不可取消的文件夹传输和 UI 状态代码。

### CrabPort `1d66518`

- 吸收本地 tar.gz 构建、gzip 完整性验证、远端工具探测和 Archive 阶段。
- Archive 仅在用户明确选择时探测并执行；远端不支持时返回明确错误，由用户决定是否改用 Direct。
- 不吸收已因 seek/read 数据损坏而停用的 segmented download，也不采用其缓存 SFTP 会话所有权模型。

### eussh `4317499`

- 参考与 Terax 相近的 russh 0.61 exec channel，用于后续 tar 流和远端能力探测。
- 不吸收整文件或归档进入 `Vec<u8>`、大块 IPC、高频进度事件和直接 `cat > target` 的实现。

### 吸收完成结论

- meatshell 的独占 raw SFTP、有界 offset 下载、取消排空和高延迟写入思路已经进入 Direct 数据面。
- CrabPort 的本地 tar.gz、gzip 完整性验证、远端工具探测和 Archive 阶段已经按 Terax Manifest 与提交协议重写。
- eussh 的独立 exec channel 思路由现有 `RemoteWorkspace::exec` 和 Archive 可暂停、可取消命令 channel 覆盖。
- 未采用的整文件缓冲、直接写最终目标、缓存传输会话、自动回退和不安全解包均保持排除。
- 静态扫描确认 Terax 源码、依赖、测试和构建脚本不含三个本地参考目录路径，参考项目可以手动移除。

许可证与第三方声明在全部代码吸收完成后统一核对和补充，当前阶段只记录来源提交和采用范围。

## 里程碑

### M1 架构收口

- [x] 拆分 Direct 的计划、Local、SSH 和提交职责。
- [x] 建立显式 Scheduler，修复暂停任务占用队列许可。
- [x] 建立进程内目标 reservation。
- [x] 传输复制和清理始终使用任务独占 SSH 会话。
- [x] 删除旧 `ssh_upload`、`ssh_download`、前端兼容 API 和远端 `fs_copy` 分支。
- [x] 补充本地执行器、调度、冲突和回滚测试。

### M2 Direct 数据面

- [x] SSH 下载使用有界 raw SFTP 流水线。
- [x] SSH 上传复用 russh-sftp 2.3 的有界并发写入并验证关闭结果。
- [x] 保留文件权限和修改时间等基础元数据。
- [ ] 建立高延迟和大文件基准。

### M3 Archive 策略

- [x] 增加独立 `transfer_enqueue_direct`、`transfer_enqueue_archive`，移除含糊的通用入队入口。
- [x] Planner 生成与策略无关的通用 Manifest，Direct 与 Archive 复用安全校验、reservation 和提交。
- [x] 前端明确提供 Direct 与 Archive 操作；拖放默认 Direct，不弹出策略选择。
- [x] 上传使用本地安全打包、单流上传、远端校验解包和最终提交。
- [x] 下载使用远端安全打包、单流下载、本地校验解包和最终提交。
- [x] 拒绝归档绝对路径、父目录遍历、符号链接、硬链接和特殊文件。
- [x] Archive 不可用时明确失败并提示改用 Direct，不自动回退。
- [x] 静态确认源码、依赖、测试和构建脚本不读取三个参考项目目录。

### M4 功能完善

- [ ] 增加结构化错误码和完整前端翻译。
- [ ] 增加冲突策略、失败重试、任务和历史上限。
- [ ] 增加可选完整性哈希。
- [ ] 增加 journal、异常退出清理和可验证续传。
- [ ] 根据明确需求再实现文件夹同步和双栏文件管理。

### M5 最终验证

- [x] `pnpm lint`
- [x] `pnpm check-types`
- [x] `pnpm test`
- [x] `cargo clippy --all-targets --locked -- -D warnings`
- [x] `cargo nextest run --locked` 或 `cargo test --all-targets --locked`
- [ ] 真实 WSL、局域网 SSH、高延迟 SSH、连接中断和磁盘空间不足验证。
- [ ] 核对并补充外部代码许可证和声明。
- [ ] 将长期架构结论同步到 `AGENTS.md` 或 `docs/architecture/`。
- [ ] 删除 `plan.md` 后合并到主分支。

## 提交记录

| Commit | 里程碑 | 完成内容 | 验证 | 偏差与后续 |
| --- | --- | --- | --- | --- |
| `355eea8` | 初始基础 | 增加进程内任务、Direct 传输、staging、状态栏面板和 Explorer 入口 | 提交记录声明前后端完整检查通过 | 架构尚未收口，旧入口仍可绕过管理器，提交和回滚存在竞争窗口 |
| `5bd9678` | M1、M2 Direct | 收口 Manager、Scheduler、Planner、Progress、Commit、Local 和 SSH 边界；增加目标 reservation、原生 no-replace 提交、任务独占会话与有界 SFTP 流水线 | 前端 97 个文件 564 项测试通过；Rust 260 项库测试及集成测试通过；Clippy 通过 | nextest 未安装，使用 `cargo test --all-targets --locked`；尚未保留元数据或建立真实网络基准 |
| `6323818` | M2 Direct | 保留跨 Host、WSL 与 SSH 可移植的权限、只读状态和时间元数据，并在复制后复验来源 | Rust 262 项库测试及集成测试通过；Clippy、格式检查通过 | 不复制 uid、gid、ACL、扩展属性和平台专有标志 |
| `9e2a8f0` | M3 设计 | 改为用户显式选择 Direct 或 Archive，删除自动阈值选择和隐式回退计划；定义参考项目可移除标准 | 文档变更，未运行代码检查 | Archive 首期只用于 SSH；WSL 保持 Direct，后续依据实测需求决定是否扩展 |
| `d49fb9d` | M3 Archive | 增加独立 Direct/Archive IPC、通用 Manifest、手动策略菜单、本地安全归档、单流 SFTP、远端能力探测、暂停取消、受控解包和统一提交 | 前端 97 个文件 564 项测试通过；Rust 267 项库测试及全部集成测试通过；Clippy、格式检查通过 | 未做真实 SSH 运行验证；远端需要 Linux、bash、tar、gzip，Archive 不可用时明确提示使用 Direct |
