# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项跨层任务，不重复长期架构和具体实现设计。Rust 与前端细节记录在 `docs/architecture/`，Python 实现基线记录在 [`alpha/docs/`](../../alpha/docs/README.md)。完成任务时同步更新对应长期文档；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：公共图表批次二，指标与多图分析。
- 当前任务：任务 5，指标 pane、legend 与管理界面。已完成。
- 下一任务：任务 6，多图时间范围与十字线同步。
- 已暂缓：独立 `alpha-market` 行情页，待公共图表能力稳定后重新安排。
- 阻塞：无。

## 当前任务

目标是把任务 4 的五类服务端指标形成工作台内的完整交互闭环，包括添加、参数与样式修改、显隐、删除、排序、legend、overlay 和独立 pane，并保持图表实例、主价格 series、viewport 与语义 pane 比例稳定。

- `FinancialChartController` 使用增量 study registry 管理 series、参考水平线和 pane，不重建 chart 或主价格 series。
- 成交量可见时占第一个辅助 pane，其后每个 visible separate study 独占一个 pane；成交量隐藏时指标自动前移，最多 4 个独立指标 pane。
- 十字线从现有单个订阅的 `seriesData` 一次提取 OHLC 与全部指标值，并通过同一个 rAF 快照提交 legend。
- 指标入口只出现在 panel density。Dialog 首次打开时才懒加载并查询 definition；数据页 compact 场景不加载、不保存指标。
- 工作台 Chart Panel 持久化完整 instance 顺序、参数、显隐和样式；删除实例同时清理其语义 pane 比例。

完成标准：五类指标可以选择、计算、渲染、编辑和恢复；局部指标失败不影响主 K 线；未启用指标时不加载 Dialog、不请求计算、不创建 study series 或 pane。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

长期边界见 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的“图表状态和领域模型”。本节只记录任务 5 的前端、Controller、持久化和运行时验证范围；Python 协议继续使用任务 4 已完成的接口。

### 目标与范围

- 只渲染任务 4 的 line 与 histogram，不增加 area、band、用户脚本、收藏、模板或按周期显隐规则。
- overlay 固定进入 pane 0；RSI 与 MACD 每个实例独占一个 pane，不支持手动合并或自定义 routing。
- 样式首版只保存颜色、1 到 4 线宽及 histogram 正负颜色，不增加输出显隐、透明度或 plot style。
- definitions 只在 Dialog 打开时查询；计算仍由 Scene 按 visible instances 和页面可见性启用。
- 指标实例只属于工作台 Chart Panel 配置，compact 数据页继续传空实例且不显示入口。

### 实施步骤

1. 增加 study routing、series payload、默认 instance 和配置 schema 测试，先锁定 pane 上限、稳定 ID 与序列化边界。
2. 在 Controller 增加增量 study registry、动态 pane 重排、水平线、主题样式、语义比例和统一十字线快照。
3. 把 Scene 的 definition、calculation result、loading 和局部 error 传入 Frame 与图表宿主，不改变主行情状态。
4. 增加懒加载 IndicatorDialog、紧凑 legend 与添加、编辑、显隐、删除、排序操作，并补齐中英文文案。
5. 扩展 Chart Panel 配置持久化和迁移测试，运行 10,000 点、4 指标转换性能检查及完整前端、Alpha 回归。
6. 在真实 Tauri WebView 按同一复现约定验证添加删除、pane 比例、主题、最小高度、页面隐藏恢复和实例稳定性。

### 验证标准

- overlay 始终进入 pane 0；成交量和 separate studies 按可见顺序连续排列，不留下空 pane，Controller 对第 5 个 separate study 做保护。
- 参数、显隐、排序、主题和样式更新复用已有 chart 与未变化 series；主价格 series 身份、viewport 和历史加载状态不改变。
- RSI 30/70 与 MACD 0 使用低强调水平线，axis label 关闭；MACD histogram 按正负值使用独立颜色。
- pane 比例用 `main`、`volume` 和 instance ID 保存；重排前读取、重排后恢复，删除实例移除其比例键。
- 十字线每帧只提交一个包含 bar 与全部 study values 的快照，不增加订阅；离开十字线后 legend 恢复最新值。
- Dialog bundle 与 definition 请求只在 panel 用户首次打开指标入口后发生；隐藏实例不请求计算且不创建 series。
- 真实 Tauri 复现约定：给定工作台单图、Modern 主题和真实 Alpha 日线，连续添加 SMA、BOLL、RSI、MACD，拖动 pane 后修改参数、主题、显隐与顺序；预期主图不重建、比例保持、最多 4 个独立 pane、最小面板仍可操作，隐藏页面恢复后只同步最终尺寸。

