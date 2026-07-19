# 通用查找组件破坏式重构方案

## 目标

- 删除 Header 全局搜索框和本次暂存区中的补丁式搜索面板实现。
- 以 VS Code 的分层思路重建查找能力：通用视图只负责交互和布局，各业务面板独立持有搜索状态并适配自己的搜索引擎。
- 首批接入编辑器、终端和 Git History，后续面板只需实现小型控制器，不再修改 Header 或 App 的查询路由。
- 保持实现短小、类型明确、无全局 DOM 查询、无遗留兼容分支。

## 已确认的问题基线

- 编辑器查找框输入 `a` 后，输入选区被改为 `[0, 1]`；继续输入 `b` 后查询值变成 `b`，而不是 `ab`。
- 560px 视口下编辑器宽约 308px，面板可视宽约 292px，但内部滚动宽度仍为 413px，操作区被裁切。
- 选择范围由面板实例闭包注入 `SearchQuery.test`，关闭后没有可靠地回收，存在重新打开后范围状态与界面不一致的风险。
- Ask AI 通过全局 `document.querySelector` 判断任意搜索面板，隐藏标签中的面板也会影响当前标签。
- 每次输入和导航都会扫描整篇文档并构造大量匹配对象，职责和性能成本都集中在视图层。

## 设计边界

### 通用层

新增 `src/modules/find/`，只包含可复用 React 视图和最小公共类型：

- `FindWidget`：受控查询框、结果计数、上一项、下一项、关闭、大小写、全词和正则开关。
- `FindReplaceWidget`：在 `FindWidget` 上增加替换行、单次替换、全部替换、保留大小写和可选的选择范围开关。
- `FindHandle`：仅暴露 `open()`，供快捷键和命令面板触发当前面板的本地查找。

通用层不导入 CodeMirror、xterm、Git History、编辑器翻译命名空间，也不保存业务查询状态。能力通过可选属性表达，没有能力的面板不渲染对应按钮。

### 编辑器适配层

编辑器使用独立的 CodeMirror Panel 和状态模型：

- Panel 负责挂载 React 视图、焦点进入和关闭，不直接计算匹配集合。
- 查询变更只更新查询状态，不调用会重新选择输入框的 `findNext`。
- 打开时从编辑器选区或当前单词初始化查询；重复快捷键选中现有查询文本。
- 选择范围使用不可变范围值，关闭面板时明确清除，并恢复为无范围查询。
- 匹配计数使用 CodeMirror 游标按需遍历，并设置显示上限；查询、文档或范围未变化时复用结果。
- 替换字符串解析、正则捕获和保留大小写放到纯函数中，并由单元测试覆盖。

### 终端适配层

- 搜索插件和查找组件都归 `TerminalPane` 所有。
- `TerminalPane` 将查询、大小写和正则选项转换为 xterm SearchAddon 参数。
- App 不再保存 SearchAddon 实例，也不再中转查询、导航或清除操作。

### Git History 适配层

- 过滤状态和查找组件都归 Git History 面板所有。
- 现有过滤 API 收敛为面板内部调用，对 App 只暴露 `FindHandle`。

### App 与 Header

- 删除 `SearchInline`、`SearchTarget` 和 Header 搜索相关属性。
- Header 只保留窗口、布局和命令入口职责。
- App 根据当前活动标签取得对应 `FindHandle`；`search.focus` 和命令面板只调用 `open()`。
- 不使用自定义全局事件，也不使用 `document.querySelector` 跨面板探测状态。

## 响应式与交互规则

- 编辑器面板绝对定位在内容层上方，不参与 CodeMirror 正文布局；终端和 Git History 使用同样的覆盖式定位。
- 面板最大宽度为 340px，右侧保留 24px 间距，实际宽度受业务容器约束，不依赖 viewport media query。
- 输入区使用 `min-width: 0`，按钮区允许按容器宽度隐藏次要文本，但核心导航和关闭操作始终可达。
- 查找行与替换行共享 CSS subgrid 列，两个输入框的左右边界始终一致。
- 替换行使用 `0fr` 与 `1fr` 网格轨道完成轻量开合；关闭时短暂保留节点完成退出动画，再次打开会取消待关闭状态。
- 选区候选既在打开时读取，也会响应面板打开后的用户选区变化；查找导航产生的匹配选区不会覆盖候选范围。
- 选项按钮的 hover 只改变底色，选中态额外显示主题蓝色边框。
- Escape 关闭并将焦点还给业务面板；Enter 和 Shift+Enter 分别导航下一项和上一项。
- 所有按钮提供 tooltip、`aria-label` 和 pressed/disabled 状态。

## 删除范围

- `src/modules/header/SearchInline.tsx`
- `src/components/ui/search-replace-panel.ts`
- `src/components/ui/search-replace-panel.css`
- `src/modules/editor/lib/searchPanel.ts`
- Header 搜索框的 App 路由、ref、SearchAddon 注册和兼容方法
- Ask AI 中依赖全局搜索面板 DOM 的补丁
- 已被新实现替代的翻译键和死代码

## 测试与验收

### 自动化

- 查询输入不会触发输入文本全选，连续输入 `a`、`b` 得到 `ab`。
- 普通文本、全词、大小写、正则、捕获组替换和保留大小写均有纯函数测试。
- 选择范围关闭后不泄漏，文档变化后计数缓存失效。
- 终端和 Git History 适配器只验证参数映射与本地状态，不依赖 Header。
- 运行 `pnpm lint`、`pnpm check-types`、`pnpm test`、`pnpm build`、`pnpm analyze:eager` 和 `git diff --check`。

### 真实运行时

- 在真实 Tauri WebView 中连续输入 `ab`，查询值和结果高亮保持正确。
- 重复 Ctrl/Cmd+F 选中查询文本。
- 启用选择范围后关闭再打开，范围状态已清除。
- 隐藏标签中的查找面板不影响当前标签的 Ask AI。
- 宽布局和窄分栏中均无横向裁切，核心操作可见并可点击。
- 编辑器、终端和 Git History 都能通过统一快捷键打开自己的本地查找组件。

## 执行顺序

1. 固定真实运行时缺陷基线。
2. 删除旧 Header 搜索和暂存区补丁实现。
3. 实现通用查找视图与公共 `FindHandle`。
4. 实现编辑器状态模型、Panel 适配和纯函数测试。
5. 接入终端与 Git History，简化 App 和命令面板契约。
6. 完成静态检查、测试、构建和真实 Tauri 回归。

## 完成标准

- 搜索功能不再经过 Header 或 App 查询路由。
- 通用层不包含任何具体搜索引擎依赖。
- 当前补丁文件和兼容代码全部删除，没有并行旧实现。
- 已知输入覆盖、范围泄漏、跨标签干扰和窄布局裁切问题均无法复现。
- 所有质量门禁和真实运行时验收通过。
