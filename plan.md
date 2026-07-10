# Remote SSH 完整迁移执行记录

更新日期：2026-07-10  
目标仓库：`D:\project\terax`（分支 `remote-ssh`）

本文记录 `development_plan.md` 本轮合并执行的范围、参考项目盘点、实际迁移文件、接入点、验证结果和后续优化项。本轮按用户要求在当前窗口内切换 Local / WSL / SSH，不处理多窗口隔离。

## 1. 本轮范围与验收结果

- [x] 状态栏 `Workspace environment` 菜单保留 Windows Local / WSL，并新增 `Remote SSH`。
- [x] 点击 `Remote SSH` 打开登录与 profile 管理页面；登录成功后沿用现有 Workspace 切换流程切到 SSH。
- [x] 支持密码、私钥（含口令）、OpenSSH Agent / Pageant 认证，以及常见 password keyboard-interactive 回退。
- [x] 支持首次和变更 Host Key 提示、SHA-256 指纹展示、仅本次信任或写入 Terax `known_hosts`。
- [x] 支持 SSH profile 持久化、OpenSSH config 导入；SSH 密码/私钥口令和代理密码存入操作系统凭据库，不写入普通 profile JSON。
- [x] 支持 SOCKS5、HTTP CONNECT、HTTPS CONNECT 出站代理。
- [x] 支持连接状态、连接层 keepalive、手动断开/重连、失败重试和隧道重建。
- [x] 支持同一 SSH Workspace 下多个独立远程终端，复用现有 xterm 输入、输出、resize 和关闭桥接。
- [x] 支持 SFTP 文件树、读取、编辑保存、stat、canonicalize、新建、重命名、递归删除、递归上传和下载。
- [x] 支持 Local (`-L`)、Remote (`-R`) 和 Dynamic SOCKS (`-D`) 三类隧道的创建、查看、停止与断线重建。
- [x] 现有文件搜索、内容搜索、glob、Shell、持久 AI Shell、后台命令和 Git 操作按当前 `WorkspaceEnv` 路由到 SSH。
- [x] 远程 Explorer 和打开的编辑器文件使用轻量轮询补足 SFTP 无服务器推送 watcher 的差异。
- [x] 明确排除 Telnet、Serial、XMODEM、商业终端宏、GPUI/Vue/Slint UI 和多窗口工作区。
- [x] 三个参考仓库不再是 Terax 的构建或运行依赖；所需能力和许可证说明均已进入本仓库。

## 2. 三个本地参考项目盘点

### 2.1 CrabPort — `D:\opensource\CrabPort`

许可证：Apache-2.0。

已检查的结构与用途：

- `crabport-core`：主机、凭据、代理、隧道等领域模型。
- `crabport-ssh`：russh 客户端、认证、Host Key、会话、终端和连接监控。
- `crabport-sftp`：SFTP backend、文件操作及传输。
- `crabport-tunnel`：Local / Remote / Dynamic forwarding 生命周期。
- `crabport-proxy`：SOCKS/HTTP 等代理传输。
- `crabport-terminal`、`crabport-ui`、`crabport-telnet`：与 Terax 当前目标无关，未迁移。

采用内容：后端模块边界、连接/隧道生命周期、SFTP API 形状、代理连接实现思路。多 crate 结构已裁剪为 Terax 的单一 `remote` 模块。

### 2.2 Eussh — `D:\opensource\eussh`

许可证：MIT。

已检查的结构与用途：

- `src-tauri/src/ssh`：SSH manager、session 和 Host Key 交互。
- `src-tauri/src/terminal`：终端 manager/session。
- `src-tauri/src/commands`：连接、终端和文件命令边界。
- `src/components/connection`：登录和 Host Key 对话框流程。
- `src/composables/useXterm.js`：xterm 输入、输出、resize、关闭桥接。

采用内容：Tauri command/event 结构、russh channel 生命周期和终端桥接模式。Vue UI 未复制，改为 Terax React/Zustand 结构；事件终端数据改为 Terax 已有的 raw IPC channel。

### 2.3 meatshell — `D:\opensource\meatshell`

许可证声明：MIT OR Apache-2.0；本项目对适配内容采用 Apache-2.0 选项。

已检查的结构与用途：

- `src/ssh_config.rs`：OpenSSH config 导入。
- `src/known_hosts.rs`：known_hosts 匹配、首次信任和变更处理。
- `src/ssh.rs`：认证、keepalive、会话及连接参数。
- `src/sftp.rs`：目录读取、上传和下载。
- `src/forward.rs`：Local / Remote / Dynamic forwarding。
- `src/proxy.rs`：SOCKS5 / HTTP CONNECT 出站代理。
- `src/config.rs`：profile 与凭据模型。

采用内容：功能参数和边界细节。Slint UI、Telnet、Serial、XMODEM 等均未迁移。

