# 通用 Workbench 工作组破坏式重构计划

## 目标

将主工作区改造成一套统一的工作组布局系统：

- 主工作区由可递归拆分的工作组组成。
- 每个工作组拥有自己的 TabBar 和激活 Tab。
- Terminal、Editor、Markdown、Preview、Git、AI Diff，以及未来的量化、回测页面都作为统一的 Workbench Tab 运行。
- Tab 可以在组内排序、跨组移动，或拖到工作组上、下、左、右创建新组。
- Explorer 文件可以拖入指定工作组，或拖到边缘创建新组并打开。
- Terminal 不再拥有内部 paneTree。一个 Terminal Tab 只对应一个终端会话。
- 不保留旧布局模型、旧持久化格式或双轨兼容代码。

工作分支：`refactor/workbench-groups`

## 非目标

- 不重写 Rust PTY、shell spawn、OSC、DormantRing 或 xterm 会话层。
- 不复制 VS Code 的依赖注入和大型 service 体系。
- 不实现浮动窗口或跨进程拖拽。
- 不实现工作组内部的第二套拆分系统。
- 不在本次重构中实现同一脏文件的多个同步编辑视图。

## 最终模型

### Workbench Tab

Tab 是工作区中可打开页面的统一单位。Terminal Tab 保存稳定的 `terminalId`，布局移动不得重启对应会话。

### Workbench Group

每个工作组保存：

- `id`
- 有序 `tabIds`
- `activeTabId`

### Workbench Layout

布局使用递归树：

- group leaf 指向一个 Workbench Group
- split branch 保存 `row` 或 `col`
- branch 保存稳定 id、children 和最终分栏比例

### Space Workbench

每个 Space 独立保存：

- layout root
- groups
- activeGroupId

Tab 实体集中保存，Space 和 Group 只保存归属与顺序。

## 核心不变量

- 每个 Tab 必须且只能属于一个 Group。
- 每个 Group 必须至少拥有一个 Tab。
- `activeTabId` 必须存在于所属 Group。
- `activeGroupId` 必须存在于所属 Space。
- 最后一个 Group 的最后一个 Tab 不能被普通关闭操作移除。
- Group 变空时立即移除，单 child split 立即折叠。
- 相同方向的相邻 split 尽量扁平化。
- 移动 Terminal Tab 只能改变归属，不能改变 `terminalId`。
- Tab id、Group id、Layout node id、Terminal id 不承担彼此语义。
- pointer gesture 期间不写持久化、不重建布局、不反复执行终端 fit。

## 模块结构

```text
src/modules/workbench/
├── types.ts
├── model.ts
├── model.test.ts
├── useWorkbench.ts
├── viewRegistry.tsx
├── dragSession.ts
├── dragSession.test.ts
├── WorkbenchGrid.tsx
├── WorkbenchSurface.tsx
├── WorkbenchViewPool.tsx
├── workbench.css
└── index.ts
```

保持模块数量受控。只有纯模型、运行时 hook、布局组件、页面宿主和拖拽协议五类职责。Space 序列化继续由 `modules/spaces` 持有，工作组组件保持在 `WorkbenchGrid.tsx` 内，不为单个小职责增加文件。

## 页面宿主

页面渲染通过统一 registry 分发，不在 App 或 WorkspaceSurface 中继续增加 `kind` 条件分支。

每个页面在 `viewRegistry.tsx` 中集中注册渲染入口。复制拆分策略由纯模型创建函数控制，可恢复页面再显式加入 Space serializer；瞬态页面默认不持久化。

所有已挂载页面使用稳定容器。Tab 跨组移动时只移动容器，不重新创建业务页面，避免终端重启、编辑器脏缓冲丢失、预览刷新或滚动位置重置。

## Terminal 改造

### 保留

- Rust PTY 命令和会话状态
- `useTerminalSession`
- renderer pool
- DormantRing 与 snapshot
- foreground job 检测
- xterm 搜索、OSC cwd、agent signal

### 移除

- `TerminalTab.paneTree`
- `TerminalTab.activeLeafId`
- `PaneTreeView`
- terminal `panes.ts`
- `splitLeaf`、`removeLeaf`、`focusPane` 等终端布局 API
- terminal context menu 中的内部 pane 拆分

### 新行为

- 一个 Terminal Tab 保存一个 `terminalId`。
- Split Right 或 Split Down 创建新 Terminal Tab 和新 terminal session，并放入相邻工作组。
- Split and Move 只移动已有 Terminal Tab，PTY 不重启。
- 终端退出时关闭对应 Tab；若它是最后一个 Space 的最后一个 Tab，则关闭窗口。

renderer pool 不得驱逐可见终端。缓存上限只限制隐藏 renderer，可见终端数量决定必要 slot 数量。

## TabBar 改造

- 从 Header 移除全局 TabBar。
- 每个 Workbench Group 顶部渲染自己的 TabBar。
- Header 只保留全局导航、Space、搜索、AI、设置和窗口控制。
- TabBar 右键菜单提供快速向右拆分和“拆分和移动”方向菜单。
- 组内拖拽调整顺序，跨组拖拽移动 Tab，边缘落点创建新组。
- Group 内容区点击或聚焦时更新 activeGroupId。

