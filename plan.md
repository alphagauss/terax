# Subagent 破坏式重构计划

## 目标

将现有按 `Explore`、`Code review`、`Security`、`General` 分类的同步只读 Subagent，重构为一个通用、支持同步等待与后台协作的 `run_subagent` 工具。

完成后的行为：

- `run_subagent` 只接受 `task`、可选 `label` 和可选 `wait`，不接受 `type`、`temperature` 或单次模型覆盖。
- `wait` 默认 `false`。`wait=true` 时，最终结果直接作为原工具调用的 tool result；`wait=false` 时，工具立即返回已启动状态，完成结果以 append-only 内部 `subagent_result` user 消息加入同一 turn。
- 每个聊天独立限制并发 Subagent 数量，默认 3，可在模型设置页配置；超过上限立即拒绝，不排队。
- Subagent 模型默认跟随本轮主模型，也可在模型设置页单独指定。模型和 provider 配置在 Subagent 启动时冻结。
- 主 Agent 为请求批准模式时，Subagent 只能使用父 Agent 已允许的只读工具；主 Agent 为完全访问模式时，Subagent 继承父 Agent 已允许的工具。任何模式下都移除 `run_subagent`，禁止递归创建 Subagent。
- `wait=false` 的任务不会阻塞主 Agent 的正常工具循环，但会阻止本轮提交终态。主 Agent 到达候选终态而仍有后台任务时，等待该聊天全部后台任务完成，追加尚未消费的结果，然后恢复正常 Agent 循环。
- 后台结果不改写已有 tool result 或历史消息。内部事件先持久化，再发送给 provider，保证磁盘记录、模型上下文和内存规范消息一致，并保持已有 prompt 前缀稳定。
- 停止、删除聊天或退出运行时会取消该聊天的全部 Subagent。Subagent usage 计入父聊天统计。

## 实施步骤

1. 设置与模型解析
   - 新增 `defaultSubagentModelId` 和 `maxConcurrentSubagents` 偏好、默认值、归一化、跨窗口同步与 setter。
   - 在模型设置页增加 Subagent 模型和每聊天并发数设置，更新英文与中文翻译。
   - 统一复用主 Agent 的 configured model builder，覆盖云端、本地、OpenRouter 和自定义 endpoint。

2. 通用 Subagent 运行时
   - 删除类型化 registry 和旧 runner。
   - 新增按聊天登记任务的运行时，负责原子并发检查、同步等待、后台执行、结果队列、usage、取消和清理。
   - 子运行使用父会话冻结的 system prompt、cwd、模型配置和工具白名单，不复制父聊天历史。

3. 权限与工具协议
   - 将工具审批模式改为由 `ToolContext` 提供，主 Agent 仍可实时读取当前模式，Subagent 使用启动时冻结的模式。
   - 请求批准模式只暴露只读交集；完全访问模式暴露父工具交集；始终排除 `run_subagent`。
   - 将 `run_subagent` schema 替换为 `task`、`label`、`wait`，默认后台运行。

4. 同一 turn 的后台结果协调
   - 为主运行增加按模型调用边界消费后台结果的协调器。
   - 定义稳定的内部 `subagent_result` user 消息格式和 metadata，UI 隐藏但模型可见。
   - 增加运行中 checkpoint 提交，确保内部事件及其之前完成的消息在下一次 provider 请求前持久化。
   - 候选终态存在后台任务时保持 session run lock，等待完成后继续完整 Agent 循环，而不是新建聊天轮次。

5. UI、会话适配与文档
   - 复用现有工具卡，摘要优先展示 `label`、否则展示 `task`，内部完成事件不渲染为用户消息。
   - 更新 JSONL 与 UIMessage 双向转换，保留内部事件 metadata 并从聊天界面隐藏。
   - 更新 AI 子系统文档，删除旧类型化 Subagent 描述。

6. 验证
   - 测试 `wait=true`、`wait=false`、结果注入、正常继续调用工具和最终结束条件。
   - 测试每聊天并发 3、第四个立即拒绝、任务结束释放额度。
   - 测试权限交集、禁止递归、模型继承与独立默认模型、取消和 usage。
   - 测试内部事件 append-only、持久化往返、隐藏渲染和 provider 消息合法性。
   - 运行 `pnpm test`、`pnpm check-types` 和 `pnpm lint`。

## 完成标准

- 旧的 Subagent 类型、registry、参数和兼容分支全部删除。
- 新工具协议、设置、后台协调、权限、模型、持久化和 UI 行为全部通过测试。
- 每个修改的 TypeScript、TSX 文件具有合格的中文文件级注释，新增或实质修改的重要函数具有中文说明。
- AI 子系统文档与实际实现一致。
