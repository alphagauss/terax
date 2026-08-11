# Terax 贡献者文档

本目录存放面向贡献者和维护者的详细指南。仓库根目录的 `AGENTS.md` 是持续更新的架构文档和权威信息源；这些指南在不重复其内容的前提下，对特定领域进行详细说明。

如果某份指南与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准。

## 入门

- [AGENTS.md](../AGENTS.md) - 架构权威文档，请先阅读
- [CONTRIBUTING.md](../CONTRIBUTING.md) - 贡献方式、质量标准和项目布局

## 架构指南

- [双进程模型与 IPC command 参考](architecture/two-process-model.md) - Rust 负责所有操作系统访问；WebView 通过 `invoke()` 通信。包含 command 目录以及新增 command 的方法。
- [PTY Shell 集成](architecture/pty-shell-integration.md) - PTY session、Shell 初始化脚本、OSC 7 / 133、ConPTY、SPAWN_LOCK、Job Object 和 WSL。
- [安全模型](architecture/security-model.md) - deny-list、SSRF 防护、Workspace 授权、AI 工具审批、IPC allowlist、OSC 信任机制和 keychain 处理。
- [AI 子系统](architecture/ai-subsystem.md) - provider、Agent、sub-agent、session、composer、工具、编辑 diff 和实时上下文桥接。包含新增 provider 的完整操作说明。
- [终端 renderer pool](architecture/terminal-renderer-pool.md) - slot pool、DormantRing，以及禁止在命令执行中序列化的不变量。
- [文件传输](architecture/file-transfers.md) - Direct 与 Archive 任务生命周期、staging、no-replace commit、重试、资源上限和真实环境验证。
- [Alpha 集成](architecture/alpha-integration.md) - FastAPI 量化后端、轻量 Rust proxy、Terax UI 集成和可选的 PyO3 计算边界。
- [Alpha 综合量化工作站](architecture/alpha-quant-workstation.md) - 公共金融图表、面板工作台、行情回测实盘边界、已审查的参考项目和分阶段实施指南。

## 贡献指南

- [测试](contributing/testing.md) - 测试约定、检查运行方式，以及优秀核心子系统测试的标准。