## Explorer 拖拽

现有 Explorer 使用 Pointer Events，继续沿用该技术路线，不切换到会被 Tauri 截获的 HTML5 DnD。

统一 drag session 支持：

- `{ kind: "tab", tabId }`
- `{ kind: "resource", path }`

命中优先级：

1. Group TabBar 插入位置
2. Group 左、右、上、下边缘
3. Group 中心
4. Explorer 自身文件移动目标

边缘命中只更新覆盖层。释放指针时一次提交布局状态。

## 持久化

采用新的非兼容 Space 状态：

```text
SpaceState
└── workbench
    └── recursive layout
        ├── group tabs
        └── split children and sizes
```

- 不读取或迁移旧 `tabs + activeTabIndex + terminal tree` 格式。
- 遇到旧状态时为 Space 创建新的单工作组 Terminal。
- 只序列化可恢复 Tab。
- AI Diff 等瞬态页面不写入持久化。
- 用户完成 separator 交互后才保存最终 sizes。

## App 路由改造

- `activeId` 改为当前 Space 的 activeGroup 和 activeTab 推导值。
- 搜索、状态栏、AI live context、selection、编辑器命令都路由到当前 active Tab。
- Ctrl+Tab 在当前 Space 的全部工作组中按 MRU 切换。
- Pane focus next/previous 改为工作组 focus next/previous。
- Pane split right/down 改为 Workbench group split。
- Block Terminal 输入栏暂时继续服务全局 active Tab，后续如需要可下沉到 Group chrome。

## 删除范围

完成替换后删除：

- `src/modules/tabs/lib/useTabs.ts`
- terminal pane model 与对应测试
- `PaneTreeView.tsx`
- 旧 Space tab serializer 与测试
- Header 中全局 TabBar props 和渲染
- App 中 paneTree、activeLeafId、splitPane、closePane、focusPane 相关逻辑
- 只服务旧扁平 Tab 模型的辅助函数和测试

不保留 deprecated alias、兼容 wrapper 或旧新模型转换层。

## 实施顺序

### 阶段 1：纯模型

- 建立 Workbench types、layout operations 和不变量测试。
- 覆盖 add、activate、close、move、split、collapse、reorder。
- 建立单 Terminal Tab 单 terminalId 类型。

### 阶段 2：运行时状态

- 用 `useWorkbench` 替换 `useTabs`。
- 保留现有打开文件、Preview、Git、AI Diff 等产品行为。
- 所有创建函数支持明确目标 Group。
- Space 切换改为选择对应 Space 的 active Group。

### 阶段 3：工作组 UI

- 建立递归 `WorkbenchGrid`。
- 使用 `react-resizable-panels` 渲染 split branch。
- 每个 Group 渲染独立 TabBar 和内容 host。
- 建立稳定页面容器池和 view registry。

### 阶段 4：Terminal 扁平化

- 删除 TerminalStack，改为单 Tab 单 TerminalView。
- 更新 refs、搜索、cwd、close guard、AI live bridge 和 agent 路由。
- 删除终端内部布局代码。
- 调整 renderer pool 的可见 slot 规则。

### 阶段 5：拖拽和菜单

- 统一 Tab 和 Explorer pointer drag session。
- 实现组内排序、跨组移动、中心投放和四边拆分。
- 实现右键拆分和拆分移动菜单。
- 添加中英文文案。

### 阶段 6：持久化和清理

- 替换 Space store、boot 和 persistence。
- 删除旧 serializer、旧 hooks、旧 tests 和无用 exports。
- 清理 App 协调器和跨模块 import。

### 阶段 7：验证

- `pnpm exec biome check` 检查变更文件。
- `pnpm check-types`
- `pnpm lint`
- `pnpm test`
- `git diff --check`
- 必要时按 `docs/contributing/ui-runtime-debugging.md` 使用真实 Tauri runtime 验证复杂拖拽、布局、焦点和终端 resize。

## 必测场景

- Terminal 向右和向下拆分，新终端继承 cwd。
- Terminal Tab 跨组移动不重启、不丢输出。
- Editor 脏 Tab 跨组移动不丢内容。
- Tab 拖回另一个组后空 Group 自动折叠。
- Explorer 文件拖到中心和四个边缘。
- 多层 row/col 嵌套布局 resize。
- Space 切换后恢复各自 group layout 和 active tab。
- 关闭 group 最后一个 Tab 后焦点回退正确。
- Ctrl+Tab、搜索、AI context 和状态栏只跟随 active Group。
- 多个可见终端不会互相驱逐 renderer。
- 应用重启后只恢复新格式中允许持久化的页面。

## 完成标准

- 主工作区只有一套拆分模型。
- 每个工作组拥有独立 TabBar。
- Terminal 不再包含 paneTree。
- 页面接入只需要新增 Tab 类型和 registry definition，不修改 App 布局分支。
- 旧模型文件、兼容代码和冗余 API 已删除。
- 前端类型检查、Lint 和测试通过。
- 复杂拖拽和多终端布局在真实 Tauri WebView 中通过手工验证。
