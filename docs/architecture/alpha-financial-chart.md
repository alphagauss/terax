# Alpha 专业金融图表设计与参考项目指南

本文记录 Alpha 专业金融图表的目标边界、外部参考项目审查结论、建议阅读路径和分阶段实施顺序。后续开发应先阅读本文，再按当前任务定位少量参考源码，避免重复通读外部仓库。

本文是设计参考，不表示相关功能已经实现。Alpha 与 Terax 的进程和业务边界仍以 [Alpha 集成架构](./alpha-integration.md) 和根目录 `AGENTS.md` 为准。

## 已确定的方向

- 金融行情图使用 `lightweight-charts`，统计、分布和组合分析等普通图表继续使用 ECharts。
- Terax 自己拥有行情数据协议、React 组件 API、工具栏、主题、状态、持久化和场景适配层。
- 公共图表组件不直接请求 Alpha API，不认识回测 ID、实盘连接或 Workbench 标签。
- 数据管理、回测复盘和实盘模块通过薄场景适配层复用同一个图表组件。
- 第一阶段先完成专业行情浏览能力，不实现技术指标和完整绘图工具。
- 指标计算位置暂未最终决定，但图表侧必须先使用与计算引擎无关的指标描述和结果协议。
- `openalgo-charts` 是独立 Canvas 引擎，不作为 Terax 运行时图表引擎。它只用于参考内核分层、状态模型和交互设计。

## 当前 Terax 基线

- `package.json` 当前使用 `lightweight-charts ^5.2.0` 和 `echarts ^6.1.0`。两者职责已经分开，不需要为统一图表引擎重写 ECharts 统计图。
- 临时 K 线位于 [`AlphaFinancialChart.tsx`](../../src/modules/alpha/components/AlphaFinancialChart.tsx)，目前只在 [`AlphaDataPage.tsx`](../../src/modules/alpha/pages/AlphaDataPage.tsx) 的固定高度区域内使用。
- 现有组件已经做对了几个基础决定：图表实例只在挂载时创建，日线使用 `BusinessDay`，成交量使用独立 pane，主题切换通过 `applyOptions()` 完成，页面隐藏时保留 Canvas。
- 当前数据更新只有整体 `setData()`。[`getAlphaBars()`](../../src/modules/alpha/api.ts) 固定请求日线、前复权和最近 500 根，没有周期切换、历史分页或实时增量。
- 当前缺少专业行情图的固定 OHLC 信息栏、左侧回填、尾部跟随状态、精度与时区元数据、工具栏、快照导出、回测标记和实盘更新。
- 迁移时保留 `alphaBusinessDay()` 已有的时区不变量和测试，将它下沉到行情归一化模块。不要继续把新功能堆入当前组件形成新的单体实现。

## 外部源码位置与审查基线

假定开发者把参考项目放在 `D:\OneDrive\open`，这些目录只用于人工阅读，不得成为构建输入、运行时查找路径或 Terax 源码导入路径。

