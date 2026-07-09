# 项目的最终目标形态

Terax 最终不是单纯的本地终端，也不是 Xshell/Xftp 替代品，而是一个：

> **支持 Local / WSL / SSH 多环境、多窗口隔离、带 AI 能力的远程开发工作台。**

更接近：

```text
VS Code Remote SSH + Terax AI Terminal / Workspace
```

而不是：

```text
普通 SSH 客户端
普通 SFTP 客户端
单窗口环境切换工具
```

---

## 1. 核心体验：一个环境就是一个独立工作台窗口

最终形态应该是：

```text
Window A: Local Windows Workspace
Window B: WSL Ubuntu Workspace
Window C: SSH prod-server Workspace
Window D: SSH dev-server Workspace
Window E: SSH prod-server Workspace 2
```

用户点击 WSL 或 SSH 时，默认不是把当前窗口切过去，而是：

```text
Open in New Window
```

当前 Windows 工作台继续保留，新开的 WSL/SSH 窗口是独立工作台。

每个窗口独立拥有：

```text
workspace env
文件树
编辑器 tabs
终端 tabs
spaces
AI 面板
状态栏
窗口标题
持久化状态
连接状态
```

---

## 2. SSH 是 Workspace 后端，不是一个 terminal 命令

最终 SSH 不应该只是打开一个终端执行：

```bash
ssh root@server
```

而应该作为和 Local / WSL 同级的 workspace backend：

```text
Local Workspace
  本地文件系统
  本地 PTY
  本地 shell

WSL Workspace
  WSL 文件系统
  wsl.exe PTY
  WSL shell

SSH Workspace
  SFTP 文件系统
  SSH PTY
  SSH exec
  SSH tunnel
  SSH keepalive
```

也就是说，SSH 在 Terax 里是：

```text
一个完整远程开发环境
```

而不是：

```text
一个终端连接
```

---

## 3. 用户进入 SSH window 后，感觉像在本机项目里开发

SSH window 的最终体验是：

```text
左侧能浏览服务器文件
中间能打开/编辑服务器文件
标签页能开远程终端
保存文件直接写回服务器
可以上传/下载文件
可以开 SSH 隧道访问远程服务
AI 后续也能读写远程项目
长时间不操作连接也尽量不断开
```

用户进入 SSH window 后，看到的是一个完整工作台，而不是一个裸 SSH shell。

---

## 4. SSH window 内部要有连接管理器和保活机制

你补充的 keepalive 需求非常关键。最终每个 SSH window 应该拥有自己的：

```text
RemoteWorkspaceSession
```

它负责管理：

```text
SSH connection / transport
keepalive
terminal channels
SFTP session
tunnel channels
exec channels
connection status
reconnect / degraded 状态
```

概念上是：

```text
SSH Window
  = 一个独立 RemoteWorkspaceSession
  = 一个远程工作台连接上下文

SSH Window 内部可以有多个 terminal tab：

  terminal tab 1
    独立 PTY
    独立 shell
    独立 cwd
    独立进程状态

  terminal tab 2
    独立 PTY
    独立 shell
    独立 cwd
    独立进程状态

  terminal tab 3
    独立 PTY
    独立 shell
    独立 cwd
    独立进程状态

这些 terminal tab 会话彼此独立：
  一个 tab 里 cd 不影响另一个 tab
  一个 tab 里运行 htop 不影响另一个 tab
  一个 tab 退出 shell 不影响其他 tab
  一个 tab 关闭不影响其他 tab

但它们可以共享同一个 SSH window 的底层连接管理：
  同一个 RemoteWorkspaceSession
  同一个 SSH transport
  同一个 keepalive
  同一个 SFTP/tunnel/connection status 管理
```

这样同一个 SSH window 里的：

```text
远程终端
SFTP 文件浏览
文件保存
上传下载
SSH 隧道
AI remote exec
```

都归属于同一套连接生命周期管理。

更准确的产品定义应该是：

```
一个 SSH window = 一个远程工作台会话
一个 terminal tab = 这个工作台里的一个独立远程 shell 会话

同一 SSH window 内：
  terminal tab 之间会话独立
  底层连接/keepalive/状态管理共享

不同 SSH window 之间：
  RemoteWorkspaceSession 完全独立
  SSH connection 完全独立
  keepalive 完全独立
  tabs/spaces/AI/tunnel 状态也完全独立
```



---

## 5. SSH keepalive 是窗口级基础能力

最终目标里，SSH window 应该默认启用 keepalive，用来解决类似于：

```text
powershell 里 ssh root@服务器，长时间不操作后连接自动断开
```