## 3. 实际迁移/新增文件

### 3.1 Rust Remote Workspace 后端

- [x] `src-tauri/src/modules/remote/mod.rs`：模块出口。
- [x] `src-tauri/src/modules/remote/models.rs`：profile、认证、连接状态、代理和隧道 DTO；含基础解析测试。
- [x] `src-tauri/src/modules/remote/manager.rs`：共享 Remote Workspace、状态事件、keepalive 监控、重连和隧道恢复。
- [x] `src-tauri/src/modules/remote/session.rs`：SSH transport、认证、exec、Agent、keyboard-interactive 和远程 forwarding callback。
- [x] `src-tauri/src/modules/remote/host_key.rs`：TOFU 校验、变更告警、确认事件和 known_hosts 持久化。
- [x] `src-tauri/src/modules/remote/proxy.rs`：直连、SOCKS5、HTTP CONNECT、HTTPS CONNECT。
- [x] `src-tauri/src/modules/remote/terminal.rs`：独立远程 PTY channel 与 Terax raw IPC bridge。
- [x] `src-tauri/src/modules/remote/sftp.rs`：SFTP session、CRUD、遍历、上传/下载和安全边界。
- [x] `src-tauri/src/modules/remote/tunnel.rs`：Local / Remote / Dynamic forwarding 及状态/流量统计。
- [x] `src-tauri/src/modules/remote/ssh_config.rs`：`~/.ssh/config` 的 HostName/User/Port/IdentityFile 导入。
- [x] `src-tauri/src/modules/remote/commands.rs`：稳定的 Tauri command API。

### 3.2 Rust 现有能力接入

- [x] `src-tauri/Cargo.toml`、`Cargo.lock`：加入 russh、russh-sftp、代理、TLS、UUID 和 zeroize 依赖。
- [x] `src-tauri/src/modules/mod.rs`、`src-tauri/src/lib.rs`：注册 RemoteState 和全部 SSH commands。
- [x] `src-tauri/src/modules/workspace.rs`：`WorkspaceEnv::Ssh { profile_id }`，远程 home/cwd 语义。
- [x] `src-tauri/src/modules/pty/mod.rs`：远程终端沿用现有 PTY command 和 raw body 输入路径。
- [x] `src-tauri/src/modules/fs/{file,tree,mutate,search,grep,watch}.rs`：SFTP 文件、目录、搜索、上传和 watcher 差异处理。
- [x] `src-tauri/src/modules/shell/{mod,session}.rs`：远程一次性命令、持久 cwd、后台命令、日志和停止。
- [x] `src-tauri/src/modules/git/{process,utils,operations}.rs`：在远程工作区通过 SSH exec 调用远端 Git。
- [x] `src-tauri/src/modules/lsp/mod.rs`：保持已有“非 Local 暂不启动 LSP”的显式边界，防止误在宿主机读取远程路径。

### 3.3 React/Tauri 前端

- [x] `src/modules/remote/types.ts`：与 Rust command/event 对应的类型。
- [x] `src/modules/remote/native.ts`：invoke/listen、凭据库、传输和隧道桥接。
- [x] `src/modules/remote/store.ts`：profile 与连接状态持久化。
- [x] `src/modules/remote/RemoteSshDialog.tsx`：登录、profile、OpenSSH 导入和隧道管理页面。
- [x] `src/modules/remote/HostKeyDialog.tsx`：Host Key 确认与变更告警。
- [x] `src/modules/remote/index.ts`：模块出口。
- [x] `src/modules/workspace/{env,index}.ts`：Local / WSL / SSH 同级环境模型和 scope key。
- [x] `src/app/hooks/useWorkspaceSwitcher.ts`：SSH home 解析并沿用当前窗口切换/清理/重置流程。
- [x] `src/modules/statusbar/WorkspaceEnvSelector.tsx`：新增 Remote SSH 入口、状态点和重连入口。
- [x] `src/modules/explorer/FileExplorer.tsx`：上传本地路径、下载远程文件/目录入口。
- [x] `src/modules/explorer/lib/useFileTree.ts`：可见远程目录轻量轮询。
- [x] `src/modules/editor/lib/useDocument.ts`：打开的远程文件轮询和现有冲突保护。

### 3.4 许可证与来源

- [x] 新增 `THIRD_PARTY_NOTICES.md`，记录三项目来源、采用范围、修改方式和许可证。
- [x] 直接参考程度较高的 Rust 文件在模块注释中保留来源与修改说明。
- [x] Eussh MIT 许可证全文已保留；CrabPort 和 meatshell 采用的 Apache-2.0 条款由仓库根 `LICENSE` 提供。

## 4. 关键行为与安全边界

