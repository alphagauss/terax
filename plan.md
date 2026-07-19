# Workbench 提交审阅修复与优化计划

## 目标

修复 `refactor/workbench-groups` 提交中已经确认的状态一致性、视图生命周期、布局比例和跨 Space 路由问题，并清理重构后遗留的单 Tab Stack 与重复逻辑。

本计划只面向当前 Workbench v2 模型，不读取、不迁移、不保留任何旧版 Space、Workbench 或快捷键数据。

## 已确认的产品决策

- 将网页预览统一命名为 **Web Preview**，与代码编辑器的临时 `preview` tab 明确区分。
- Web Preview 隐藏后的 iframe 回收时间由 30 秒调整为 5 分钟。
- 同一路径可以在多个 Group 或 Space 中同时打开。
- 文档内容、dirty、保存、重载、自动保存和磁盘版本按 `workspace + normalized path` 共享。
- 每个 Editor/Markdown 视图保留独立的光标、选区、滚动位置和视图模式。
- Editor/Markdown 的复制拆分使用共享文档，不创建独立缓冲区。
- 只保证当前 v2 Workbench 状态保存和恢复，不增加兼容分支。

## 非目标

- 不迁移旧的扁平 `tabs + activeTabIndex` Space 状态。
- 不迁移旧快捷键 id。
- 不修改 Rust PTY、renderer pool 的会话协议或终端持久化语义。
- 不保存 AI Diff、Git Diff、Git History 等瞬态页面。

## 阶段 1：Web Preview 命名与生命周期

- 将运行时 Tab 类型、打开函数、组件和 UI 文案中的网页 Preview 改名为 Web Preview。
- 将 Workbench tab discriminator 和当前 v2 serializer 同步为 `web-preview`。
- 保留 `EditorTab.preview`，它只表示资源管理器单击产生的临时代码编辑标签。
- 将 iframe 隐藏回收常量调整为 `5 * 60 * 1000`。
- 给回收行为增加 fake-timer 测试，覆盖 5 分钟前保留、5 分钟后卸载、重新显示取消回收。

## 阶段 2：页面可见性与遗留 Stack 清理

- `WorkbenchViewPool` 继续作为页面稳定挂载和跨组移动的唯一宿主。
- `WorkbenchRegisteredView` 将真实 `visible` / `focused` 直接传给页面。
- 删除只接收单个 Tab 的 `EditorStack`、`MarkdownStack`、`PreviewStack`、`AiDiffStack`、`GitDiffStack` 和 `GitHistoryStack`。
- Web Preview 隐藏时启动 iframe 回收计时。
- Markdown 隐藏时暂停渐进渲染和观察器。
- Git Diff 隐藏时不启动尚未发生的加载。
- 去掉 `PooledView` 与 `TerminalView` 之间重复的激活捕获。

## 阶段 3：共享文档模型

- 建立按 `workspace + normalized path` 索引的共享文档 registry。
- registry 统一持有加载状态、文本缓冲区、saved buffer、dirty、EOL、mtime/size、强制读取状态和自动保存计时器。
- `useDocument` 改为订阅共享模型；多个 Editor/Markdown 视图对同一资源读取和修改同一缓冲区。
- 仅由当前聚焦的文档视图连接 LSP，避免同一 URI 被多个 CodeMirror 重复 `didOpen/didChange`。
- 单个视图只保留 CodeMirror 的光标、选区、滚动位置等 UI 状态。
- 保存、reload、外部文件变化和 AI diff 应用只对共享模型执行一次，并通知所有视图。
- 最后一个订阅视图卸载后取消计时器并释放干净模型；dirty 模型在显式保存或关闭确认前不得丢失。
- `openFileTab` / `newMarkdownTab` 仍在目标 Group 内复用已有同类标签，但允许其他 Group/Space 拥有同资源视图。
- `cloneForSplit` 允许复制干净或脏的 Editor/Markdown tab，因为缓冲区已经共享。
- 增加多 Group 同文件同步编辑、dirty 同步、单次保存、卸载引用计数和 Editor/Markdown 交叉视图测试。

## 阶段 4：冷标签与模型不变量

- `addTabToGroup` 在 `activate=true` 时自动清除 `cold`。
- `moveTabToGroup` 和 `splitWithTab` 保证新激活标签已经 warm。
- 保留启动阶段的 cold hydration；只在页面实际激活时挂载。
- 增加恢复后拖动未访问标签到中心和边缘的模型测试。

## 阶段 5：布局比例与约束

