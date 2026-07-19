# Workbench v2 审阅修复计划

## 目标

修复 `refactor/workbench-groups` 两次提交在代码审阅中发现的生命周期、后台加载、共享文档诊断、拆分拖放、跨平台资源身份和持久化可靠性问题，完成 Workbench v2 合并前收尾。

## 阶段 1：Space 删除与共享文档生命周期

- 删除 Space 前检查其中的 dirty 文档和前台终端进程。
- 需要确认时复用关闭对话框语义，不允许直接移除仍有未保存内容的最后文档视图。
- 批量移除 Space 后，释放不再被任何 Tab 引用的共享文档模型。
- 保证同一文档仍在其他 Space/Group 中打开时不丢弃共享缓冲区。

## 阶段 2：隐藏视图与诊断所有权

- 将真实 `visible` 状态传给 Git History。
- Git History 隐藏时停止 viewport auto-fill 和新增分页，保留已加载状态。
- 诊断上报只由当前聚焦并持有 LSP 的文档视图负责。
- 非 owner 视图卸载或失焦不得覆盖、清零或删除同路径 owner 的诊断。

## 阶段 3：拆分与 Explorer 拖放一致性

- 移除 dirty Editor/Markdown 的旧复制拆分限制。
- 右键菜单、命令面板和快捷键使用相同的可拆分规则。
- Explorer 文件拖到 Group 边缘时始终创建新的共享文档视图。
- 已在目标 Group 打开的文件也必须能创建第二个视图，不能无操作或移动原标签。

## 阶段 4：跨平台文档资源身份

- 资源 identity 保留 UNC 前缀，不能将网络路径与本地根路径合并。
- 本地 Windows workspace 按平台文件系统大小写语义比较路径。
- WSL、SSH 和大小写敏感环境保持路径大小写。
- dirty 同步、关闭保护、共享模型 registry 和文档计数统一使用同一 identity key。
- 参考 VS Code `uriIdentityService` 的 provider-aware comparison key 思路，但只实现 Terax 当前 workspace 环境所需的最小能力。

## 阶段 5：Workbench 持久化可靠性

- 每个 Space 的保存和删除操作串行执行。
- 仅在写入成功后更新 last-saved 快照。
- 写入失败后允许相同状态在下一次 flush 重试。
- 防止旧快照晚于新快照完成并覆盖最新布局。

## 阶段 6：规范与测试

- 新增用户可见文本接入 `en` 和 `zh-CN` 翻译。
- 清理本次覆盖范围内的硬编码 fallback 和禁止使用的长破折号。
- 增加 Space 删除、Git History 可见性、重复文档诊断、dirty 拆分、边缘拖放、Windows/UNC identity 和持久化失败重试测试。
- 运行 `pnpm lint`、`pnpm check-types`、`pnpm test`、`pnpm build`、`pnpm analyze:eager` 和 `git diff --check`。

## 完成标准

- 删除 Space 不会静默丢失未保存内容，也不会遗留不可达的 dirty model。
- 隐藏 Git History 不产生后台分页风暴。
- 同一路径多视图的诊断只由当前 owner 管理。
- 所有入口对 dirty 文档拆分行为一致。
- Explorer 边缘拖放始终得到独立视图。
- Windows、UNC、WSL 和 SSH 路径 identity 不发生错误合并。
- Workbench 状态写入失败可重试，连续写入保持最新状态。
- 完整前端质量门禁通过。

## 执行状态

- [x] 阶段 1：Space 删除与共享文档生命周期
- [x] 阶段 2：隐藏视图与诊断所有权
- [x] 阶段 3：拆分与 Explorer 拖放一致性
- [x] 阶段 4：跨平台文档资源身份
- [x] 阶段 5：Workbench 持久化可靠性
- [x] 阶段 6：规范与测试
