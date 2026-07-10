# Remote SSH 稳定化与独立开发计划

更新日期：2026-07-10
目标仓库：`D:\project\terax`（分支 `remote-ssh`）
迁移基线：`ce96f28 feat: add remote SSH workspace foundation`

## 1. 本轮结论与范围

上一轮已经建立 Remote SSH 的主体架构，但代码审阅确认它还不能视为可独立维护的完成版本。当前最严重的问题是终端启动方式和退出语义错误：客户端伪装成 OpenSSH，服务端因此发送 `eow@openssh.com`；终端又以 `exec` 启动登录 shell，channel 结束后前端把最后一个终端退出解释为关闭窗口。

本轮只支持以下明确范围：

- 远程主机：Linux。
- 登录 shell：bash，远端必须存在 `/bin/bash`。
- `rootPath`：工作区初始目录，默认 `~`，连接后解析为远端用户 HOME 的规范绝对路径。
- `rootPath` 约束 Explorer、编辑器、搜索、Git 和 AI 的默认项目范围，但不是 SSH 安全沙箱；终端仍可正常 `cd` 到其他目录。
- 一个应用窗口内切换 Local / WSL / SSH。多窗口隔离继续排除。
- 断线后不承诺恢复远端进程；推荐 tmux/screen，但 UI 不得因断线而闪退，并且必须给出可重新启动终端的路径。

非 Linux、非 bash、Remote LSP、Jump Host/ProxyJump、通用 MFA、断点续传和多窗口不属于本轮。

## 2. 三个参考项目的固定基线

本轮以本地干净仓库的下列提交为迁移核对依据，完成后 Terax 不再需要它们参与构建或运行：

| 项目 | 本地路径 | 提交 | 本轮采用重点 |
| --- | --- | --- | --- |
| CrabPort | `D:\opensource\CrabPort` | `8666047ebd6e72bd1ee9b04b08204f114a818361` | manager/session 边界、SFTP 失效重建、代理与三类隧道生命周期 |
| Eussh | `D:\opensource\eussh` | `43174993bed3b4f81d65c75aba3139beaecb5dac` | `request_shell` 终端、Tauri 桥接、Host Key 交互 |
| meatshell | `D:\opensource\meatshell` | `8c5eeef7b4f0326644606aef3c5a89bfec342455` | 新连接认证回退、OpenSSH config、known_hosts、传输与 forwarding 边界 |

迁移原则：只迁移 Terax 当前范围需要的行为，不复制 GPUI/Vue/Slint UI，不迁移 Telnet、Serial、XMODEM 或商业终端功能。

## 3. 已完成的迁移基线

- [x] SSH profile、系统凭据、Host Key TOFU、密码/私钥/Agent 认证。
- [x] SOCKS5、HTTP CONNECT、HTTPS CONNECT 出站代理。
- [x] SSH Workspace、PTY、文件树、编辑器、Shell、Git 和 AI 路由。
- [x] SFTP CRUD、上传/下载和远程轮询。
- [x] Local、Remote、Dynamic 三类隧道。
- [x] React 登录/profile/Host Key/隧道界面。
- [x] 第三方许可证与来源说明。
- [x] 将上一轮工作区完整提交为可回退基线 `ce96f28`。

这些勾选项表示能力入口已经存在，不表示本轮稳定化验收已经通过。

## 4. 本轮修复清单

### 4.1 SSH 连接、认证与工作区根目录

- [x] 删除伪造的 OpenSSH client banner，使用 russh 的真实客户端标识，避免错误协商 OpenSSH 私有扩展。
- [x] 密码认证失败后，用全新 SSH transport 执行 keyboard-interactive 回退，避免复用被服务端拒绝后的 handle。
- [x] 连接时验证 Linux 与 `/bin/bash`，不满足时返回明确的不支持错误。
- [x] 可靠探测远端 HOME；命令失败、超时或空输出都不能静默采用猜测值。
- [x] 将空值、`~`、`$HOME`、`${HOME}` 解析为 HOME，并通过 SFTP canonicalize/stat 验证 `rootPath` 是可访问目录。
- [x] 替换连接失败时保留仍然可用的旧连接和 Connected 状态，不把可用 workspace 错报为 Error。

