# 检查与验证

按影响范围选择检查和相关测试；跨层变更覆盖受影响各层，公共基础设施、大范围修改与发布准备执行完整检查。必要验证无法执行时说明具体原因。

## 命令

前端：

```sh
pnpm format:check
pnpm lint
pnpm check-types
pnpm test
```

可向 `pnpm test` 传入相关测试文件。构建或发布变更增加 `pnpm build`。

格式化使用固定版本 Biome，配置 schema 与工具版本一起更新。`pnpm format` 写入格式化结果，`pnpm format:check` 仅检查；CI 将格式检查作为必过步骤。格式范围覆盖项目自有前端源码、CSS、JSON、HTML 入口、脚本和根配置，使用 2 空格、80 列建议行宽和 LF，CSS 开启 Tailwind 指令解析。注册表管理的 `src/components/ui/`、`src/components/ai-elements/` 保持排除，生成产物遵循 Git 忽略规则。

格式化、lint 和导入整理分别配置范围；扩展格式化范围不自动扩大 lint 范围。VS Code 保存时执行格式化和导入整理，不自动应用 quick fix。需要修复 lint 时显式执行 `pnpm lint:fix`，该命令只修改 `src/`；`pnpm format` 不执行 lint 修复或导入整理。

Rust，从仓库根目录执行，显式覆盖整个 workspace：

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo nextest run --workspace --locked
```

没有 nextest 时使用 `cargo test --workspace --locked`。局部修改使用 `-p terax-core`、`-p terax-git`、`-p terax-host` 或 `-p terax` 选择 crate，再选择相关测试；core 默认覆盖完整 Workspace 能力。共享边界变更还需单独执行 `cargo check -p terax-host --all-targets --locked`，防止联合构建的特性合并掩盖轻量宿主问题。构建组织见 [原生 workspace](../architecture/native-workspace.md)，实验性终端的专用命令见 [终端宿主](../architecture/terminal-agent.md)。

## 测试边界

- 终端、Shell、Workspace 授权、Git、文件系统、IPC 和 AI 工具行为变更须锁定关键业务不变量，包括真实失败边界。
- 一个不变量保留一个主要回归测试，不重复验证框架透传、常量拼装或类型系统已保证的事实。已有组合测试优先补充新边界。
- 跨进程锁与共享配置使用真实子进程验证；进程清理验证子孙进程，不只验证直接 Shell 退出。前端审批测试不能替代原生授权和条件提交测试。
- 纯文档只检查内容、链接、格式及描述与实现的一致性。确定性配色、静态文案等不默认增加测试或运行时检查。
- 是否启动运行时调试遵循 [AGENTS.md 的验证顺序](../../AGENTS.md#ui-与验证)。运行效果可由用户人工验证反馈，未实测部分须明确标注，不把静态检查通过写成运行通过；确需调试时按 [运行时调试](ui-runtime-debugging.md) 复现并复验，不把普通 Vite 页面当作 Tauri 运行时。

## 工具调用质量评估

工具行为或描述调整后，用相同模型、配置和任务集比较修改前后的实际会话。复用会话 JSONL 中的模型调用及工具回执，按所属主、子会话和工具调用 ID 关联，不重复统计 display 或 usage 记录。分别统计 JSON 解析、参数校验、文本匹配、版本冲突及执行失败；Shell 的 running 回执不算成功，须关联后续终态，取消和未完成单独列出。

首次成功率和重试次数以人工确认的同一操作意图为单位，不能仅将相邻同名工具调用认作重试。报告须说明样本量、模型配置、版本和未完成项；已有自动化测试通过不能替代真实会话成功率证据。没有修改后的会话样本时保留基线，待人工使用后比较，不为统计重写模型历史或新增重复持久化记录。
