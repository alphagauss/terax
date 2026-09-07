# 文档索引

[AGENTS.md](../AGENTS.md) 记录全局约定，以下专题各自维护业务规则；具体接口、类型、常量与测试入口以源码为准。未完成方向见 [ROADMAP](../ROADMAP.md)。

## Workspace 与原生能力

- [进程与共享状态](architecture/two-process-model.md)
- [PTY 与 Shell](architecture/pty-shell-integration.md)、[终端 renderer pool](architecture/terminal-renderer-pool.md)
- [辅助窗口](architecture/auxiliary-windows.md)、[工作页跨窗口复制](architecture/workspace-page-handoff.md)
- [文件传输](architecture/file-transfers.md)
- [实验性终端宿主](architecture/terminal-agent.md)

## AI 与连接

- [会话与运行](architecture/ai-subsystem.md)
- [内置工具安全](architecture/security-model.md)
- [网络与代理](architecture/network.md)
- [Channels](architecture/channels.md)
- [外部 CLI Agent](architecture/external-agent-runtime.md)

## 开发与操作

- [检查与验证](contributing/testing.md)
- [桌面样式](contributing/ui-style.md)、[主题](contributing/themes.md)
- [Tauri 运行时调试](contributing/ui-runtime-debugging.md)
- [public 发布](contributing/public-release.md)、[上游移植](../FORK_NOTES.md)