验收：有效 Linux/bash 主机能连接到规范 root；无效 root、非 bash 或探测失败有可理解错误；认证回退不挂起。

### 4.2 终端与重连

- [x] 初始登录终端使用 PTY + `request_shell`，与三个参考项目一致，不再用环境变量拼接登录 shell。
- [x] 非初始 cwd 只按 Linux/bash 范围使用安全 quoting，并显式启动 `/bin/bash --login`。
- [x] 处理 ExitStatus、ExitSignal、EOF、Close 和 transport error，区分正常 `exit` 与连接中断。
- [x] 连接中断不得触发最后一个 pane/tab 自动关闭应用；终端显示断线原因并允许重连后重新启动。
- [x] 手动重连和自动重连按 profile 串行化，不让失败替换破坏仍可用连接；隧道只在新 transport 就绪后恢复。
- [x] 终端输入采用有界背压，resize 只保留最新值，关闭后的写入能快速失败。

验收：登录后不闪退；`eow@openssh.com` 不再由伪装 banner 触发；正常执行 `exit` 仍按既有 UI 语义关闭终端；断网只终止对应远端会话并保留窗口。

### 4.3 SFTP 与传输完整性

- [x] SFTP channel 失败后淘汰缓存；只读操作自动重建并重试一次，不永久复用坏 session。
- [x] 编辑器保存改为同目录临时文件写入、flush/fsync 后由 Linux `mv -f` 原子替换，断线不能先截断原文件。
- [x] 上传和下载默认拒绝覆盖现有目标，并为目录内重名、Windows 保留名和清理后重名返回明确错误。
- [x] 单文件上传/下载改为流式复制，不把整个文件读入内存；高级进度、取消和断点续传继续排除。
- [x] 符号链接传输返回明确的不支持错误，不静默跳过或递归到不可预期位置。
- [x] 递归操作继续拒绝空路径、`/`、`.`、`..` 和危险规范化结果。

验收：模拟失效 session 后下一次操作可恢复；中断保存不损坏旧文件；大文件传输内存占用不随文件大小线性增长；覆盖必须显式失败。

### 4.4 主线程、搜索与编辑器轮询

- [x] 所有可能等待 SSH/SFTP/Git/远程 shell 的 Tauri command 改为 async 或放入 blocking worker，禁止阻塞应用主线程。
- [x] 远程内容搜索优先在主机执行 `rg --json`，结果有严格上限；远端没有 rg 时再使用有上限的 SFTP fallback。
- [x] 远程文件 glob 优先使用远端 `rg --files`，避免逐文件下载。
- [x] 编辑器轮询先 stat，比对 mtime/size 后才读取内容，不再每 3 秒下载整个文件。
- [x] 可见目录轮询、编辑器 reload 和交互搜索丢弃过期结果，切换 workspace 后旧请求不能覆盖新状态。

验收：慢网络下窗口仍可响应；未变化的打开文件只产生 stat；大型项目搜索不会串行下载数万文件内容。

### 4.5 独立维护、测试与文档

- [x] 按上述三个固定提交逐项复核认证、terminal、SFTP、proxy、tunnel、Host Key 和 config 行为，记录采用或明确排除的差异。
- [x] 为 client banner、rootPath 展开、认证回退决策、终端退出分类、SFTP 重建判定/安全路径和远程 rg 解析增加 Rust 单元测试。
- [x] 为断线退出分类、stat-first 指纹判断和 workspace/tree 过期请求判断增加前端测试。
- [x] 更新 `THIRD_PARTY_NOTICES.md`，写入三个参考提交 SHA 和实际采用范围。
- [x] 不把任何本地参考项目路径写入生产代码、构建脚本或运行配置。

验收：移走三个参考目录后 Terax 仍可构建、测试和运行；后续开发只依赖本仓库文档、测试和实现。