- 同轴拆分时平分目标 Group 的当前比例，保留其他兄弟比例。
- 删除 Group 时移除对应尺寸并归一化剩余比例。
- 新建二叉 split 明确保存 `[50, 50]`。
- 将固定 `15%` 最小尺寸改为随同轴子节点数量自适应的约束，避免 7 个以上 Group 的最小尺寸总和超过 100%。
- 增加直接同轴拆分、三节点删除、嵌套折叠和多 Group 约束测试。

## 阶段 6：标签元数据与跨 Space reveal

- 提供统一的 `revealTab` 路径，负责 Space、Group 和 Tab 的完整激活。
- Git Diff 再次打开时刷新 `title` 和 `originalPath`。
- Commit File Diff 再次打开时刷新 `title`、`shortSha`、`subject` 和 `originalPath`。
- Editor/Markdown 再次打开时刷新 `explorerRoot`。
- 合并 Editor preview pin 与元数据更新，避免连续两次 state commit。
- Git/AI/History 全局查重命中其他 Space 时使用 `revealTab`，不再只激活隐藏 Group。

## 阶段 7：性能与重复逻辑清理

- `WorkbenchViewPool` 每次 state 变更只构建一次 `tabId -> owner` 索引，避免每个 Tab 重复扫描全部 Space/Group。
- 清理 `directionAxis`、`directionBefore`、`tabsForGroup`、`insertGroupNode` 等无必要导出或未使用代码。
- 合并重复的资源标题/路径辅助函数，但不为小函数增加新模块。
- 保持 `react-resizable-panels` 的 `onLayoutChanged`：该回调已经只在 pointer release 后触发；不添加额外 debounce 或手写 pointer 生命周期。

## 阶段 8：当前 v2 持久化验证

- 保持 `version: 2` 严格校验，不加入旧格式 fallback。
- round-trip 覆盖：
  - 递归 row/col 布局；
  - split sizes；
  - active Group / active Tab；
  - Tab 顺序；
  - Terminal cwd、blocks、自定义标题；
  - Editor/Markdown 路径和 explorerRoot；
  - Web Preview URL。
- 增加当前 v2 `saveState -> loadAll -> hydrate` 的存储层测试或等价边界测试。
- 确认 private terminal 和瞬态页面仍被丢弃，空分支正确折叠。

## 验收场景

- Web Preview 与 Editor preview 在类型、函数和 UI 文案中不再混淆。
- 隐藏 Web Preview 5 分钟内保留 iframe，超过 5 分钟释放；重新激活可以恢复。
- 隐藏 Markdown/Git Diff 收到真实 `visible=false` / `active=false`。
- 同一路径可以在多个 Group 打开，但只存在一份共享 Editor/Markdown 文档缓冲区。
- 任一视图编辑后其他视图同步更新，dirty 和保存结果一致。
- restored cold tab 拖入其他 Group 后立即显示内容。
- 拆分和关闭 Group 后用户比例不被重置为均分。
- 任意数量同轴 Group 的最小尺寸约束总和不超过 100%。
- 在 Space B 打开 Space A 已存在的 Git/AI/History 页面会切换并显示 Space A。
- Git rename diff 重新打开后使用最新 `originalPath`。
- 当前 v2 状态重启后恢复布局、比例、Group 和可恢复 Tabs。
- Terminal Tab 跨 Group 移动仍不重启、不改变 `terminalId`。

## 验证命令

- `pnpm exec biome check <changed-files>`
- `pnpm check-types`
- `pnpm test`
- `pnpm lint`
- `pnpm knip`
- `pnpm build`
- `pnpm analyze:eager`
- `git diff --check`

## 完成标准

- 所有高、中优先级审阅问题均已修复或由明确产品约束关闭。
- 重构遗留 Stack、重复激活和新增无用导出已清理。
- 当前 v2 持久化具有可重复的自动化 round-trip 证据。
- 类型检查和完整测试通过；lint/knip 不新增问题。

## 执行状态（2026-07-19）

- [x] 阶段 1–8 全部完成。
- [x] Web Preview 命名、5 分钟 iframe 回收及可见性测试完成。
- [x] 多 Group/Space 共享文档模型、独立视图状态、聚焦视图 LSP 所有权及关闭保护完成。
- [x] 冷标签 dirty 同步、并发保存补写和最后一个文档视图回收边界完成。
- [x] Group 比例、最小尺寸、cold tab 激活、跨 Space reveal 和 Git 元数据刷新完成。
- [x] 当前 v2 `saveState -> loadAll -> hydrate`、递归布局及可恢复 Tab round-trip 测试完成。
- [x] 类型检查、70 个测试文件 / 429 项测试、lint、生产构建、eager graph 和 diff 检查通过。
- [x] `pnpm knip` 仍因仓库既有的无关遗留项返回 1；针对本次新增/修改模块的过滤结果为空，未新增 knip 问题。