但实现上不应该往终端里自动输入命令、空格、回车，而应该做在 SSH 协议/transport 层。

最终行为是：

```text
SSH window 打开后
  connection manager 周期性发送 keepalive
  SSH/SFTP/tunnel 都受益
  长时间不操作也尽量维持连接
```

状态栏可以简单显示：

```text
SSH: prod · Connected
SSH: prod · Reconnecting...
SSH: prod · Disconnected
```

默认安静保活，只有失败、重连、断开时提示用户。

---

## 6. 同一个服务器可以打开多个 SSH window

最终不限制一个服务器只能一个窗口。

用户可以按需打开：

```text
SSH prod-server Window 1
SSH prod-server Window 2
SSH prod-server Window 3
```

每个 window 默认独立：

```text
独立连接
独立 keepalive
独立 tabs
独立文件树状态
独立终端
独立隧道
独立 AI 上下文
```

这样最简单、最可靠，也更接近 VS Code 的使用方式。

后续可以做增强：

```text
检测已有相同 profile 窗口
提示 Open Existing / Open New Window
```

但默认能力应该允许用户按需新建多个 SSH window。

---

## 7. 断线恢复策略要符合真实语义

最终产品里可以有自动重连，但不同能力的恢复方式不同。

### SFTP

可以自动重连并重试：

```text
read_dir / read_file / write_file 失败
检测到连接断开
重连
重试一次
```

### SSH tunnel

可以尝试自动重建：

```text
Tunnel disconnected
Reconnecting...
Reconnected
```

失败时提示端口占用或连接失败。

### Terminal

不要假装能无缝恢复。

SSH terminal 断线后，远端 shell 里的进程可能已经结束。除非用户自己用了 tmux/screen，否则不能透明恢复。

更合理的体验是：

```text
Connection lost.
Reconnect to start a new terminal.
```

或者：

```text
Reconnect
Reconnect and open new terminal
```

---

## 8. AI 最终也要进入远程工作区

Terax 的差异化不只是 SSH/SFTP，而是 AI。

最终 SSH window 里的 AI 应该能：

```text
读取远程项目文件
解释远程代码
执行远程命令
修改远程文件
查看 git diff
辅助调试远程服务
通过 tunnel 打开的服务进行辅助分析
```

也就是：

```text
AI 不只是看本地文件
AI 能操作当前 SSH workspace
```

但这个应该放在后期，先保证：

```text
SSH window
SSH keepalive
terminal
SFTP
editor
tunnel
```

稳定之后再接 AI remote。

---

## 9. 产品边界：不是完整 Xshell，而是 Remote Workspace

最终 Terax 不需要做成完整 Xshell/Xftp：

```text
大量会话脚本
商业级终端宏
复杂日志审计
Telnet/Serial 全家桶
企业运维管理
```

这些不是主目标。

主目标是：

```text
远程开发工作台
本地/WSL/SSH 统一 workspace
多窗口隔离
稳定 SSH keepalive
远程文件编辑
远程终端
SFTP 上传下载
SSH 隧道
AI 远程项目辅助
```

---

## 10. 最终一句话定位

可以把最终产品目标定义为：

> **Terax Remote Workspace：一个支持 Local / WSL / SSH 的多窗口远程开发工作台。用户可以像 VS Code Remote SSH 一样为 WSL 或任意 SSH 服务器打开独立窗口，在窗口内浏览和编辑远程文件、打开远程终端、使用 SFTP 上传下载、创建 SSH 隧道，并由窗口级 RemoteWorkspaceSession 统一管理 SSH 连接、keepalive、SFTP、terminal、tunnel 和后续 AI 远程能力。**

更短一点就是：

> **让 SSH 服务器在 Terax 里变成一个稳定保活、可编辑、可终端、可隧道、可 AI 操作的独立开发工作台窗口。**

# 项目的开发参考

为了缩短开发周期，避免重复造轮子，计划直接参考成熟、语言和架构类似的三个项目，将其能力复用过来，并舍弃与本项目无关的逻辑，从而快速搭建项目的后端能力：

CrabPort ：https://github.com/chi11321/CrabPort/tree/dev，是rust + gpui

Eussh： https://github.com/WillSat/eussh， 是rust+tauri + Vue

meatshell：https://github.com/jeff141/meatshell，是rust+ slint

> **主线：CrabPort + Eussh；
> meatshell 作为“功能细节参考”保留，但不作为移植对象；

## 最终推荐分工

