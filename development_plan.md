# Terax Remote Workspace 开发规划

## 文档定位与优先级

本项目基于原开源项目 fork 后独立开发。本文件定义本项目后续的产品方向和开发规划；`TERAX.md` 及其关联文档用于说明上游项目和当前既有架构。

当开发规划与上游说明不一致时，以本文件为准。本文件未涉及的现有架构、工程约束和质量要求，继续参考 `TERAX.md` 及相关文档。

## 1. 产品定位

Terax 的目标不是成为普通 SSH/SFTP 客户端或 Xshell/Xftp 的替代品，而是：

> **一个支持 Local、WSL、SSH 多环境和多窗口隔离，并具备 AI 能力的远程开发工作台。**

产品体验接近 VS Code Remote SSH 与 Terax AI Terminal 的结合。用户进入远程环境后，应当能够像开发本地项目一样浏览文件、编辑代码、使用终端和访问远程服务。

## 2. 核心模型

### 2.1 一个窗口绑定一个 Workspace 环境

每个窗口只绑定一个 Local、WSL 或 SSH 环境。打开其他环境时，默认创建新的独立窗口，不替换当前窗口。

同一个环境可以按需打开多个窗口，包括同一个 Local 环境、WSL 发行版或 SSH profile。每个窗口独立维护：

- 文件树和编辑器标签页
- 终端标签页
- Spaces 和工作区状态
- AI 上下文
- 连接状态和隧道
- 窗口标题及持久化状态

窗口是工作区状态和生命周期的隔离边界。

### 2.2 Local、WSL、SSH 是同级 Workspace 后端

- Local Workspace 使用本地文件系统和本地 Shell。
- WSL Workspace 使用 WSL 文件系统和 WSL Shell。
- SSH Workspace 提供远程文件、远程终端、文件传输和 SSH 隧道能力。

SSH 在 Terax 中代表完整的远程开发环境，而不是在本地终端中执行一次 `ssh` 命令。

### 2.3 SSH 窗口对应一个远程工作区会话

每个 SSH 窗口拥有独立的远程工作区上下文，统一管理连接、保活、远程文件、终端、隧道和连接状态。

同一窗口可以打开多个终端标签页。各终端的 Shell、当前目录和进程状态相互独立，关闭一个终端不影响其他终端。不同窗口之间的工作区状态和连接生命周期完全隔离。

## 3. 目标能力

### 3.1 多窗口工作区

- Local、WSL、SSH 环境均可打开独立窗口。
- 当前窗口在打开新环境后继续保留。
- 同一环境允许同时打开多个独立窗口。
- 每个窗口只展示和操作其绑定环境中的资源。

### 3.2 SSH 远程开发

SSH Workspace 应支持：

- 浏览、打开、编辑和保存远程文件
- 打开多个独立远程终端
- 上传和下载文件
- 创建和管理 SSH 隧道
- 展示连接、重连和断开状态
- 在长时间空闲时维持连接

用户进入 SSH 窗口后看到的是完整工作台，而不是裸 SSH Shell。

### 3.3 连接与恢复

SSH 的保活应由连接层统一处理，不依赖向终端输入字符。

不同能力遵循各自真实的恢复语义：

- 远程文件操作可在重新连接后恢复。
- SSH 隧道可在重新连接后尝试重建。
- 终端断线后不承诺透明恢复原有 Shell 和进程；持久会话由用户通过 tmux、screen 等远端工具实现。

### 3.4 AI 远程工作区能力

在远程工作区基础能力稳定后，AI 应能够在当前 SSH Workspace 中：

- 读取和解释远程项目文件
- 提议并执行远程文件修改
- 执行远程命令
- 查看 Git 状态和差异
- 辅助调试远程服务

AI 操作必须沿用 Terax 现有的工作区授权、敏感路径保护和危险操作审批边界。

## 4. 产品边界

Terax 的核心方向是远程开发工作台，重点包括：

- Local、WSL、SSH 统一的 Workspace 模型
- 多窗口隔离
- 远程文件浏览和编辑
- 远程终端与文件传输
- SSH 隧道、保活和连接状态
- AI 远程项目辅助

