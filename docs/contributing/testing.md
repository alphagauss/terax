# 检查与验证

按影响范围选择检查和相关测试；跨层变更覆盖受影响各层，公共基础设施、大范围修改与发布准备执行完整检查。必要验证无法执行时说明具体原因。

## 命令

前端：

```sh
pnpm lint
pnpm check-types
pnpm test
```

可向 `pnpm test` 传入相关测试文件。构建或发布变更增加 `pnpm build`。

Rust，在 `src-tauri/` 中执行：

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked
```

没有 nextest 时使用 `cargo test --locked`；局部修改可以选择相关测试。Alpha Python 和实验性终端的专用命令分别见 [Alpha](../../alpha/docs/README.md) 与 [终端宿主](../architecture/terminal-agent.md)。

## 测试边界

- 终端、Shell、Workspace 授权、Git、文件系统、IPC 和 AI 工具行为变更须锁定关键业务不变量，包括真实失败边界。
- 一个不变量保留一个主要回归测试，不重复验证框架透传、常量拼装或类型系统已保证的事实。已有组合测试优先补充新边界。
- 跨进程锁与共享配置使用真实子进程验证；进程清理验证子孙进程，不只验证直接 Shell 退出。前端审批测试不能替代原生授权和条件提交测试。
- 纯文档只检查内容、链接、格式及描述与实现的一致性。确定性配色、静态文案等不默认增加测试或运行时检查。
- 需要真实 UI 或原生状态证据时按 [运行时调试](ui-runtime-debugging.md) 复现并复验，不把普通 Vite 页面当作 Tauri 运行时。