| 项目          | 是否保留 | 角色定位                 | 原因                                                         |
| ------------- | -------: | ------------------------ | ------------------------------------------------------------ |
| **CrabPort**  |     保留 | **主要后端参考**         | 模块拆分最好，已有 `crabport-ssh`、`crabport-sftp`、`crabport-tunnel`、`crabport-proxy` 等 crate，适合参考 SSH/SFTP/隧道后端结构。 |
| **Eussh**     |     保留 | **Tauri 接入参考**       | 同样是 Tauri + Web 前端 + xterm，command/event/session manager 接法最接近 Terax。 |
| **meatshell** | 降级保留 | **功能细节参考，不移植** | 功能很全，支持 SSH/SFTP/隧道/代理/SSH config 导入等，但 Slint 单体应用味道重，直接移植成本高。 |

---
## CrabPort：主参考

CrabPort 最适合现在的方向，因为不是要搬 UI，而是要给 Terax 补：

```text id="v4k4wf"
SSH 后端
SFTP 后端
Tunnel 后端
Proxy / Credential / KnownHosts 结构
```

CrabPort 已经拆成多个 Rust crate，后端边界比其他项目清楚。

尤其是：

```text id="3dd04r"
crabport-ssh
crabport-sftp
crabport-tunnel
crabport-proxy
crabport-core
```

这正好对应 Terax 后续要做的 remote backend。

不过也不要直接整包搬。建议是：

```text id="f1lsf3"
参考模块边界
参考 trait / type 设计
参考 tunnel 生命周期
参考 SFTP API
必要时少量移植核心逻辑
```

而不是：

```text id="srihb3"
把 CrabPort workspace 直接塞进 Terax
```

---

## Eussh：Tauri 桥接参考

Eussh 的价值不在 SFTP，因为它的文件管理更偏 SSH exec 方式，不是真正完整 SFTP 后端。

但它非常适合参考：

```text id="7h7s6g"
Tauri command 命名
session_id 管理
terminal-data event
connection-status event
host-key verify event
terminal write / resize / close 桥接
```

它的 Tauri command 注册很直接，包括 `connect`、`disconnect`、`terminal_write`、`terminal_resize`、`exec_command`、`confirm_host_key`、`file_list`、`file_read`、`file_write` 等。

这对 Terax 这种 Tauri + React + xterm 架构最有参考价值。

---


## meatshell：不建议完全移除，但不要作为主线

meatshell 不建议从参考列表里彻底删掉，因为它有一些非常实用的功能细节：

```text id="a03w6j"
SSH config 导入
SFTP 上传下载
Local / Remote / Dynamic 隧道
SOCKS5 / HTTP 出站代理
会话密码加密存储
远端资源监控
Telnet / Serial 等扩展经验
```

这些功能在 README 里都明确列为已实现。

但它不适合作为主移植来源，原因是：

```text id="vbc6au"
Rust + Slint
UI 和后端耦合较多
更像一个完整 SSH 客户端应用
不是一个容易拆出来嵌入 Terax 的后端 crate
```

所以 meatshell 的定位应该是：

> **保留为功能细节参考，不进入主移植链路。**

也就是需要做隧道、代理、SSH config、凭据加密、上传下载细节时再查它，不要一开始围着它拆代码。

---



## 最终精简后的参考方案

可以简化成这样：

```text id="lv2j8g"
主线参考：
  1. CrabPort
     - SSH/SFTP/Tunnel/Proxy 后端结构
     - remote backend 模块拆分

  2. Eussh
     - Tauri command/event/session manager 接法
     - terminal 与前端 xterm 的桥接方式

降级参考：
  3. meatshell
     - 只查功能细节
     - 不作为移植对象

```

## 更明确的开发取舍

 Terax remote 方案里，后面可以这样用：

```text id="u3cexb"
窗口隔离 / workspace window:
  主要看 Terax 现有 WSL + spaces/window 代码

SSH terminal:
  CrabPort 后端结构 + Eussh Tauri 事件桥

SFTP:
  CrabPort 为主
  meatshell 只查上传/下载/异常处理细节

Tunnel:
  CrabPort 为主
  meatshell 只查功能完整性和参数细节

SSH config / proxy / credential:
  CrabPort + meatshell 对照
```

# 初步计划的开发顺序

1. 确定窗口级 workspace 模型
2. 实现 open_workspace_window
3. spaces/tabs 按 window scope 隔离
4. WSL 改成默认新开窗口
5. 加 SSH profile，并接入新窗口
6. 做 SSH terminal
7. 做 SFTP 文件树和远程编辑
8. 做 tunnel
9. 做 remote shell / AI / git / grep