- profile 普通配置只保存地址、用户名、认证方式、私钥路径、根路径和连接参数。
- SSH 密码/私钥口令与代理密码使用现有 `secrets_*` 命令进入系统凭据库；后端内存副本使用 `Zeroizing<String>`。
- 代理 URL 禁止内嵌明文密码；用户名可写为 `http://user@proxy:port`，密码单独输入。
- Host Key 默认不静默接受；首次/变更均需用户确认，记住后保存完整 OpenSSH public key。
- 远程命令的 cwd 和参数使用 POSIX shell quoting；Git 禁用交互式 credential prompt。
- 文件读取有大小和二进制检测；符号链接目标仍执行实际读取上限。
- 递归删除拒绝 `/`、空路径以及包含 `.`/`..` 组件的路径，避免路径归一化后落到远程根目录。
- AI 继续使用原有敏感路径检查、canonicalize 二次检查、写入/命令审批和危险命令拦截；仅底层 Workspace 路由改为 SSH。
- SFTP 没有通用的服务器推送 watcher，因此只轮询当前可见目录和已打开文件，不全量扫描项目。

## 5. 验证记录

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `cargo check` | 通过 | 新增 Remote SSH 后端可编译；仅保留一个与本轮无关的既有 `window` unused warning。 |
| `pnpm check-types` | 通过 | WorkspaceEnv、Remote UI 和 invoke 类型通过。 |
| `pnpm test` | 通过 | 41 个测试文件、299 个测试通过。 |
| `pnpm build` | 通过 | 前端生产构建完成。 |
| `pnpm lint` | 通过（有既有 warning） | 0 error；仓库已有 102 个 warning，未作为本轮无关清理处理。 |
| `cargo test --all-targets -- --skip modules::workspace::auth_tests::authorize_spawn_cwd_blocks_symlink_escape` | 通过 | 188 个库测试、25 个文件系统集成测试、27 个 Git 集成测试通过；1 个宿主权限用例被过滤。 |
| `cargo clippy --all-targets` | 通过 | 仅保留一个与本轮无关的既有 `window` unused warning。 |
| 未跳过的 `cargo test --lib` | 环境限制 | 唯一失败是 Windows 账户缺少创建符号链接权限（OS error 1314）的既有 workspace 用例；已用排除该用例的全 target 测试确认其余全部通过。 |
| `git diff --check` | 通过 | 无空白或补丁格式错误。 |

## 6. 执行日志

- [x] 2026-07-10：读取 `development_plan.md`、仓库指导文件、目标分支和初始 Git 状态。
- [x] 2026-07-10：读取并盘点三个本地参考项目的结构、许可证、Cargo 元数据和 SSH/SFTP/Tunnel/Proxy/配置相关文件。
- [x] 2026-07-10：建立 `plan.md`，确定“CrabPort 后端边界 + Eussh Tauri 桥接 + meatshell 功能细节”的迁移路线。
- [x] 2026-07-10：迁移并裁剪 Rust SSH、SFTP、Proxy、Tunnel、Host Key、config 和 command 模块。
- [x] 2026-07-10：接入 WorkspaceEnv、PTY、FS、Shell、Git 和 AI 原生调用链。
- [x] 2026-07-10：实现 Remote SSH 登录/profile/tunnel 页面、状态栏入口、Host Key 页面和安全凭据存储。
- [x] 2026-07-10：补齐上传/下载、远程轮询、重连隧道恢复、keyboard-interactive 和代理凭据边界。
- [x] 2026-07-10：修复重连替换竞态、SFTP 符号链接读取上限和递归删除父级遍历风险。
- [x] 2026-07-10：补齐 `~` 私钥路径与远程 `$HOME`/`${HOME}` 工作区根路径展开，修正 remote-forward 端口映射歧义。
- [x] 2026-07-10：执行最终格式化、全 target 测试、Clippy、前端测试/构建和 diff 审计后完成交付。

## 7. 明确留给后续任务的优化

这些项目不阻塞本轮目标，但应在后续迭代继续优化：

- 多窗口和每窗口独立 Remote Workspace 生命周期（本轮按用户要求排除）。
- Remote LSP/server installation；当前与既有 WSL 相同，非 Local 明确禁用 LSP，避免错误回落宿主机。
- 大文件上传/下载改为分块流式传输、进度、取消、限速和断点续传；首版递归传输会按单文件缓冲。
- 更完整的 OpenSSH config 语义，例如 `Include`、`Match`、`ProxyJump` 和多级 Host 规则。
- MFA/OTP 的通用逐提示交互；当前 keyboard-interactive 只安全处理 password/passphrase 提示。
- 活跃隧道内连接的强制取消和更细的错误/流量事件。
- 远程后台任务日志轮转与真实退出码追踪。
- 真实 SSH 主机矩阵的端到端测试（OpenSSH 版本、认证方式、代理、三类隧道和断网恢复）。
- 断线后的终端进程不承诺透明恢复；继续建议使用 tmux/screen，符合 `development_plan.md` 的恢复语义。
