# Terax

Terax 是基于 Tauri、Rust 和 React 的 AI 原生桌面终端，集成代码编辑器、文件浏览、Git 和网页预览，面向 macOS、Linux 和 Windows。上游项目见 [crynta/terax-ai](https://github.com/crynta/terax-ai)。

本仓库为自用独立维护，不接受外部 PR。欢迎按需 fork 并进行二次开发。

## 相比上游的主要改动

- **SSH 远程工作环境**。连接 Linux 主机后，可在同一个 Workspace 中使用远程终端、编辑和搜索文件、操作 Git、运行 Agent。支持 SSH 隧道、后台文件传输和单向目录增量同步。
- **重构 Workspace 与 Space**。每个 Workspace 窗口在独立进程中绑定 Local、WSL 或 SSH 环境。窗口内可用多个 Space 管理不同项目，每个 Space 可以锁定项目根目录，也可以跟随当前工作页的目录。终端、编辑器等工作页可以混合分屏、拖动换组，移动终端时保留原会话。
- **重构 Agent 运行时**。内置 Agent 支持自备 API 密钥或连接本地模型，重做了工具审批、后台执行和会话保存。重新打开会话后可继续子任务。长会话压缩后仍保留完整历史，可从回复或压缩检查点分叉。聊天面板也可直接使用当前环境中已安装并登录的 Claude Code 或 Codex CLI。
- **改进 Git 工作流**。在侧栏提交图谱中浏览分支和提交，在文件树中查看单个文件的历史，在编辑器中并排比较改动。获取、拉取和推送可手动终止，本地 Git 操作显示当前联网阶段的进度。

## 从源码运行

需要 Rust、符合 `package.json` 要求的 Node.js、pnpm，以及当前平台的 Tauri 编译依赖。

```sh
pnpm install
pnpm tauri dev
```

打包使用 `pnpm tauri build`。检查命令见 [测试指南](docs/contributing/testing.md)。

## 配置

在设置中添加模型连接和模型 ID。云模型使用自己的凭据，本地模型使用本机服务地址；凭据存储方式及权限模式见 [安全说明](SECURITY.md)。

实验性 `terax agent` 已暂停主动开发，现有入口见 [终端宿主](docs/architecture/terminal-agent.md)。

## 项目文档

- [开发约定](AGENTS.md)与[开发指南](CONTRIBUTING.md)
- [架构与操作文档](docs/README.md)
- [后续方向](ROADMAP.md)与[上游跟踪](FORK_NOTES.md)
- [Apache-2.0 许可证](LICENSE)与[第三方来源](THIRD_PARTY_NOTICES.md)
