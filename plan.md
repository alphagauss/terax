# Workbench 布局与动画性能重构记录

## 本次结果

本次重构统一了 Workbench 布局热路径与项目动画基准。核心原则是连续拖拽不做布局动画，离散状态变化复用语义动效，昂贵布局只提交一次。没有引入新的布局或动画运行时依赖，也没有启用全局平滑滚动。

## 已完成修改

### 1. 全项目动画基准

- 在 `src/styles/globals.css` 中建立四档语义时长：feedback 100ms、control 160ms、pane 150ms、surface 240ms。
- 建立 `ease-standard` 与 `ease-emphasized`，Tailwind 默认 transition 和 entrance animation 接入统一 token。
- 为生成的 shadcn 和 AI Elements 数字 duration 类保留兼容映射，业务代码不再新增零散毫秒值。
- 全局 `prefers-reduced-motion` 让 transition、animation 和程序化平滑滚动立即完成。
- 新增 `src/lib/motion.ts`，让 WAAPI 和 JavaScript 动画读取同一组 CSS 时长、缓动及 reduced-motion 状态，避免复制常量。
- 清理本次覆盖范围内的 `transition-all`、硬编码 duration 和重复 CSS transition。

### 2. Resizable 与 Sidebar Section

- `react-resizable-panels` 继续作为唯一 SplitView primitive，公共 handle 统一 hover、active、focus、disabled 和命中范围。
- 连续拖拽保持零 transition，只有用户释放 separator 后才读取最终尺寸并持久化。
- 修复 Section 展开后立即读取旧 DOM 高度的问题。标题点击使用已知的折叠状态和已保存尺寸，不再把折叠高度误写为展开高度。
- 展开时通过 imperative resize 恢复已保存像素高度；折叠、展开与拖拽持久化路径分离。
- `animateResizableLayout` 只服务轻量嵌套 pane 的离散开合，使用一次性 transition，并在完成、超时或被拖拽打断时清理。
- 删除 Sidebar 的 Document View Transition、`flushSync`、全局动画 scope 和相关双轨 CSS。

### 3. Primary 与 Secondary Sidebar

- 删除连续 `onResize` 中的业务状态写入、存储写入和 debounce timer。
- 用户拖拽完成后由根 `onLayoutChanged` 一次提交最终宽度和折叠状态。
- 快捷键或按钮触发的 imperative 开合直接同步已知目标状态，不依赖尚未完成的 React DOM 读取。
- 根 Workbench 几何保持瞬时变化，避免宽度动画反复触发 xterm、编辑器和其他 `ResizeObserver` 的昂贵重排。
- 侧栏内容使用短距离 transform 与 opacity 入场，保留基本视觉连续性而不拖动整个布局树逐帧重排。

### 4. Markdown 大纲

- 大纲可用时保持稳定 shell，关闭状态使用 `inert` 与 `aria-hidden` 隔离交互。
- 开合时只提交一次布局变化，正文使用 FLIP 平滑位移，大纲使用 clip、transform 和 opacity 展开或收起。
- WAAPI 时长和缓动读取全局 token；reduced motion 下直接完成。
- 快速反复点击时从当前视觉 transform 继续，旧动画可取消，不跳回固定起点。
- 拖拽宽度期间只通过 ref 更新 transform guide，释放后一次提交最终宽度，避免长文档持续 React 重渲染和 reflow。

### 5. 统一性能边界

- 默认只动画 transform 与 opacity，小型且边界明确的 surface 可使用 clip-path。
- 大型布局、长文档、终端、编辑器和带昂贵 observer 的 subtree 禁止逐帧动画 width、height、flex-basis 或 grid track。
- 动画和 pointer gesture 期间禁止逐帧 `setState`、store 写入、尺寸测量、终端 fit 及读写交错造成的 forced layout。
- 不使用 `transition-all`、Document View Transition、`flushSync`、全局 `scroll-behavior: smooth`、动画 rAF 循环或仅为动画增加的依赖。
- 详细的新组件复用顺序、允许项和禁止项已写入 `TERAX.md` 的 `Workbench layout and motion` 契约。

## 明确保留的性能例外

- Primary 和 Secondary Sidebar 不做根几何 transition，只做内容层合成动画。
- Markdown 拖拽不实时改变正文宽度，只移动 guide，释放后提交。
- 用户滚轮、虚拟列表和 Terminal 保持即时滚动。只有明确的程序化导航可以局部选择平滑滚动。

## 已执行验证

- `pnpm check-types`：通过。
- 变更文件的定向 Biome 检查：通过。
- `pnpm exec vite build`：通过。
- `pnpm lint`：退出码为 0，仍报告 41 个仓库既有或未纳入本次范围的 warning。
- `git diff --check`：通过。

按本次约定，没有继续展开测试套件或 Tauri 手工运行。合并前建议人工确认 Markdown 大纲快速反复开合、Sidebar Section 高度恢复，以及带多个 Terminal pane 时根侧栏开合无明显卡顿。