| 项目 | 本地目录 | 审查提交 | 定位 |
| --- | --- | --- | --- |
| [shioaji-pro-app](https://github.com/Sinotrade/shioaji-pro-app) | `D:\OneDrive\open\shioaji-pro-app` | `a6c9bd2` | 最接近 Terax 技术栈的直接实现参考 |
| [OpenTerminalUI](https://github.com/Hitheshkaranth/OpenTerminalUI) | `D:\OneDrive\open\OpenTerminalUI` | `fc16fd6` | 专业能力、边界条件和测试场景参考 |
| [openalgo](https://github.com/marketcalls/openalgo) | `D:\OneDrive\open\openalgo` | `f1329e23d` | React 图表外壳、工具栏和控制器参考 |
| [openalgo-charts](https://github.com/marketcalls/openalgo-charts) | `D:\OneDrive\open\openalgo-charts` | `6e55915` | 图表内核分层和状态模型参考，不直接移植 |
| [lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing) | `D:\OneDrive\open\lightweight-charts-drawing` | `5f2afc3` | Lightweight Charts 绘图插件候选 |
| [lightweight-charts-indicators](https://github.com/deepentropy/lightweight-charts-indicators) | `D:\OneDrive\open\lightweight-charts-indicators` | `31756c8` | JS 指标定义、元数据和结果协议参考 |

开始开发前运行 `git rev-parse --short HEAD` 检查本地版本。提交不同不要求重新通读整个项目，只在本文列出的关键文件发生实质变化或命中“重新审查条件”时定向复核。

## 参考价值总览

| 项目 | 第一阶段价值 | 后续价值 | 建议用法 |
| --- | --- | --- | --- |
| `shioaji-pro-app` | 高 | 高 | 吸收 LWC 5.2 生命周期、历史分页和实时尾部更新模式 |
| `OpenTerminalUI` | 高 | 高 | 提取专业行为清单、纯函数、性能模式和测试场景 |
| `openalgo` | 高 | 高 | 参考 React 外壳、工具栏、属性面板和 Controller 边界 |
| `openalgo-charts` | 中 | 高 | 参考内核模块划分、事件、状态和绘图描述符，不复制渲染器 |
| `lightweight-charts-drawing` | 低 | 高 | 绘图阶段先做小范围验证，再决定采用范围 |
| `lightweight-charts-indicators` | 低 | 中 | 指标阶段参考 descriptor，不预先绑定 OakScriptJS |

## 定向阅读指南

### shioaji-pro-app

优先阅读：

- `src/components/candle-chart.tsx`
- `src/lib/utils/kbars.ts`
- `src/lib/chart-indicators.ts`
- `src/lib/indicator-defs.ts`
- `src/lib/indicators.ts`
- `src/lib/theme-store.ts`

值得吸收的实现：

- 使用 `loadedKeyRef` 冻结标的和周期切换期间的实时更新，防止旧尾部写入新序列。
- 通过 `subscribeVisibleLogicalRangeChange` 在接近左边界时加载更早历史。
- 合并历史页后重新聚合跨分页边界的分钟 K 线，并重新拼接历史加载期间形成的实时尾部。
- 初始快照使用 `setData()`，实时当前 K 线使用 `update()`。
- 十字线 legend 使用 `requestAnimationFrame` 限流。
- 新 bar 完成时才触发指标重算，当前 bar 内 tick 不重算全量指标。
- 使用 pane stretch factor 保存和恢复窗格比例。
- 标的切换后恢复价格轴自动缩放，避免沿用前一个标的的价格范围。

不要直接移植：

- 约 1,500 行的 `CandleChart` 单体组件。
- Shioaji 合约、SSE quote、下单、止盈止损、trigger engine 和价格同步逻辑。
- 捕获并忽略所有 `series.update()` 异常的做法。Terax 应在更新前验证时间顺序，并记录真正的协议错误。
- 固定按天数拉取 1 分钟数据再在浏览器聚合所有周期的策略。Alpha 已有服务端周期和存储边界。

### OpenTerminalUI

第一阶段优先阅读：

- `frontend/src/shared/chart/ChartEngine.tsx`
- `frontend/src/shared/chart/types.ts`
- `frontend/src/shared/chart/rendererCore.ts`
- `frontend/src/shared/chart/chartUtils.ts`
- `frontend/src/shared/chart/rafBatcher.ts`
- `frontend/src/shared/chart/useRealtimeChart.ts`
- `frontend/src/services/chartDataService.ts`
- `frontend/src/components/chart/ChartCanvas.tsx`
- `frontend/src/components/chart/ChartAccessibilityLayer.tsx`

按需阅读：

- 回测复盘：`frontend/src/shared/chart/replay.ts`
- 多图同步：`frontend/src/shared/chart/ChartSyncContext.tsx`
- 导出：`frontend/src/shared/chart/ChartExport.ts`
- 绘图：`frontend/src/shared/chart/drawingEngine.ts`
- 指标窗格：`frontend/src/shared/chart/useIndicators.ts`
- 工作台：`frontend/src/components/chart-workstation/`
- 完整交互清单：`frontend/src/components/chart/TradingChart.tsx`

优先复用思想而不是组件代码：

- 把 K 线数据转换、尾部更新判断和 rAF 批处理写成纯函数。
- 为实时更新、回填、绘图、回放、同步和导出分别建立测试。
- 明确 `live`、`delayed`、`disconnected` 等行情 freshness 状态。
- 将可访问性描述层放在 Canvas 之外。
- 多图同步只传播时间、十字线等必要事件，不共享图表实例。

不要直接移植：

- 接近 3,000 行的 `TradingChart.tsx`。
- 直接暴露 `oakscriptjs.Bar` 和 `lightweight-charts` 类型的公共组件协议。
- `localStorage` 图表状态持久化。Terax 的共享可写状态必须遵循现有白名单和加锁约束。
- 一次引入 Renko、Kagi、Footprint、比较序列、绘图、指标和基本面覆盖等全部能力。

建议优先参考以下测试名称对应的行为：

- `ChartEngine.updateGuard.test.tsx`
- `TradingChart.realtime.test.tsx`
- `chartDataService.test.ts`
- `rafBatcher.test.ts`
- `RendererCore.performance.test.ts`
- `ChartSyncContext.test.tsx`
- `ChartExport.test.ts`
- `drawingEngine.test.ts`
- `replayUtils.test.ts`
- `useIndicators.panes.test.tsx`

### openalgo

优先阅读：

- `frontend/src/components/trading/ChartPane.tsx`
- `frontend/src/components/trading/DrawingRail.tsx`
- `frontend/src/components/trading/DrawingStyleBar.tsx`
- `frontend/src/components/trading/IndicatorSettingsDialog.tsx`
- `frontend/src/lib/trading/terminal.ts`
- `frontend/src/lib/trading/chartTheme.ts`
- `frontend/src/lib/trading/chartTypes.tsx`
- `frontend/src/lib/trading/drawTools.tsx`

值得吸收的设计：

- React `ChartPane` 负责工具栏、菜单、对话框和状态展示。
- 独立 Terminal Controller 负责图表实例、数据源、WebSocket、命令和事件回调。
- 绘图工具栏、浮动样式栏和指标设置对话框与图表内核分离。
- 指标和绘图能力按需动态加载。
- CSS 主题 token 通过单一适配器转换成图表主题。

不要直接移植：

- `terminal.ts` 的 OpenAlgo REST、WebSocket、交易、下单和 `localStorage` 逻辑。
- 对 `openalgo-charts` API 的调用。Terax 仍使用 Lightweight Charts。
- 英文硬编码工具栏和 tooltip。Terax 所有用户可见文本必须接入国际化。

### openalgo-charts

该项目是自研 Canvas 图表引擎，不基于 Lightweight Charts。只阅读其边界设计：

- `ARCHITECTURE.md`
- `src/core/chart.ts`
- `src/core/render-loop.ts`
- `src/core/invalidate-mask.ts`
- `src/model/data-layer.ts`
- `src/model/chart-state.ts`
- `src/model/chart-type-registry.ts`
- `src/model/indicator-registry.ts`
- `src/model/indicator-instance.ts`
- `src/input/crosshair.ts`
- `src/input/kinetic.ts`
- `src/feed/candle-builder.ts`
- `src/draw/controller.ts`
- `src/draw/types.ts`

值得吸收的设计：

- `model`、`input`、`render`、`feed`、`draw`、`indicator` 分层。
- 通过 registry 和 descriptor 扩展图表类型、指标和绘图工具。
- chart state 使用可版本化 JSON 表达，不持久化运行时实例。
- Candle Builder 明确成交量模式、迟到 tick 策略和当前 bar 更新语义。
- 绘图锚点保存 `{time, price}`，不保存像素坐标。
- 事件总线与 React UI 解耦。

不要吸收：

- Canvas、坐标轴、时间轴、pane、缩放和渲染循环实现。Lightweight Charts 已负责这些基础能力。
- OpenAlgo REST/WS feed 和交易层。
- 为未来能力提前建立六层可插拔 bundle 系统。Terax 应按实际功能渐进拆分。

### lightweight-charts-drawing

优先阅读：

- `src/core/drawing-manager.ts`
- `src/core/drawing.ts`
- `src/core/types.ts`
- `src/core/geometry.ts`
- `src/rendering/drawing-pane-view.ts`
- `src/interaction/`
- `src/registry/`

该项目直接面向 Lightweight Charts 5，适合作为后续绘图候选，但当前没有自动化测试。不能因工具数量多就直接整体接入。

正式采用前先建立隔离原型并验证：

1. 趋势线、水平线、矩形和 Fibonacci retracement。
2. 创建、取消、选中、移动锚点、整体拖动和删除。
3. 磁吸开关、缩放、滚动和高 DPI。
4. 历史数据 prepend 后锚点保持不变。
5. 图表隐藏和恢复后事件监听不重复。
6. JSON 导出、版本校验和恢复。
7. 多 pane 下只在目标 pane 命中。
8. Windows WebView 的 pointer、鼠标和触控行为。

若验证失败，只吸收 `DrawingManager`、geometry、序列化结构和少量基础工具，不移植全部 68 种绘图。

### lightweight-charts-indicators

优先阅读：

- `README.md` 中的 Output Format 和 Indicator Registry。
- `src/index.ts`
- `src/standard/sma.ts`
- `src/standard/ema.ts`
- `src/standard/macd.ts`
- `src/standard/rsi.ts`
- `tests/unit/`

该项目主要提供指标计算与 metadata registry，不提供完整 React 指标面板或自动 pane 渲染。其公共设计价值高于直接运行价值：

- 指标定义与指标实例分离。
- 输入参数、默认值、overlay 属性和 plots 使用描述符表达。
- 计算结果与图表 series 类型解耦。
- 动态指标选择器可以从 registry 生成。

当前不要引入 `oakscriptjs` 或把该项目的 `Bar`、`IndicatorResult` 作为 Terax 公共类型。Alpha 已包含 Python `ta-lib`，正式指标优先由 Alpha 计算，以保证图表、回测和 Agent 使用同一口径。

如果以后需要浏览器内即时预览，再评估 Web Worker 中的 JS 计算。不得同时维护没有差分测试的 Python 和 JavaScript 双实现。

## Terax 目标模块边界

建议在实际开发时形成以下结构，名称可以在首个实现任务中根据现有代码微调：

```text
src/modules/alpha/chart/
  model.ts
  normalize.ts
  controller/
    FinancialChartController.ts
    viewport.ts
    realtime.ts
  lightweight/
    createChart.ts
    seriesRegistry.ts
    theme.ts
    markers.ts
  components/
    FinancialChart.tsx
    FinancialChartFrame.tsx
    ChartToolbar.tsx
    ChartLegend.tsx
    ChartStatusOverlay.tsx
  scenes/
    AlphaMarketChart.tsx
    AlphaBacktestChart.tsx
    AlphaLiveChart.tsx
  pages/
    AlphaChartPage.tsx
```

职责约束：

- `model.ts` 不导入 Alpha API schema、React 或 `lightweight-charts`。
- `FinancialChartController` 拥有图表实例和命令，不拥有网络连接。
- `FinancialChart` 只负责 Canvas 宿主、生命周期和受控输入。
- `FinancialChartFrame` 负责专业工具栏、legend 和状态覆盖层。
- `scenes/` 连接具体 API、回测标记或实盘事件。
- `AlphaChartPage` 负责 Workbench 资源定位和页面级查询。
- 所有场景共享同一个行情归一化入口，不分别实现时间和精度转换。

不要为尚不存在的第二种渲染引擎设计通用 renderer interface。当前只需隔离 Lightweight Charts 类型，避免业务组件直接依赖它。

## 公共数据协议建议

日线交易日和盘中绝对时间必须显式区分：

```ts
type MarketTime =
  | { kind: "trading-day"; date: string }
  | { kind: "instant"; epochSeconds: number };

type MarketBar = {
  time: MarketTime;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  openInterest?: number | null;
};
```

证券元数据至少需要：

- `vtSymbol`、代码、名称、交易所。
- 交易所时区。
- `pricePrecision` 和 `minMove`。
- 成交量单位。
- 红涨绿跌或绿涨红跌约定。
- 支持的周期和复权方式。

不要根据当前 500 根数据猜测精度、时区或市场颜色约定。

指标协议先保留最小边界：

```ts
type ChartStudy = {
  id: string;
  name: string;
  pane: "main" | "separate";
  series: Array<{
    id: string;
    name: string;
    type: "line" | "histogram" | "band";
    points: Array<{ time: MarketTime; value: number | null }>;
  }>;
};
```

该协议不暴露 TA-Lib、OakScriptJS 或 Lightweight Charts 类型，因此后续可以替换计算位置。

## 第一阶段专业图表范围

第一阶段目标是让图表可作为日常行情浏览器使用：

1. 全尺寸独立 `alpha-chart` Workbench 页面。
2. 数据管理页复用相同组件的紧凑模式。
3. 蜡烛图、OHLC Bar 和收盘线。
4. 独立且可调整高度的成交量 pane。
5. 标的、周期、复权和图表类型工具栏。
6. 固定 OHLC、涨跌幅、成交量和成交额信息栏。
7. 十字线、最新价线、昨收参考线和价格轴标签。
8. 左侧历史分页、单飞请求和到达最早数据状态。
9. 用户离开实时尾部后停止自动跟随，并显示“回到最新”。
10. 加载、空数据、错误、延迟和断线状态。
11. 主题、精度、时区和涨跌色约定。
12. 截图和适配内容命令。
13. 交易标记、绘图和指标的扩展插槽，但不实现指标公式。

不要在第一阶段实现新闻、财经日历、社交分享、复杂图形工作区和几十种指标。

## 行情 API 与历史分页

当前 [`alpha/api/routes/bars.py`](../../alpha/api/routes/bars.py) 在没有显式 `start` 时可能使用总览最早时间，存储层读取完整区间后才截取最后若干根。分钟线规模扩大后不能满足专业图表的历史加载要求。

第一阶段应让存储和 API 支持真正的倒序限量查询：

- 初次加载最近一批 K 线。
- 以当前最早时间作为 `before` cursor 加载更早数据。
- 存储层执行倒序 `LIMIT`，响应再恢复时间升序。
- 响应提供 `has_more_before` 和实际覆盖范围。
- 前端按时间去重，拒绝非法 OHLC 和非单调时间。
- 历史 prepend 后恢复原 visible logical range。

后端输出 `amount` 时，前端 schema 必须同步接收。期货场景按需增加 `open_interest`。

## 图表性能不变量

- 图表实例只在宿主挂载时创建一次。
- 标的或周期初始快照使用 `setData()`。
- 实盘当前 bar 使用 `update()`，不为每个 tick 重建 React bars 数组。
- 同一时间戳替换当前 bar，更晚时间戳追加，迟到数据执行明确策略。
- 十字线和实时 tick 最多每动画帧更新一次 React 展示状态。
- `fitContent()` 只用于首次加载、标的切换或用户主动命令。
- 新 bar 到达不得重置用户缩放和滚动位置。
- 历史回填不得改变用户正在观察的屏幕内容。
- 页面隐藏时保留实例，暂停 resize、轮询、订阅和非必要绘制。
- 主题切换只应用 options，不重建 chart。
- 未启用指标或绘图时不加载对应代码、不创建 pane、不计算数据。

## 测试与验收路由

### 纯函数测试

- 日线 BusinessDay 不受本地时区影响。
- 分钟线时间戳和交易所时区显示正确。
- bars 排序、去重、非法值拒绝和分页合并。
- tick 聚合、成交量模式和迟到 tick 策略。
- 涨跌颜色、价格精度和成交量格式。
- viewport prepend 补偿。

### Controller 测试

- Strict Mode 重挂载后没有重复监听器。
- 标的切换期间不会写入旧行情。
- 同时间 bar 更新和新时间 bar 追加。
- 用户离开尾部后不自动滚回。
- 隐藏期间不 resize，恢复后只同步最终尺寸。
- 历史请求单飞且到达最早数据后停止。

### React 测试

- 工具栏命令和受控状态。
- loading、empty、error、delayed、disconnected 覆盖层。
- OHLC 信息栏在十字线离开时恢复最新 bar。
- 可访问性文本和所有用户可见文案国际化。
- 独立页和嵌入场景使用同一组件。

### 运行时验证

实现涉及真实布局、pane 拖动、可见范围、命中区域、WebView Canvas 或 ResizeObserver 时，按 [`ui-runtime-debugging.md`](../contributing/ui-runtime-debugging.md) 使用相同复现条件验证修改前后行为。

## 分阶段吸收顺序

### 阶段一：专业行情基础

- 以 `shioaji-pro-app` 为主要 LWC 实现参考。
- 以 `OpenTerminalUI` 的纯函数和测试为行为补充。
- 以 `openalgo` 的 `ChartPane + Controller` 为 React 边界参考。
- 完成数据模型、Controller、专业外壳、历史分页和独立页面。

### 阶段二：回测和实盘

- 接入回测交易标记、持仓区间和回放控制。
- 使用 Alpha HTTP 快照和 WebSocket 增量，断线后重新查询权威快照。
- 参考 OpenTerminalUI 的 replay、sync 和 realtime tests。

### 阶段三：绘图

- 对 `lightweight-charts-drawing` 执行隔离验证。
- 第一批只支持趋势线、水平线、矩形和 Fibonacci retracement。
- 绘图状态通过版本化 `{time, price}` JSON 表达，不保存像素。
- 通过测试后才扩大工具数量。

### 阶段四：指标

- 使用 engine-neutral `ChartStudy` 协议。
- 优先由 Alpha Python 和 TA-Lib 提供权威结果。
- 参考 `lightweight-charts-indicators` 的 registry 和 metadata，不绑定 OakScriptJS。
- 只有明确需要离线即时预览时才评估 Web Worker JS 计算。

## 需要重新审查外部源码的条件

出现以下情况时才重新阅读对应项目，不需要例行重读全部仓库：

- Lightweight Charts 升级了主版本或 pane、primitive、marker API。
- Terax 要实现实时 tick 聚合时，复核 Shioaji 和 OpenTerminalUI 的 realtime 模块。
- Terax 要实现回放或多图同步时，复核 OpenTerminalUI 对应模块和测试。
- Terax 要实现绘图时，复核 `lightweight-charts-drawing` 当前 manager、interaction、serialization 和测试现状。
- Terax 要实现指标时，复核 `lightweight-charts-indicators` registry、output schema 和依赖版本。
- Terax 考虑更换 Lightweight Charts 时，才重新评估 `openalgo-charts` 渲染内核。
- 本文列出的关键文件在本地参考仓库中已被删除、拆分或 API 发生实质变化。

若只是上游新增无关页面、券商适配或指标数量，不需要更新本文。