### 执行结果

- `FinancialChartController` 已增加 output 级增量 study registry。未变化 series 复用，隐藏或删除只移除对应 series；overlay 固定在 pane 0，成交量和最多 4 个 separate studies 按当前配置连续排列，不留下空 pane，也不重建 chart 或主价格 series。
- pane 结构变化前会按 `main`、`volume` 和 instance ID 捕获 stretch factor，重建空辅助 pane 后恢复。成交量隐藏时指标前移，显隐和排序后比例继续跟随 instance；删除实例时 Chart Panel 同时清理对应持久比例键。
- line 与 histogram payload 由纯函数构建。MACD 柱使用实例正负色，未配置时回退主题涨跌色；RSI 30/70 与 MACD 0 使用无轴标签的低强调 price line。10,000 点、4 指标的 payload 性能测试通过 120ms 预算。
- Controller 继续只有一个 `subscribeCrosshairMove`。同一 `seriesData` 在一个 rAF 快照中提交行情和全部指标值；legend 在十字线离开后恢复服务端结果的最新有限值。
- 工作台 toolbar 新增指标入口，IndicatorDialog 通过动态 import 懒加载，并在打开后才查询 definition。Dialog 支持五类指标搜索、参数、颜色、线宽和 MACD 正负色；legend 支持编辑、显隐、删除和排序。数据页 compact 场景不显示入口、不加载 Dialog、不保存实例。
- Chart Panel 配置现在有界保存 instance ID、顺序、参数、显隐、样式和语义 pane 比例；旧配置自动补 `studies: []`。重复 ID、第 5 个独立指标和第 9 个总指标会在持久化边界或 UI 阻止。
- 真实 Tauri WebView 使用本地 Alpha 日线复验通过。SMA 与 BOLL overlay、RSI 与 MACD pane、十字线值、成交量显隐、参数修改、主题切换、排序、显隐和比例恢复均正常；chart DOM 与主价格 Canvas 始终保持身份。达到 4 个独立 pane 时第 5 个在 Dialog 明确阻止；面板缩到约 282px 高时管理入口仍可操作，legend 内部滚动且面板无外层溢出；页面隐藏恢复后 chart 与 Canvas 保持挂载。
- 完整前端测试为 228 个文件、1167 个测试，`pnpm check-types`、`pnpm lint` 和 eager graph 检查通过，lint 只保留仓库既有的 25 个 warning 和 2 个 info。指标 Python/API 回归为 50 个测试通过，唯一 warning 仍是环境缺少 `pytest-asyncio` 对既有配置项的提示。
- 运行时新增的六个测试指标、成交量显隐、pane 拖动、面板缩放和主题变化均已通过 UI 恢复；随后关闭本次精确 debug 进程，并把共享工作台 JSON 恢复到测试前内容。端口 1420 和 9223 均已释放。

## 外部参考规则

- 两个本地参考仓库同时供 Codex 和开发者检索，不局限于本文已列出的文件或既有建议。
- 新增 Alpha 功能、架构或重要交互前，优先查找两个项目的相关实现、测试和边界行为，再结合 Terax 约束决定采用、组合、简化或拒绝。
- 参考仓库不是 Terax 的构建或运行时依赖。Terax 从第一版就拥有自己的协议、组件 API、状态和持久化边界。
- `shioaji-pro-app` 只吸收产品思想、公开行为和架构经验，不复制或改写其 AGPL 源码。

## 阶段进度

### 已完成基础

- [x] 建立 Alpha 共享服务、通用代理、数据目录、统一行情模型和有界历史读取基础。

### 阶段一：公共图表和工作台内核

- [x] 移植并裁剪公共金融图表内核，替换临时 K 线组件。
- [x] 加固公共图表的平移边界、视图重置、紧凑高度适配和 TradingView 署名。
- [x] 建立工作台布局协议、Panel Registry 和稳定面板挂载层。
- [x] 完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。
- [x] 让现有数据页和工作台图表面板使用受控周期、复权和图表类型。
- [x] 完成专业价格、时间与 pane 语义。
- [x] 完成图表导出与可访问性。
- [x] 完成指标领域协议与首批服务端计算。
- [x] 完成指标 pane、legend 与管理界面。
- [ ] 在公共图表能力稳定后重新安排独立行情页。

### 后续阶段

- [ ] 阶段二：数据同步、质量检查、失败恢复和领域 API 边界。
  - [x] 完成 A 股日线同步的最小质量与定向重试闭环。
- [ ] 阶段三：策略、回测和复盘。
- [ ] 阶段四：实时行情和模拟交易。
