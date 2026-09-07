# Terax

Terax 是基于 Tauri、Rust 和 React 的 AI 原生桌面终端。本仓库是独立维护的下游版本，面向 macOS、Linux 和 Windows。

- 多标签与分割终端、代码编辑器、文件浏览、Git 和网页预览。
- 每个 Workspace 窗口绑定 Local、WSL 或 SSH 环境。
- 使用自备密钥或本地模型的内置 Agent，以及当前环境中已安装的外部 CLI Agent。
- `main` 包含个人量化工作站 Alpha；`public` 排除 Alpha。

## 从源码运行

需要 Rust、符合 `package.json` 要求的 Node.js、pnpm，以及当前平台的 Tauri 编译依赖。

```sh
pnpm install
pnpm tauri dev
```

打包使用 `pnpm tauri build`。检查命令见 [测试指南](docs/contributing/testing.md)。

## 配置

在设置中添加模型连接和模型 ID。云模型使用自己的凭据，本地模型使用本机服务地址；凭据存储方式及权限模式见 [安全说明](SECURITY.md)。

Alpha 需要单独配置 Python 解释器和依赖，见 [Alpha 后端文档](alpha/docs/README.md)。实验性 `terax agent` 已暂停主动开发，现有入口见 [终端宿主](docs/architecture/terminal-agent.md)。

## 项目文档

- [开发约定](AGENTS.md)与[贡献指南](CONTRIBUTING.md)
- [架构与操作文档](docs/README.md)
- [后续方向](ROADMAP.md)与[上游跟踪](FORK_NOTES.md)
- [Apache-2.0 许可证](LICENSE)与[第三方来源](THIRD_PARTY_NOTICES.md)