## 5. 验证矩阵

自动检查：

- `pnpm check-types`
- `pnpm test -- --run`
- `pnpm build`
- `pnpm lint`，要求 0 error；既有 warning 单独记录。
- `cargo test --all-targets --locked`；Windows 无符号链接权限的既有用例单独记录。
- `cargo clippy --all-targets --locked -- -D warnings`；若仍被既有 warning 阻塞，必须准确记录文件与行号，不得写成通过。
- `cargo fmt --all -- --check`；既有未格式化文件与本轮新增问题分开记录。
- `git diff --check`

本轮结果：

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm check-types` | 通过 | TypeScript 无类型错误。 |
| `pnpm test -- --run` | 通过 | 44 个测试文件、303 个测试通过。 |
| `pnpm build` | 通过 | 前端生产构建完成。 |
| `pnpm lint` | 通过，有既有告警 | 0 error、98 warning、1 info；本轮修改的前端文件没有新增告警。 |
| 过滤 Windows symlink 权限用例的 `cargo test --all-targets --locked` | 通过 | 196 个库测试、25 个文件系统集成测试、27 个 Git 集成测试通过。 |
| 未过滤的 `cargo test --locked --lib` | 环境限制 | 196 项通过；唯一失败仍是 Windows OS error 1314，当前账户没有创建测试 symlink 的权限。 |
| `cargo clippy --all-targets --locked -- -D warnings` | 通过 | 已消除原有 Windows `window` unused warning。 |
| 本轮 Rust 文件的 `rustfmt --check` | 通过 | 使用 `skip_children=true` 只检查本轮文件。 |
| `cargo fmt --all -- --check` | 既有失败 | 仍报告与本轮无关的既有 Rust 文件和测试格式差异，未扩大修改范围。 |
| `git diff --check` | 通过 | 无空白错误。 |

真实 Linux/OpenSSH 手工矩阵：

- 密码登录，`rootPath` 留空和 `~`。
- 私钥与 Agent 登录。
- 密码被拒后 keyboard-interactive 回退。
- 首次 Host Key、记住 Host Key、Host Key 变化。
- 新建多个终端、resize、正常 exit、服务端断开和本地断网。
- 文件树、打开/保存、重命名、删除、流式上传/下载、冲突拒绝。
- Git、AI shell、后台 shell、搜索和三类隧道。

若当前环境没有可用测试主机，必须将真实主机矩阵保留为未完成，不能用 mock 测试替代后宣称端到端通过。

## 6. 执行记录

- [x] 2026-07-10：审阅上一轮 Git diff、关键调用链和三个参考项目。
- [x] 2026-07-10：定位闪退链路为伪造 OpenSSH banner、exec shell 与前端最后终端退出策略的组合问题。
- [x] 2026-07-10：完成基线自动检查；前端测试 299 项通过，Rust 除既有 Windows symlink 权限用例外通过。
- [x] 2026-07-10：提交上一轮基线 `ce96f28`。
- [x] 2026-07-10：按 Linux/bash、`rootPath=~` 的最终约束重写本计划。
- [x] 2026-07-10：完成 SSH/terminal/reconnect、SFTP 完整性、async command、远端搜索与轮询修复。
- [x] 2026-07-10：完成针对性测试、自动验证并回填准确结果。
- [x] 2026-07-10：确认当前机器未安装 Docker 和 sshd，没有可用 Linux/OpenSSH 测试端；真实主机矩阵保留为待用户环境验证，不宣称端到端通过。

## 7. 本轮明确不做

- 多窗口与每窗口独立 Remote Workspace 生命周期。
- Remote LSP/server installation。
- Telnet、Serial、XMODEM 和终端宏。
- 完整 OpenSSH `Include`、`Match`、`ProxyJump` 语义。
- 通用 OTP/MFA 逐提示 UI。
- 断线后透明恢复远端进程。
- 带进度 UI、取消、限速和断点续传的高级传输管理器。