以下能力不属于当前主目标：

- 大量会话脚本和商业级终端宏
- 复杂日志审计和企业运维管理
- Telnet、Serial 等协议集合
- 完整复刻 Xshell/Xftp 的全部功能

## 5. 阶段目标

### 第一阶段：多窗口 Workspace 基础

Local 和 WSL 环境可以打开多个相互隔离的工作台窗口，窗口内的标签页、Spaces、文件树和持久化状态互不影响。

### 第二阶段：SSH Workspace 基础

SSH profile 可以打开独立工作台窗口，并提供稳定连接、连接状态和多个远程终端。

### 第三阶段：远程文件能力

SSH Workspace 支持远程文件树、编辑保存、上传下载，并与现有编辑器体验保持一致。

### 第四阶段：隧道与连接恢复

补齐 SSH 隧道、保活、重连以及不同能力的断线恢复体验。

### 第五阶段：AI Remote Workspace

将现有 AI 文件、Shell、Git 和调试能力扩展到当前远程工作区，并保持相同的安全与审批边界。

## 6. 开发参考

为缩短开发周期，计划参考以下三个 Rust 项目的成熟设计。参考以模块边界、生命周期和交互模式为主，不直接整体移植外部项目；复用具体代码前需单独评估许可证、质量、安全性和维护成本。

| 项目 | 技术架构 | 参考定位 | 重点参考内容 |
| --- | --- | --- | --- |
| [CrabPort](https://github.com/chi11321/CrabPort) | Rust + GPUI | 主要后端参考 | SSH、SFTP、Tunnel、Proxy 的模块边界和生命周期 |
| [Eussh](https://github.com/WillSat/eussh) | Rust + Tauri + Vue | Tauri 接入参考 | Command、Event、Session Manager 和 xterm 桥接 |
| [meatshell](https://github.com/jeff141/meatshell) | Rust + Slint | 功能细节参考 | SSH config、文件传输、隧道、代理和凭据管理 |

本地代码位置：

- CrabPort：`D:\opensource\CrabPort`
- Eussh：`D:\opensource\eussh`
- meatshell：`D:\opensource\meatshell`

### 6.1 CrabPort

CrabPort 是 SSH 后端的主要参考。它将 SSH、SFTP、Tunnel、Proxy 和 Core 拆分为独立 crate，边界与 Terax 计划中的 Remote Workspace 后端较为接近。

重点参考：

- SSH、SFTP、Tunnel 和 Proxy 的职责划分
- 连接及隧道的生命周期管理
- SFTP API 和错误边界
- 凭据与 Known Hosts 的结构设计

不将 CrabPort workspace 整体并入 Terax，仅在符合 Terax 架构和质量要求时复用必要设计或代码。

### 6.2 Eussh

Eussh 与 Terax 同样采用 Tauri、Web 前端和 xterm，适合作为前后端桥接参考。

重点参考：

- SSH 会话标识和状态管理
- 终端数据及连接状态事件
- 终端写入、尺寸调整和关闭流程
- Host Key 确认交互
- Tauri Command 与前端终端之间的边界

Eussh 的远程文件能力更偏 SSH Exec，不作为 Terax SFTP 后端的主要参考。

### 6.3 meatshell

meatshell 功能覆盖较广，适合核对具体功能的完整性和参数设计。

重点参考：

- SSH config 导入
- SFTP 上传和下载
- Local、Remote、Dynamic 隧道
- SOCKS5 和 HTTP 出站代理
- 会话凭据存储

由于其 UI 与后端更接近 Slint 单体应用，不将其作为主移植来源。需要开发相关功能时再参考具体实现。

## 7. 总体取舍

Terax Remote Workspace 的开发主线是：以现有 Terax Workspace 和窗口能力为基础，以 CrabPort 参考远程后端设计，以 Eussh 参考 Tauri 终端桥接，并使用 meatshell 补充功能细节。

所有外部设计最终都应服从 Terax 现有的性能、安全、跨平台和功能核心边界。
