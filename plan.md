# Alpha 金融图表三批八任务实施计划

## 文档定位

本文是 Alpha 公共金融图表后续工作的可执行计划，覆盖此前根目录中已经完成的 AI 文件工具重构计划。长期架构、不变量和模块边界仍以 [`AGENTS.md`](./AGENTS.md)、[Alpha 综合量化工作站](./docs/architecture/alpha-quant-workstation.md) 和 [Alpha 集成架构](./docs/architecture/alpha-integration.md) 为准。

计划已经确认采用三批八个任务：

1. 受控公共图表配置。
2. 专业价格、时间与 pane 语义。
3. 图表导出与可访问性。
4. 指标领域协议与首批服务端计算。
5. 指标 pane、legend 与管理界面。
6. 多图时间范围与十字线同步。
7. 对比标的叠加。
8. 实时行情尾部与“回到最新”。

本文的目标是让后续开发可以按任务逐项执行，不需要重新决定核心边界、参考文件、状态归属、测试范围或完成标准。开始每个任务前仍应检查目标文件的最新实现，若代码已经演进，以不破坏本文不变量为前提调整具体文件名。

## 当前状态

- 计划基线：Terax `e2fca03`，`fix(alpha): harden financial chart viewport`。
- 当前阶段：阶段一，公共图表和工作台内核。
- 当前任务：任务 2，专业价格、时间与 pane 语义。已完成。
- 下一任务：任务 3，图表导出与可访问性。
- 启动状态：任务 3 尚未开始。独立行情页继续暂缓，当前优先补齐公共 K 线内核。
- 当前阻塞：无。
- 本计划不改变已经确认的阶段二数据闭环、阶段三回测复盘和阶段四实时模拟交易边界。

## 已有能力与剩余缺口

当前 Terax 已经具备：

- `MarketBar`、`MarketTime`、`MarketInterval` 和统一行情归一化。
- 日线 `BusinessDay` 与盘中绝对时间分离。
- `/api/alpha/bars` 的范围查询和排他 `before` 历史分页。
- 单实例 `FinancialChartController`。
- 蜡烛图、OHLC Bar、收盘线和成交量 pane。
- 主题切换、rAF 尺寸更新、十字线信息栏和尾部 `update()` 防护。
- 历史 prepend 后的 logical range 补偿。
- 历史请求单飞、最早数据、加载、空数据、错误和重试状态。
- 平移软边界、视图重置、紧凑面板高度适配和合规 TradingView 署名。
- 数据页和工作台图表面板复用 `MarketChartScene`。
- 24 列 Alpha 工作台、稳定 PanelPool、主标的 follow/pinned 和版本化布局。

仍需完成的主要缺口：

| 能力 | 当前状态 | 本计划任务 |
| --- | --- | --- |
| 独立行情页 | 尚未注册 `alpha-market` 页面 | 当前计划外，公共图表稳定后重新安排 |
| 周期与复权切换 | Chart Panel 已使用受控周期和复权；数据页保持固定 `d + forward` | 已完成，任务 1 |
| 工作台图表配置 | 已严格保存周期、复权和图表类型，旧 `{}` 自动迁移 | 已完成，任务 1 |
| 证券精度、时区和市场颜色 | 图表仍使用通用格式与主题颜色 | 任务 2 |
| 昨收线、明确最新价线 | 未建模 | 任务 2 |
| 成交量显示与 pane 比例 | 固定显示，比例只设初始 8:2 | 任务 2 |
| PNG、CSV 导出 | 未实现 | 任务 3 |
| Canvas 外可访问数据 | 只有图表整体 `aria-label` | 任务 3 |
| 指标协议与服务端计算 | 后端有指标函数，但无图表指标 API | 任务 4 |
| 指标 series 与 pane 管理 | 未实现 | 任务 5 |
| 多图范围与十字线同步 | 未实现 | 任务 6 |
| 对比标的 | 未实现 | 任务 7 |
| 实时增量与状态 | 未实现 | 任务 8 |

## 已确认不在本计划内的功能

以下功能本轮不安排，不得在执行八个任务时顺手加入：

- Renko、Kagi、点数图、Line Break、Footprint 和其他替代 K 线形态。
- 浏览器从 1 分钟数据聚合所有周期。
- 一次接入几十种指标、用户 JavaScript 指标或浏览器端指标公式系统。
- 完整绘图对象树、绘图模板、远端绘图同步和画线警报。
- 图上直接下单、拖动委托线、止盈止损和条件触发器。
- 第三套固定 1 到 6 图布局引擎。
- 使用 `localStorage` 保存 Alpha 图表、指标、pane 或同步状态。
- 新闻、财经日历、基本面覆盖层、公司行动覆盖层和社交分享。
- 在当前数据协议没有 session 元数据前实现盘前、盘后和夜盘阴影。
- 独立 `alpha-market` Workbench 页面及其标签、导航和恢复状态。公共图表能力稳定后再单独安排，不阻塞当前 K 线内核和工作台面板。

阶段三需要的交易标记、持仓区间和回放值得吸收，但在完成本计划前不混入公共行情图任务。届时应分别建立“回测标记”和“回放控制”任务。复杂绘图继续等前四个 Alpha 阶段形成稳定闭环后再规划。

## 强制架构不变量

### 复用层次

所有任务必须保持以下单向依赖：

```text
Alpha API / MarketDataHub
  -> 业务场景组件 MarketChartScene
    -> 公共外壳 FinancialChartFrame
      -> React 宿主 FinancialChart
        -> FinancialChartController
          -> Lightweight Charts
```

- Controller 可以使用 Lightweight Charts 类型，但不得请求 Alpha API、读取工作台配置或认识页面类型。
- `FinancialChart` 只桥接 DOM 生命周期、主题、可见性、尺寸和命令，不拥有行情查询。
- `FinancialChartFrame` 只负责工具栏、legend、状态和扩展 UI，不认识 FastAPI response、回测 ID 或工作台网格。
- `MarketChartScene` 拥有查询、分页、证券元数据、指标结果、对比数据和实时事件连接。
- 普通页面只拥有页面导航、选择器和本页面状态。
- `AlphaChartPanel` 只解释 panel config、标的绑定和可见性，不复制 Scene 逻辑。
- `AlphaPanelGrid` 与 `AlphaPanelPool` 只负责布局和稳定挂载，不直接请求行情。

### 数据和进程边界

- Alpha FastAPI 是证券元数据、历史行情、指标计算和未来实时领域状态的权威边界。
- React 继续通过 Rust 通用代理访问 `/api/alpha`，不得直连 Python 进程或管理服务凭据。
- Rust 不解释周期、复权、指标、行情状态或比较基准等领域语义。
- 日线和周线继续使用无时区交易日，盘中数据必须携带明确偏移。
- 不根据当前 K 线样本猜测价格精度、交易所时区、成交量单位或涨跌色约定。

### 图表运行时

- Lightweight Charts 是唯一金融图表引擎，不增加 renderer interface 或第二引擎适配层。
- 图表实例只在宿主挂载时创建，标的、周期、复权、类型、主题、指标和对比切换不能重建 chart。
- 初始快照和历史修订使用 `setData()`，稳定尾部使用 `update()`。
- 新 bar、指标更新和对比数据不得隐式调用 `fitContent()`。
- 历史 prepend 不改变用户正在观察的屏幕内容。
- 十字线、同步事件和实时 tick 最多每动画帧进入一次 React 状态。
- 未启用指标、同步、对比或实时功能时，不加载对应模块、不创建额外 series 或 pane、不建立订阅。

### 持久化

- 工作台 panel config 只保存纯 JSON，不保存 React、Controller、Canvas、Query 或 series 实例。
- 工作台配置继续经过 Panel Registry descriptor 校验和共享 store 的合并写入。
- 旧的 `{}` Chart Panel 配置必须通过默认值迁移，不允许导致现有工作台整体回退为默认布局。
- 图表同步只持久化开关和组配置，运行时范围、十字线坐标和来源 ID 不落盘。
- 独立行情页暂缓期间不新增页面状态或第二套全局 store。后续恢复该任务时，首版只保留当前挂载期间的页面选择；若要求跨进程恢复，再单独扩展版本化页面状态。

### UI、性能和可访问性

- 所有新增用户可见文本同步更新英文和简体中文资源。
- 业务 Select 使用 `@/components/controls/select.tsx`，菜单使用 `@/components/menu/`。
- 工具栏必须支持紧凑模式，不能让工作台小面板被完整行情页控件挤压。
- pane 拖动期间不更新 React 状态或共享 store，只在交互结束后读取最终比例。
- 导出、可访问性表格、指标选择器和对比选择器都必须有明确上限。
- 运行时调试只在对应任务的真实尺寸、pane、同步或 WebSocket 行为需要时执行，并遵守 `docs/contributing/ui-runtime-debugging.md`。

## 外部参考基线与使用规则

### shioaji-pro-app

- 本地路径：`D:\OneDrive\open\shioaji-pro-app`
- 审查版本：`a6c9bd2`
- 许可证：AGPL-3.0-only
- 使用规则：只吸收产品思想、公开行为、边界条件和测试场景，禁止复制、轻改或翻译其源码。

重点参考文件：

| 文件 | 关键代码与行为 | Terax 采用方式 |
| --- | --- | --- |
| `src/components/candle-chart.tsx` | `TIMEFRAMES`、`loadedKeyRef`、历史加载、实时尾部、`paneStretchRef`、指标 legend、价格线和 `resetView()` | 独立实现周期切换防旧数据、pane 比例恢复、实时 key guard 和指标交互 |
| `src/lib/utils/kbars.ts` | `wallClockToUtc()`、`aggregate()` 和历史窗口工具 | 只参考时间桶和分页边界测试，不采用浏览器全周期聚合 |
| `src/lib/chart-indicators.ts` | overlay 与独立 pane 的 series 创建、参考水平线和初始 pane 高度 | 参考 pane 分配行为，改为 Terax Controller 内的增量 registry |
| `src/lib/indicator-defs.ts` | 指标 definition、instance、参数、样式、显示周期、顺序和收藏 | 只采用 definition 与 instance 分离思想，不采用 `localStorage` 或完整目录 |
| `src/lib/indicators.ts` | 纯指标函数和多输出结果 | 不复制公式，Terax 使用 Alpha 服务端已有指标实现 |

特别值得保留的行为：

- 标的或周期加载期间冻结实时更新，避免旧尾部写入新 series。
- 历史页与实时尾部合并时，明确处理分页边界和新 bar。
- 新 bar 完成时才触发全量指标重算，当前 bar 内 tick 不重复计算全部历史。
- 指标重建前读取 pane stretch factor，重建后恢复用户比例。
- 指标 legend 随十字线更新并按 rAF 限流。

明确拒绝的实现方式：

- 单体 `CandleChart` 持有查询、交易、指标、订单和 UI 的全部职责。
- 捕获并忽略所有 `series.update()` 异常。
- 在浏览器按天读取大量 1 分钟数据并聚合全部周期。
- 使用 `localStorage` 保存指标与布局。
- 图表内部直接调用下单或条件触发器协议。

### OpenTerminalUI

- 本地路径：`D:\OneDrive\open\OpenTerminalUI`
- 审查版本：`fc16fd6`
- 许可证：MIT
- 使用规则：可以在确认目标文件来源后依法复用，但本计划默认采用 Terax 自有模型和独立实现，避免把多个大型组件和项目协议带入 Terax。

重点参考文件：

| 文件 | 关键代码与行为 | Terax 采用方式 |
| --- | --- | --- |
| `frontend/src/shared/chart/ChartEngine.tsx` | 单实例 chart、多 series、历史 backfill、初始 viewport、rAF resize | 对照 Controller 生命周期、配置切换和 backfill 测试 |
| `frontend/src/shared/chart/rendererCore.ts` | 一次遍历生成 candle、line、volume，尾部 payload 独立构建 | 扩展 Terax `buildFinancialSeriesData()` 时继续保持纯函数和单次遍历 |
| `frontend/src/shared/chart/chartUtils.ts` | `canApplyTailUpdate()`、时间桶和格式工具 | 对照尾部更新不变量，保留 Terax 更严格的 append/replace 判断 |
| `frontend/src/shared/chart/ChartExport.ts` | PNG、CSV、稳定文件名 | 参考导出行为和测试，补齐 Tauri WebView 失败反馈 |
| `frontend/src/components/chart/ChartAccessibilityLayer.tsx` | `aria-live` 摘要和有限 OHLC 表格 | 独立实现可聚焦、有限行数的中文和英文可访问层 |
| `frontend/src/shared/chart/useIndicators.ts` | overlay、独立 pane、独立 scale、最大 pane 数和 series 清理 | 参考 pane routing 与资源回收，计算改由 Alpha 服务端完成 |
| `frontend/src/shared/chart/indicatorCatalog.ts` | instance ID、pane routing、配置归一化 | 采用可版本化 instance 与 routing，拒绝 localStorage 模板和用户 JS |
| `frontend/src/contexts/CrosshairSyncContext.tsx` | 来源 slot、group 和 rAF 合并 | 用于任务 6 的十字线同步行为 |
| `frontend/src/shared/chart/ChartSyncContext.tsx` | 来源 ID 和批处理 publish | 用于任务 6 的轻量事件总线，不照搬其固定时间窗口行为 |
| `frontend/src/shared/chart/comparison.ts` | `buildComparisonPoints()` 和 normalized/price 模式 | 参考稳定排序与归一化测试，Terax 首版只开放相对收益模式 |
| `frontend/src/shared/chart/useRealtimeChart.ts` | 订阅、tick/bar 合并、连接状态和时间桶 | 参考状态清单与纯聚合测试，不复制每 tick 重建 React bars 数组的方式 |
| `frontend/src/shared/chart/replay.ts` | 回放索引、日期、session 和速度纯函数 | 留给阶段三回放任务，不进入当前八项实现 |
| `frontend/src/shared/chart/drawingEngine.ts` | 版本化绘图 schema、命中、锁定、层级和同步计划 | 只保留未来设计参考，本计划不实现 |

必须对照的测试：

- `frontend/src/__tests__/ChartEngine.updateGuard.test.tsx`
- `frontend/src/__tests__/ChartExport.test.ts`
- `frontend/src/__tests__/TradingChart.exports.test.tsx`
- `frontend/src/__tests__/useIndicators.panes.test.tsx`
- `frontend/src/__tests__/CrosshairSyncContext.test.tsx`
- `frontend/src/__tests__/ChartSyncContext.test.tsx`
- `frontend/src/__tests__/useRealtimeChartAggregation.test.ts`
- `frontend/src/__tests__/TradingChart.realtime.test.tsx`
- `frontend/src/__tests__/replayUtils.test.ts`
- `frontend/src/__tests__/drawingEngine.test.ts`

OpenTerminalUI 的 `TradingChart.tsx` 接近 3,000 行，包含导出、回放、绘图、警报、公司行动、基本面、比较和同步。它只作为交互清单，不作为 Terax 组件结构参考。

## 目标模型与公共契约

以下类型是实施目标，名称可以按最新代码微调，但职责和序列化边界不得改变。

### 图表查询与显示配置

```ts
type MarketAdjust = "none" | "forward" | "backward";
type MarketChartInterval = Exclude<MarketInterval, "tick">;

type MarketChartOptions = {
  interval: MarketChartInterval;
  adjust: MarketAdjust;
  chartType: FinancialChartType;
};

type MarketChartDensity = "compact" | "panel";
```

- `interval` 与 `adjust` 决定查询键和 `dataKey`。
- `chartType` 只改变 Controller options，不发起不必要的行情请求。
- `density` 只决定工具栏密度和功能入口可见性，不改变数据语义。
- 数据页使用固定 `d + forward` 和 `compact`。
- 工作台图表面板使用 `panel`，选项来自 panel config。
- 独立行情页恢复实施后再增加 `full` density，并由页面拥有选项状态，不改变公共配置协议。

建议的 Chart Panel 配置：

```ts
type AlphaChartPanelConfig = {
  interval: MarketChartInterval;
  adjust: MarketAdjust;
  chartType: FinancialChartType;
  showVolume: boolean;
  paneRatios: Record<string, number>;
  studies: ChartStudyInstance[];
  comparisons: ChartComparisonConfig[];
};
```

任务 1 只写入 `interval`、`adjust` 和 `chartType`。任务 2 增加 `showVolume` 和 `paneRatios`，任务 5 和任务 7 再通过 descriptor 默认值补充后两项。每次扩展都必须保证旧配置缺失字段时使用默认值。`tick` 是行情事件粒度，不是当前公共 K 线可选择周期；图表只接受 `1m`、`1h`、`d` 和 `w`。

### 证券图表元数据

```ts
type ChartMarketMetadata = {
  vtSymbol: string;
  name: string;
  exchange: string;
  timezone: string;
  minMove: number | null;
  pricePrecision: number | null;
  volumeUnit: string | null;
  priceColorConvention: "up-red" | "up-green";
  intervals: MarketChartInterval[];
};

type ChartPriceReference = {
  previousClose: number | null;
  referenceTime: MarketTime | null;
};
```

- 后端证券详情应显式返回 `timezone`、颜色约定和成交量单位，不能让前端维护重复交易所业务表。
- `price_tick` 映射为 `minMove`，精度使用有界纯函数计算并覆盖 0.25、0.05、0.01、0.001 等非十进制和小数 tick。
- `ChartMarketMetadata` 只保存证券静态语义。`previousClose` 会随周期、复权和查询锚点变化，必须由 `/bars` 使用同一复权语义返回，不能塞入证券详情或根据当前样本写回元数据。
- `d` 和 `w` 的 reference close 是最新 bar 的前一根已完成 bar close；`1m` 和 `1h` 使用最新 bar 所属交易时段之前的最近已完成交易日 close。无可用前序数据时返回 `null`。

### 指标定义、实例和结果

```ts
type ChartStudyPane = "main" | "separate";
type ChartStudySeriesKind = "line" | "histogram";

type ChartStudyDefinition = {
  type: "sma" | "ema" | "boll" | "rsi" | "macd";
  pane: ChartStudyPane;
  params: Array<{
    key: string;
    defaultValue: number;
    min: number;
    max: number;
    step: number;
  }>;
  outputs: Array<{
    id: string;
    kind: ChartStudySeriesKind;
  }>;
  levels: number[];
};

type ChartStudyInstance = {
  instanceId: string;
  type: ChartStudyDefinition["type"];
  params: Record<string, number>;
  visible: boolean;
  styles: Record<
    string,
    {
      color: string;
      lineWidth: 1 | 2 | 3 | 4;
      positiveColor?: string;
      negativeColor?: string;
    }
  >;
};

type ChartStudyResult = {
  instanceId: string;
  pane: ChartStudyPane;
  outputs: Array<{
    id: string;
    kind: ChartStudySeriesKind;
    points: Array<{ time: MarketTime; value: number | null }>;
  }>;
  levels: number[];
};
```

- Definition 是服务端权威目录，Instance 是用户配置，Result 是计算结果。
- UI 使用稳定的 study type、参数 key 和 output ID 组合 i18n key，不能直接显示服务端英文名称。
- 服务端不返回主题颜色，颜色由前端 instance 样式和主题决定。
- `instanceId` 在复制、排序、pane 重建和持久化后保持稳定。
- 首版每个 oscillator instance 使用独立 pane，不支持手动合并多个指标到一个 pane。
- 首版最多 4 个独立指标 pane，超过上限在 UI 阻止，不静默丢弃。

建议新增接口：

```text
GET  /api/alpha/studies
POST /api/alpha/studies/calculate
```

建议计算请求：

```json
{
  "vt_symbol": "000001.SZSE",
  "interval": "d",
  "adjust": "forward",
  "start": "2024-01-01",
  "end": "2026-08-27",
  "studies": [
    {
      "instance_id": "study-1",
      "type": "sma",
      "params": { "period": 20 }
    }
  ]
}
```

服务端根据 definition 计算最大 warmup，向前多读取必要历史，只返回请求显示区间内的点。客户端不得把完整 K 线数组回传给服务端做计算。

### 多图同步事件

```ts
type ChartSyncCompatibility = {
  interval: MarketChartInterval;
  adjust: MarketAdjust;
};

type ChartTimeRangeEvent = {
  sourcePanelId: string;
  groupId: string;
  compatibility: ChartSyncCompatibility;
  range: { from: MarketTime; to: MarketTime };
};

type ChartCrosshairEvent = {
  sourcePanelId: string;
  groupId: string;
  compatibility: ChartSyncCompatibility;
  time: MarketTime | null;
};
```

- 同步使用实际时间，不传播 logical index。
- 首版只处理 `interval + adjust` 完全相同的图表。
- 接收方按自己的 bars 查找同时间 bar，并使用本地 close 设置 crosshair price。
- 事件由来源 panel ID 防环，Controller 内部命令用 mutation guard 防止二次发布。

### 对比配置

```ts
type ChartComparisonConfig = {
  vtSymbol: string;
  color: string;
};

type ChartComparisonSeries = {
  vtSymbol: string;
  name: string;
  color: string;
  points: Array<{ time: MarketTime; value: number }>;
};
```

- 首版最多 3 个对比标的。
- 只提供相对收益模式，第一条有效 close 归一为 0%。
- 主 K 线继续使用右侧绝对价格轴，对比线使用独立左侧百分比轴。
- 不开放原始价格模式，避免不同量级标的造成误导。

### 实时状态

```ts
type MarketRealtimeStatus =
  | "live"
  | "delayed"
  | "stale"
  | "reconnecting"
  | "disconnected";

type MarketDataKey = {
  vtSymbol: string;
  interval: MarketChartInterval;
  adjust: MarketAdjust;
};

type MarketBarDelta = {
  key: MarketDataKey;
  sequence: number;
  bar: MarketBar;
  final: boolean;
  volumeMode: "cumulative" | "incremental";
};
```

- `sequence`、`final` 和 `volumeMode` 必须由协议明确，前端不能猜。
- 断线恢复先取权威快照，再消费新序列增量。
- 迟到 bar 不直接吞掉：同 bucket 更新，更新后的旧 bucket 触发受控重校准，更早未知数据请求快照或回填。

## 目标目录建议

不要求一次创建全部目录。每个任务只增加实际使用的文件。

```text
alpha/
  api/routes/
    studies.py
  chart/
    studies.py

src/modules/alpha/
  chart/
    accessibility/
      ChartAccessibilityLayer.tsx
    comparison/
      normalize.ts
    components/
      FinancialChart.tsx
      FinancialChartFrame.tsx
      MarketChartToolbar.tsx
    controller/
      FinancialChartController.ts
    export/
      chartExport.ts
    lightweight/
      data.ts
      studies.ts
    scenes/
      MarketChartScene.tsx
    studies/
      IndicatorDialog.tsx
      model.ts
    sync/
      ChartSyncContext.tsx
    model.ts
  market/
    metadata.ts
    model.ts
    normalize.ts
  realtime/
    MarketDataHub.ts
    aggregation.ts
```

如果某个目录只有一个很小文件，应优先放入现有相邻目录，不为形式一致创建空层级。

## 批次一：历史行情图闭环

## 任务 1：受控公共图表配置

### 目标

在不新增独立行情页的前提下，让现有数据页和工作台图表面板通过同一个可配置 `MarketChartScene` 使用公共图表。周期、复权和图表类型成为显式配置，不再硬编码在 Scene 内；成交量显隐与 pane 比例留到任务 2 一次正确完成。

### 必须阅读的参考

Terax：

- `src/modules/alpha/chart/scenes/MarketChartScene.tsx`
- `src/modules/alpha/chart/components/FinancialChartFrame.tsx`
- `src/modules/alpha/pages/AlphaDataPage.tsx`
- `src/modules/alpha/workstation/components/AlphaChartPanel.tsx`
- `src/modules/alpha/workstation/panelRegistry.ts`
- `src/modules/alpha/workstation/store.ts`
- `src/modules/alpha/workstation/components/AlphaPanelPool.tsx`
- `alpha/api/routes/securities.py` 的现有详情接口

外部参考：

- shioaji-pro-app `src/components/candle-chart.tsx` 的 `TIMEFRAMES` 和标的/周期加载 key。
- OpenTerminalUI `frontend/src/shared/chart/types.ts` 的 `ChartTimeframe` 与 `ChartEngineProps`。
- OpenTerminalUI `frontend/src/shared/chart/ChartToolbar.tsx` 的控件分组，只参考行为，不采用全部选项。

### 设计

1. 在 `market/model.ts` 增加 `MarketAdjust`，在 `chart/model.ts` 增加 `MarketChartOptions` 和 density 类型。当前 options 只包含周期、复权和图表类型。
2. `MarketChartScene` 改为接收受控 `options`、`onOptionsChange` 和 `density`，不在内部单独保存 `chartType`。
3. 查询键和 `dataKey` 固定包含 `vtSymbol + interval + adjust`。任何一项变化都切换到独立 React Query cache。
4. `getAlphaBars()` 继续使用现有 API，不新增周期聚合。
5. 前端增加最小 `getAlphaSecurity(vtSymbol)` 和查询键，复用现有 `/securities/{vt_symbol}`。本任务只消费详情中的既有目录字段和 `intervals`，任务 2 再扩展价格元数据。
6. 周期选择只展示证券详情声明的 `intervals` 与前端 `MarketChartInterval` 交集，明确排除 `tick`。无详情时只展示当前有效周期，不猜测其他周期存在。
7. 数据页保持紧凑模式和 `d + forward`，由页面拥有图表类型状态，不增加周期、复权、完整证券选择器或对比入口。
8. Chart Panel descriptor 使用带默认值的严格配置 schema。旧 `{}` 自动归一化为：

```json
{
  "interval": "d",
  "adjust": "forward",
  "chartType": "candlestick"
}
```

9. `AlphaPanelProps` 增加受控 `onConfigChange`，PanelPool 将其绑定到按 panel ID 更新配置的纯函数。配置更新只替换目标 panel，不修改 grid、binding 或其他 panel。
10. 周期或复权变化时，清除只属于旧 dataKey 的十字线展示，不清除其他查询缓存。

### 预计修改文件

- 修改 `src/modules/alpha/chart/model.ts`
- 修改 `src/modules/alpha/market/model.ts`
- 修改 `src/modules/alpha/chart/scenes/MarketChartScene.tsx`
- 修改 `src/modules/alpha/chart/components/FinancialChartFrame.tsx`
- 修改 `src/modules/alpha/api.ts` 和 `src/modules/alpha/query.tsx`
- 修改 `src/modules/alpha/pages/AlphaDataPage.tsx`
- 修改 `src/modules/alpha/workstation/components/AlphaChartPanel.tsx`
- 修改 `src/modules/alpha/workstation/components/AlphaPanelPool.tsx`
- 修改 `src/modules/alpha/workstation/panelRegistry.ts`
- 修改 `src/modules/alpha/workstation/model.ts`、`layout.ts`、`store.ts` 和测试
- 修改 Alpha 中英文资源和相关组件测试

### 测试

- Scene 查询键包含标的、周期和复权。
- 旧请求晚返回时不会覆盖新 dataKey。
- 支持周期只来自证券详情，未知值和 `tick` 不进入选择器。
- 无效 panel config 被 descriptor 拒绝，旧 `{}` 使用默认值恢复。
- 更新一个 panel config 不改变其他 panel 或网格坐标。
- 数据页和 Chart Panel 都渲染同一个 `MarketChartScene`。
- 所有控件文案、title、aria-label 有中英文翻译。

### 完成标准

- 工作台图表面板可以选择周期、复权和图表类型。
- 数据页和工作台面板没有复制 bars 查询、分页合并或 Controller 代码。
- 工作台保存并恢复每个图表面板的三项配置。
- 切换配置不会重建 Lightweight Charts 实例。

## 任务 2：专业价格、时间与 pane 语义

### 目标

让图表使用权威证券元数据呈现精度、最小跳动、交易所时区、涨跌颜色、昨收和最新价，并让成交量 pane 的显示和用户比例在配置变化中稳定。

### 必须阅读的参考

Terax：

- `alpha/api/models.py` 的 `SecurityCatalogDetail`
- `alpha/api/routes/securities.py`
- `alpha/api/routes/bars.py` 的 `_exchange_timezone()` 和 `_bar_time()`
- `src/modules/alpha/api.ts` 的证券 schema
- `src/modules/alpha/market/normalize.ts`
- `src/modules/alpha/chart/controller/FinancialChartController.ts`
- `src/modules/alpha/chart/lightweight/data.ts`

外部参考：

- shioaji-pro-app `candle-chart.tsx` 中标的切换后的 `autoScale` 恢复、`paneStretchRef` 和 price line。
- OpenTerminalUI `rendererCore.ts` 中 previous close 参与颜色计算的方式。
- OpenTerminalUI `TradingChart.tsx` 中价格轴位置、scale transform 和 high/low price line。只采用精度、参考线和 pane 行为，不开放全部 surface 开关。

### 设计

1. 扩展证券详情响应和前端 schema，返回 `timezone`、`price_color_convention`、`volume_unit` 和 `price_tick` 等静态证券元数据。
2. 扩展 `/bars` 响应和 `MarketBarPage`，返回与本次 `interval + adjust` 使用同一复权锚点的 `reference_close` 和 `reference_time`。所有历史分页返回相同参考值，不把它混入 bars 数组。
3. 新增 `getAlphaSecurity(vtSymbol)` 和 `alphaQueryKeys.security(vtSymbol)`，Scene 复用查询缓存。
4. 增加纯函数 `pricePrecisionFromMinMove()`：
   - `null` 或非正数返回 `null`。
   - 最大精度限制为 8。
   - 使用容差判断十进制位，覆盖 0.25 和 0.05，不直接使用字符串小数长度。
5. Controller 增加 `setMarketMetadata()` 和 `setPriceReference()`，只调用 chart/series options，不重建 series。
6. `priceFormat` 使用元数据 precision 与 minMove。legend 的 `Intl.NumberFormat` 使用相同精度。
7. 盘中 time scale 使用交易所时区格式化。格式化函数只消费后端返回的 IANA timezone，不根据 WebView 系统时区猜测。
8. 涨跌颜色通过 `FinancialChartPalette` 映射市场约定：
   - `up-green` 使用现有 success/destructive。
   - `up-red` 交换涨跌颜色。
   - 主题切换只重算 palette。
9. 昨收线使用独立 price line：虚线、低强调、轴标签可见、标题国际化。没有权威 previous close 时不创建。
10. 最新价线显式配置，避免依赖库默认值。其颜色随最后一根 bar 相对 previous close 的方向变化。
11. `showVolume=false` 时先隐藏 volume series，再使用 `moveToPane(0)` 把隐藏 series 暂存到主 pane，让空的 volume pane 被安全移除；重新显示时使用 `moveToPane()` 创建第一个辅助 pane并恢复比例。不能保留一条不可见但占高度的空 pane。
12. pane 比例处理：
    - Controller 提供读取和应用 stretch factor 的方法。
    - 用户拖动过程中不写 React 状态。
    - host 的 pointerup 结束后读取最终比例，只有变化时通知外壳。
    - 比例使用 `main`、`volume` 和未来 study instanceId 等语义键保存，不依赖会随显隐变化的 pane 数字索引。
    - Chart Panel 把比例保存到 `config.paneRatios`；独立行情页恢复实施后只保存在页面本地。
    - 指标任务加入额外 pane 后继续使用同一比例模型。
13. 页面或面板太矮时，保持主价格 pane 优先，成交量 pane 不低于 Lightweight Charts 支持的最小高度，不允许把主图压成不可读区域。

### 预计修改文件

- 新增 `alpha/common/market_metadata.py`，集中交易所时区、颜色约定和成交量单位
- 修改 `alpha/api/models.py`、`alpha/api/routes/securities.py` 和 `alpha/api/routes/bars.py`
- 修改 `src/modules/alpha/api.ts` 和 `src/modules/alpha/query.tsx`
- 新增 `src/modules/alpha/market/metadata.ts` 及测试
- 修改 `src/modules/alpha/chart/model.ts`
- 修改 `src/modules/alpha/chart/controller/FinancialChartController.ts` 及测试
- 修改 `FinancialChart.tsx`、`FinancialChartFrame.tsx` 和对应测试
- 修改 Chart Panel 配置 schema、配置更新测试和中英文资源

### 测试

- 精度函数覆盖常见和非十进制 tick。
- 交易所时区格式化不受测试环境本地时区影响。
- `up-red` 和 `up-green` 对 candle、volume、latest line 使用一致颜色。
- previous close 缺失、为零和存在时的 line 生命周期正确。
- 不同 interval/adjust 的 reference close 使用各自查询语义，历史分页间保持一致。
- 元数据、主题和图表类型切换不重建 chart。
- volume 隐藏和恢复不丢失 bars，不重置时间范围。
- pointer 拖动期间不写 store，结束后只提交一次最终 pane 比例。

### 运行时验证

本任务涉及真实 pane 拖动、时间格式和 WebView 计算尺寸，必须先完整阅读 `docs/contributing/ui-runtime-debugging.md`，并在真实 Tauri WebView 中复验：

- 最小工作台面板高度。
- 8:2 初始比例和手动调整后比例。
- 隐藏、显示成交量后的恢复。
- 主题、标的、周期切换后的 viewport 和价格轴。

### 完成标准

- 价格和时间语义来自证券元数据。
- 昨收、最新价、axis label 和 legend 精度一致。
- 成交量 pane 可控且不会因配置变化丢失用户比例。
- 紧凑和全尺寸页面都没有裁剪或不可操作区域。

## 任务 3：图表导出与可访问性

### 目标

为工作台图表面板提供 PNG 和 CSV 导出，并为所有 Canvas 图表提供有限、可操作的文本摘要与 OHLC 表格。紧凑数据页默认隐藏导出入口，工作台小面板通过菜单承载操作。

### 必须阅读的参考

- OpenTerminalUI `frontend/src/shared/chart/ChartExport.ts`
- OpenTerminalUI `frontend/src/components/chart/ChartAccessibilityLayer.tsx`
- OpenTerminalUI `frontend/src/__tests__/ChartExport.test.ts`
- OpenTerminalUI `frontend/src/__tests__/TradingChart.exports.test.tsx`
- Terax `src/components/ai-elements/conversation.tsx` 的 Blob 下载方式
- Lightweight Charts 5.2 `IChartApi.takeScreenshot()` 类型与行为

### 设计

1. 将现有 `resetRevision` 命令桥收敛为公共 `FinancialChartHandle`：

```ts
type FinancialChartHandle = {
  resetView(): void;
  takeScreenshot(): HTMLCanvasElement | null;
};
```

2. `FinancialChartFrame` 持有 handle，重置和 PNG 导出直接调用命令，不用递增 revision。
3. 新增纯函数：
   - `buildChartExportFilename()`。
   - `buildMarketBarsCsv()`。
   - `escapeCsvCell()`，即使当前字段主要为数字也不建立不安全前提。
4. CSV 列固定为：`time,open,high,low,close,volume,amount,open_interest`。
5. 导出最多处理 50,000 根已加载 bars。超过上限时拒绝并显示本地化说明，不能在 WebView 主线程构造无界字符串。
6. 交易日原样输出 `YYYY-MM-DD`，盘中时间输出带偏移或 UTC ISO，不能按本地日期截断。
7. PNG 默认不包含十字线和临时 tooltip。截图背景与当前主题一致，透明背景需要在导出时铺设当前 surface color，避免外部查看器显示黑底。
8. 下载失败必须显示现有通知系统中的本地化错误，不静默 `console.warn`。
9. 新增 `ChartAccessibilityLayer`：
   - `aria-live="polite"` 摘要只在标的或选中 bar 变化后更新。
   - 提供可聚焦的“图表数据表”入口。
   - 表格最多包含最近 20 根或当前可见范围中的 20 根，不渲染完整历史。
   - 表格包含 time、OHLC、volume，格式与视觉 legend 一致。
10. `FinancialChartFrame` 的 panel density 通过紧凑菜单显示导出入口，compact 默认隐藏导出操作；可访问性摘要和有界数据表不因密度关闭。

### 预计修改文件

- 新增 `src/modules/alpha/chart/export/chartExport.ts` 及测试
- 新增 `src/modules/alpha/chart/accessibility/ChartAccessibilityLayer.tsx` 及测试
- 修改 `FinancialChartController.ts`，增加 screenshot 命令
- 修改 `FinancialChart.tsx`，公开稳定 `FinancialChartHandle`
- 修改 `FinancialChartFrame.tsx`，接入重置、PNG、CSV 和可访问性入口
- 修改 Alpha 中英文资源和通知错误文案

### 测试

- 文件名处理空值、空格、路径字符、中文标的和不同周期。
- CSV 时间、空扩展字段、转义、行序和换行稳定。
- PNG 调用正确 chart 实例并触发一次下载。
- screenshot 不可用和 Blob URL 不可用时显示错误。
- 可访问性摘要在十字线离开后恢复最新 bar。
- 表格最多 20 行，按钮和表头全部国际化。

### 完成标准

- 工作台图表面板可导出当前主题下的 PNG，以及不超过 50,000 根上限的全部已加载 bars CSV。
- 导出不改变 viewport、crosshair 或用户 pane 比例。
- 键盘和屏幕阅读器用户可以访问图表摘要和有限数据表。
- 未显示导出或表格入口的紧凑场景不增加额外 Canvas 或大量 DOM。

## 批次二：指标与多图分析

## 任务 4：指标领域协议与首批服务端计算

### 目标

建立 Alpha 权威、图表引擎无关的指标 definition 和批量计算协议，首批支持 SMA、EMA、BOLL、RSI 和 MACD。此任务只完成协议、计算、前端边界模型和查询，不创建指标 pane UI。

### 必须阅读的参考

Terax：

- `alpha/backtest/indicator.py`
- `alpha/tests/unit_tests/test_indicator.py`
- `alpha/api/routes/bars.py`
- `alpha/api/container.py`
- `src/modules/alpha/api.ts`
- `src/modules/alpha/chart/model.ts`

外部参考：

- shioaji-pro-app `src/lib/indicator-defs.ts` 的 definition/instance 分离和参数范围。
- OpenTerminalUI `frontend/src/shared/chart/types.ts` 的 config/result 形状。
- OpenTerminalUI `frontend/src/shared/chart/IndicatorManager.ts` 的 catalog 行为，只参考清单和测试，不采用浏览器计算和用户 JS。

### 后端设计

1. 新增 `alpha/chart/studies.py`：
   - 集中首批 definition。
   - 校验类型、参数、范围和输出。
   - 调用现有 `Indicators`，不复制公式。
   - 统一把 NumPy 的 NaN 转为 `null`。
   - 保证输出时间与 bars 一一对应且升序。
2. 新增 `GET /api/alpha/studies` 返回 definition 目录。
3. 新增 `POST /api/alpha/studies/calculate`：
   - 请求最多 8 个 instance。
   - 单次 bars 上限沿用现有行情限制或设置更严格上限。
   - 参数总数和字符串长度有界。
   - 从存储读取 `vt_symbol + interval + adjust + start/end`。
   - 根据全部 study 的最大 lookback 读取 warmup。
   - 输出裁剪回用户请求区间。
4. 参数初始范围：
   - SMA、EMA period：1 到 500。
   - BOLL period：2 到 200，标准差倍数 0.5 到 5。
   - RSI period：2 到 100。
   - MACD fast：1 到 100，slow：2 到 200，signal：1 到 100，并要求 fast < slow。
5. definition 只返回稳定 type、参数 key 和 output ID，前端通过中英文资源生成最终文案，后端不返回用户可见英文名称。
6. TA-Lib 或计算依赖异常返回结构化业务错误，不能返回部分长度错位的数组。
7. HTTP wire format 的 study point time 与 `/bars` 一样使用字符串：日线/周线为交易日，盘中为带偏移 ISO 时间。`MarketTime` 联合类型只存在于前端归一化之后，不能直接作为 Python JSON 形状。

### 前端设计

1. 在 `chart/studies/model.ts` 定义 Zod schema 和引擎无关类型。
2. 在 `api.ts` 增加 `getAlphaStudyDefinitions()` 和 `calculateAlphaStudies()`。
3. study points 通过现有 `normalizeMarketTime()` 按请求 interval 转换，不创建第二套时间解析。
4. React Query key 包含：
   - 数据键。
   - actual start/end。
   - 规范化、稳定排序后的 instance 类型和参数。
5. 不把颜色、line width、pane 高度放入计算 query key。
6. Scene 只在至少一个 visible study 存在且页面 visible 时启用计算。
7. 历史 prepend 后 actual start 改变，重新请求完整覆盖的指标；结果返回前保留旧指标或显示局部 loading，不清空主 K 线。

### 预计修改文件

- 新增 `alpha/chart/__init__.py` 和 `alpha/chart/studies.py`
- 新增 `alpha/api/routes/studies.py`
- 修改 `alpha/api/models.py`、`alpha/api/router.py` 和相关容器边界
- 新增 `alpha/tests/unit_tests/test_chart_studies.py`
- 扩展 `alpha/tests/test_router.py` 或新增 studies route 测试
- 新增 `src/modules/alpha/chart/studies/model.ts` 及测试
- 修改 `src/modules/alpha/api.ts`、`query.tsx` 和 API 测试
- 修改 `MarketChartScene.tsx` 和 Scene 测试，只接入结果查询与局部状态

### 测试

- 每个 definition 的默认参数、边界参数和非法参数。
- MACD fast/slow 交叉约束。
- warmup 足够且响应只含请求区间。
- NaN、Infinity 和空结果归一化。
- 多指标批量请求保持 instanceId 和输出 ID。
- 时间升序、长度与 null 填充。
- 前端 schema 拒绝未知 series kind、重复 instanceId 和非法时间。
- 未启用指标时不发请求。

### 验证

- Python：相关 pytest、route 测试和类型/格式检查。
- 前端：API schema、query key 和 Scene 启用条件测试。
- 此任务不要求运行 Tauri UI，因为没有新增 pane 交互。

### 完成标准

- Alpha 可以批量返回首批五类指标的稳定结果。
- 公式只存在于 Alpha 服务端。
- 前端持有 engine-neutral result，尚不依赖 Lightweight Charts series 类型。
- 没有 active study 时不产生计算和额外请求。

## 任务 5：指标 pane、legend 与管理界面

### 目标

把任务 4 的结果渲染为主图叠加或独立 pane，并提供最小完整的添加、参数修改、显示、隐藏、删除和排序交互。

### 必须阅读的参考

- shioaji-pro-app `src/lib/chart-indicators.ts`
- shioaji-pro-app `src/components/candle-chart.tsx` 的 `paneStretchRef`、`paneAssignRef`、`renderLegendRow()` 和 rAF legend
- OpenTerminalUI `frontend/src/shared/chart/useIndicators.ts`
- OpenTerminalUI `frontend/src/shared/chart/indicatorCatalog.ts` 的 routing 纯函数
- OpenTerminalUI `frontend/src/__tests__/useIndicators.panes.test.tsx`

### Controller 设计

1. 新增动态 study registry：

```ts
type StudyRuntime = {
  instanceId: string;
  paneIndex: number;
  series: Map<string, ISeriesApi<"Line" | "Histogram">>;
  levelLines: IPriceLine[];
};
```

2. `setStudies(results, instances)` 对 instanceId 和 output ID 做 diff：
   - 未变化 series 复用实例并更新 data/options。
   - 新 output 创建 series。
   - 删除 output 先 removeSeries。
   - 删除最后一个独立 study 后 removePane。
3. pane 规则：
   - pane 0：价格与 overlay。
   - 辅助 pane 按当前配置动态排列，visible volume 在最前，其后每个 visible separate study 一个 pane。
   - volume 隐藏时 study pane 自动前移，不能留下空 pane。
   - 最多 4 个 separate study pane。
4. RSI 30/70、MACD 0 等 levels 使用低强调 price line，关闭 axis label。
5. histogram point 按数值正负使用 `positiveColor`/`negativeColor`，缺失时回退到当前主题的正负语义色；不能把 MACD 全部柱子画成单色。
6. 指标更新、显隐和排序不能重建 chart 或主价格 series。
7. 重建 study pane 前读取全部 stretch factor，按 instanceId 恢复。主图和成交量比例也保留。
8. 指标 crosshair 值通过同一个 `subscribeCrosshairMove` 的 `seriesData` 读取，合并进单个 rAF snapshot，不为每条 series 单独订阅。

### UI 设计

1. 指标入口只在 panel density 显示，compact 数据页默认关闭；独立行情页恢复后再接入 full density。
2. IndicatorDialog 懒加载，第一次打开前不进入 eager bundle。
3. 选择器只展示五类服务端 definitions，支持名称搜索和 main/separate 分类。
4. legend 显示 instance 名、参数和当前值，提供：
   - 显示/隐藏。
   - 参数设置。
   - 删除。
   - 上移/下移。
5. 参数编辑使用 definition 的 min/max/step，提交前在前端快速校验，服务端仍做权威校验。
6. 样式首版只允许颜色和线宽，不实现 plot style、模板、收藏和显示周期规则。
7. 工作台 panel 将 instances 保存到 config；数据页不保存指标。独立行情页恢复实施后再增加页面本地配置。

### 预计修改文件

- 新增 `src/modules/alpha/chart/lightweight/studies.ts` 及纯函数测试
- 新增 `src/modules/alpha/chart/studies/IndicatorDialog.tsx` 及组件测试
- 修改 `FinancialChartController.ts`，增加 study runtime registry
- 修改 `FinancialChart.tsx` 和 `FinancialChartFrame.tsx`
- 修改 `MarketChartScene.tsx`，传递 definition、instance、result 和局部错误
- 修改 Chart Panel config schema 和持久化测试
- 修改 Vite eager graph 或 bundle 测试，仅在现有检查要求时增加断言
- 更新中英文指标名称、参数、状态和操作文案

### 测试

- overlay 固定进入 pane 0。
- RSI 和 MACD 各自进入独立 pane。
- 隐藏 study 保留 instance 配置但移除或隐藏 series，不继续请求计算。
- 删除、排序和参数修改不影响主 K 线 viewport。
- 最大 pane 数在 UI 和 Controller 双重保护。
- 10,000 根 bars、4 个指标的转换和 series payload 构建有明确性能预算。
- 十字线同一帧只提交一次完整 legend snapshot。
- 配置序列化和恢复保持 instanceId、参数、样式和顺序。

### 运行时验证

必须在真实 Tauri WebView 检查：

- 连续添加和删除 overlay、RSI、MACD。
- 拖动多个 pane 后修改参数和主题，比例保持。
- 最小 panel 高度下达到 pane 上限时仍可操作。
- 隐藏页面再恢复时只同步最终尺寸，不重建 chart。

### 完成标准

- 五类指标形成完整的选择、计算、渲染、编辑和持久化闭环。
- 指标失败局部展示，不让主 K 线进入 error。
- 未启用指标时不加载选择器、不请求计算、不创建 study pane。

## 任务 6：多图时间范围与十字线同步

### 目标

在 Alpha 工作台中提供相互独立的时间范围同步和十字线同步开关。同步只传播轻量运行时事件，不共享图表实例，不与标的 follow/pinned 混合。

### 必须阅读的参考

- OpenTerminalUI `frontend/src/contexts/CrosshairSyncContext.tsx`
- OpenTerminalUI `frontend/src/shared/chart/ChartSyncContext.tsx`
- OpenTerminalUI `frontend/src/__tests__/CrosshairSyncContext.test.tsx`
- OpenTerminalUI `frontend/src/__tests__/ChartSyncContext.test.tsx`
- Lightweight Charts `subscribeVisibleTimeRangeChange()`、`setVisibleRange()`、`setCrosshairPosition()` 和 `clearCrosshairPosition()`
- Terax `AlphaPanelPool`、`AlphaWorkstationPage` 和工作台状态 schema

### 设计

1. 在工作台页面层新增 `ChartSyncProvider`，只包围当前工作台的 chart panels。
2. Provider 持有两个独立 rAF batcher：range 和 crosshair。
3. 工作台状态增加版本化同步配置：

```ts
type AlphaChartSyncConfig = {
  groupId: string;
  rangeEnabled: boolean;
  crosshairEnabled: boolean;
};
```

4. 若工作台状态 schema 发生字段变化，提升 state schema version 并提供从旧版本的纯迁移，不能依赖 Zod 默认值掩盖版本变化。
5. Controller 新增命令和回调：
   - `onVisibleTimeRangeChange(range)`。
   - `setVisibleTimeRangeFromSync(range)`。
   - `onCrosshairTimeChange(time)`。
   - `setCrosshairFromSync(time, localBar)`。
6. 内部 mutation guard 区分用户事件和同步应用，避免收到事件后再次 publish。
7. 兼容规则首版固定为相同 interval 和 adjust。不同标的可以同步，相同标的不是必要条件。
8. 接收方没有完全相同 crosshair 时间时清除同步 crosshair，不使用不透明的最近点跳转。
9. 用户本地图表 crosshair 优先于远端同步。pointer 离开后再显示同步位置。
10. 同步开关放在工作台级工具栏，不塞入每个小 panel 的 chart toolbar。

### 预计修改文件

- 新增 `src/modules/alpha/chart/sync/ChartSyncContext.tsx` 及测试
- 修改 `FinancialChartController.ts`，增加同步命令、回调和 mutation guard
- 修改 `FinancialChart.tsx` 与 `MarketChartScene.tsx`，桥接可选同步运行时
- 修改 `AlphaWorkstationPage.tsx`，提供同步开关和 Provider
- 修改工作台 `model.ts`、`state.ts`、`store.ts` 与迁移测试
- 修改 `AlphaChartPanel.tsx`，传递稳定 panelId 和兼容信息
- 更新工作台中英文文案

### 测试

- 同一帧多次发布只保留最后事件。
- 来源 panel 不消费自己的事件。
- range 和 crosshair 开关互不影响。
- 不兼容周期或复权不消费事件。
- 同步命令不形成循环。
- panel 删除后没有残留监听器。
- 工作台状态迁移和持久化只保存配置，不保存事件。

### 运行时验证

- 双图模板中分别打开和关闭两种同步。
- 拖动一个图的时间范围，另一个图稳定跟随且不抖动。
- 快速移动十字线时 React 不出现逐事件重渲染。
- 修改一个 panel 的周期后自动退出兼容同步，不改变另一个 panel。

### 完成标准

- 多图同步可独立控制、无循环、无持久化运行时垃圾。
- 同步开启前不建立额外事件处理和 rAF 状态。
- 标的 follow/pinned 行为与图表同步完全独立。

## 任务 7：对比标的叠加

### 目标

允许 Chart Panel 为主标的添加最多 3 个对比标的，以相对收益线在独立百分比轴上展示，并在 legend 中显示当前对比值。独立行情页恢复后复用同一入口。

### 必须阅读的参考

- OpenTerminalUI `frontend/src/shared/chart/comparison.ts`
- OpenTerminalUI `TradingChart.tsx` 中 `comparisonSeries`、`effectiveComparisonMode` 和 comparison inspector
- Terax `MarketChartScene` 的分页 actual start/end
- Terax `mergeMarketBarPages()` 和 `marketTimeKey()`

### 数据设计

1. 主标的历史页继续决定当前实际覆盖范围。
2. 对比标的使用 `/bars` 的 `start + end` 范围查询，不为每个对比标的建立独立左侧无限分页。请求 limit 取主图已加载数量并限制在后端 `MAX_BAR_LIMIT=5000` 内。
3. 主标的 prepend 改变 actual start 后，扩展对比查询范围。相同范围和数据键复用 React Query cache。主图超过 5,000 根时，对比线只覆盖最新 5,000 根，并根据响应 `actual_start` 显示明确的局部覆盖状态，不能假装已经覆盖完整主图。
4. 每个对比查询独立 error；单个失败不让主图或其他对比线失败。
5. 归一化纯函数同时处理主标的和全部对比标的：
   - 过滤非有限 close。
   - 按时间升序并去重。
   - 取所有序列首个有效时间的最大值作为共同有效起点。
   - 每个序列选择共同起点当日或之后的第一条有效 close 为自己的基准。
   - 输出 `(close / base - 1) * 100`。
   - base 为 0 时返回结构化不可比较错误。
6. 不跨不存在的交易日人工补点。十字线 legend 首版只显示精确同时间值，避免把长期停牌标的旧值伪装成当前值。

### Controller 和 UI 设计

1. Controller 持有主标的相对收益线和 `Map<vtSymbol, LineSeries>` 对比线，按配置 diff 增删；没有对比配置时不创建主标的相对收益线。
2. 对比 series 使用独立 `comparison-scale` 左轴，单位为 `%`，不改变主 K 线右侧绝对价格轴。
3. 主标的相对收益线使用主题主强调色，对比颜色来自有界调色板或配置，不能与涨跌色产生语义冲突。
4. 对比选择器复用证券搜索，排除主标的和已选标的。
5. panel density 使用紧凑菜单；compact 数据页不显示。独立行情页恢复后再提供 full density 的完整管理入口。
6. Chart Panel config 保存 `comparisons`，旧配置默认空数组。
7. 对比 legend 与指标 legend 使用同一个 crosshair snapshot，不能增加第二个 crosshair 订阅。

### 预计修改文件

- 新增 `src/modules/alpha/chart/comparison/normalize.ts` 及测试
- 新增或复用有界证券选择器组件及测试
- 修改 `MarketChartScene.tsx`，增加对比范围查询和局部错误
- 修改 `FinancialChartController.ts`，增加主标的和对比 line registry
- 修改 `FinancialChart.tsx` 与 `FinancialChartFrame.tsx`
- 修改 Chart Panel config schema、迁移和持久化测试
- 更新中英文选择器、legend 和错误文案

### 测试

- 未排序、重复时间、零基准、缺失日期和不同数据长度。
- 最多 3 个标的，重复和主标的被拒绝。
- 单个查询失败局部显示并可删除。
- 新增、删除和改色不重建 chart 或重置 viewport。
- prepend 后查询范围扩展且已有区间复用缓存。
- 主图超过 5,000 根时对比查询保持有界并显示局部覆盖。
- panel config 解析和旧配置迁移。

### 运行时验证

- 不同价格量级的 3 个标的在左侧百分比轴正确比较。
- 主题切换后颜色和 legend 清晰。
- 小面板中对比入口不会遮挡图表类型和重置按钮。
- 历史继续向左加载时主图位置稳定，对比线覆盖范围逐步扩展。

### 完成标准

- 用户可添加、删除和识别最多 3 个相对收益对比标的。
- 对比线不扭曲主价格轴，不建立重复图表实例。
- 对比失败、无数据和零基准都有局部、可恢复状态。

## 批次三：实时行情尾部

## 任务 8：实时行情尾部与“回到最新”

### 目标

在真实 Alpha 实时协议上建立进程内共享 `MarketDataHub`，把权威快照、WebSocket 增量、连接状态和图表尾部更新连接成可恢复闭环，并允许用户离开实时尾部后自主返回最新位置。

### 前置条件

开始本任务前必须满足：

- Alpha 已定义实时行情 WebSocket 消息协议。
- Rust 通用 WebSocket 代理可以稳定转发并报告断线。
- 服务端明确 sequence、bar final、成交量累计/增量和重连快照语义。
- WebSocket 订阅接受完整 `vtSymbol + interval + adjust`，Alpha 按请求复权语义发布 bar；前端不持有或应用复权因子。
- 阶段二的数据质量与失败恢复边界已经稳定。

如果这些条件未满足，本任务保持 pending，不在前端伪造实时流。

### 必须阅读的参考

- shioaji-pro-app `candle-chart.tsx` 的 `loadedKeyRef`、实时 bucket、历史页与 live tail 拼接。
- OpenTerminalUI `frontend/src/shared/chart/useRealtimeChart.ts`
- OpenTerminalUI `frontend/src/shared/chart/chartUtils.ts` 的时间桶与 update guard。
- OpenTerminalUI `frontend/src/__tests__/useRealtimeChartAggregation.test.ts`
- OpenTerminalUI `frontend/src/__tests__/TradingChart.realtime.test.tsx`
- Terax `docs/architecture/alpha-quant-workstation.md` 的 `MarketDataHub` 边界。

### MarketDataHub 设计

1. `MarketDataHub` 是当前 WebView 进程内共享运行时，不持久化。
2. 以完整 `MarketDataKey` 管理：
   - 权威 snapshot。
   - 当前 sequence。
   - 订阅引用计数。
   - 连接和 freshness 状态。
   - 当前 partial bar。
3. 多个页面或 panel 订阅同一 key 时复用底层 WebSocket channel。
4. 最后一个消费者离开后才解除订阅。页面隐藏可以暂停视觉 rAF，但不能错误减少仍在使用的共享引用。
5. 首次进入、检测 sequence gap 或重连后：
   - 暂停应用新 delta。
   - 请求权威历史/当前快照。
   - 丢弃早于快照 sequence 的缓存 delta。
   - 按序应用剩余 delta。
6. freshness 状态阈值由协议或集中常量定义，不散落在组件。
7. 复权因子或复权锚点变化时，Alpha 发出需要重校准的事件；Hub 丢弃当前增量基线并重新请求与该 adjust 一致的权威快照。

### 聚合和更新设计

1. 把 tick/bar 合并写成纯函数并测试：
   - 同 bucket 替换当前 bar。
   - 新 bucket append，并标记上一根 final。
   - 更早 bucket 按迟到策略处理。
   - OHLC、volume、amount 和 openInterest 校验。
2. 不在每个 tick 创建完整 React bars 数组。
3. Hub 将当前 bar 通过 rAF 合并后直接交给 Controller `updateLiveBar()`。
4. bar final 时才把新 bar 纳入 Scene 的稳定 bars 快照，并触发需要全历史的指标重算。
5. 标的、周期或复权切换时更新 active dataKey；旧 key 的 delta 即使晚到也不能写入当前 Controller。
6. 历史 prepend 期间形成的新 live tail 在合并后重新拼接，不能被旧历史快照覆盖。

### viewport 和 UI 设计

1. Controller 维护 `followingLatest`：
   - 初始进入实时尾部为 true。
   - 用户主动平移离开右边界后为 false。
   - 数据和 resize 引起的内部范围变化不改变该状态。
2. `followingLatest=true` 时新 bar 到达可以保持右侧尾部，但不能每 tick `fitContent()`。
3. `followingLatest=false` 时不自动滚动，并显示“回到最新”。
4. 用户点击后调用 `scrollToRealTime()` 或等价受控命令，并恢复 following。
5. `live`、`delayed`、`stale`、`reconnecting`、`disconnected` 在 Frame 中显示明确且国际化的状态。
6. 历史查询错误、实时连接错误和指标错误分别展示，不能合并为一个 error。

### 预计修改文件

- 新增或修改 Alpha 实时行情领域服务和 WebSocket route
- 修改 `alpha/api/events.py` 或专用实时事件模块，并增加协议测试
- 修改 Rust 通用 Alpha WebSocket 转发的相关测试，仅在协议路由确有变化时修改 Rust
- 新增 `src/modules/alpha/realtime/MarketDataHub.ts` 及引用计数测试
- 新增 `src/modules/alpha/realtime/aggregation.ts` 及纯函数测试
- 修改 `MarketChartScene.tsx`，连接 snapshot、delta 和状态
- 修改 `FinancialChartController.ts`，增加 live update、follow 状态和回到最新命令
- 修改 `FinancialChartFrame.tsx`，展示实时状态和回到最新入口
- 更新中英文实时状态、重连和错误文案

### 测试

- 订阅引用计数和最后消费者释放。
- 相同 key 请求单飞，不同 key 隔离。
- sequence gap、乱序、重复 delta 和重连 snapshot。
- volume 累计与增量两种协议。
- none、forward、backward 三种订阅不会混用增量，复权变化触发快照重校准。
- 标的切换期间旧 delta 被拒绝。
- 同 bucket `update()`、新 bucket append、迟到 bucket 策略。
- 用户离开尾部后不自动滚回。
- “回到最新”恢复跟随。
- 隐藏页面不 resize 或更新 React legend，恢复后同步最终状态。
- 新 bar 才触发指标全量重算。

### 运行时验证

必须使用真实 Tauri WebView 和 Alpha WebSocket：

- 正常实时流至少持续观察一个完整 bar 切换。
- 拖离尾部、继续接收 tick、点击回到最新。
- 断网、重连、服务重启和 snapshot 重校准。
- 同一标的双 panel 只建立一个底层订阅。
- 快速切换标的和周期无旧数据闪现或 update 异常。

### 完成标准

- 权威快照与实时增量形成可恢复、无重复的尾部。
- 多消费者共享订阅，状态和错误边界清晰。
- 实时 tick 不造成 bars 全量复制、逐 tick React render 或 viewport 抢夺。
- 用户可以稳定离开尾部观察历史并主动回到最新。

## 任务依赖和执行顺序

```text
任务 1
  -> 任务 2
  -> 任务 3

任务 2
  -> 任务 4
      -> 任务 5

任务 1 + 任务 2
  -> 任务 6
  -> 任务 7

阶段二实时前置条件 + 任务 1 至 7 稳定
  -> 任务 8
```

执行原则：

1. 任务 1、2、3 连续完成，形成历史行情图闭环。
2. 完成第一批后重新确认是否先转入阶段二数据闭环。若继续图表能力，任务 4 和 5 必须连续完成，不能只留下无 UI 的长期指标协议。
3. 任务 6 与任务 7 都依赖受控配置和元数据，可在任务 5 后依次执行。
4. 任务 8 不因前端准备就提前开始，必须满足真实协议前置条件。
5. 每个任务使用独立 `alpha` scope 提交，不把下一任务的基础设施提前混入当前提交。

建议提交标题：

```text
feat(alpha): add reusable market chart page
feat(alpha): apply market metadata to financial charts
feat(alpha): add chart export and accessibility
feat(alpha): add chart study protocol
feat(alpha): render configurable chart studies
feat(alpha): synchronize workstation charts
feat(alpha): add normalized chart comparisons
feat(alpha): stream realtime chart bars
```

## 每个任务的统一执行流程

1. 读取 `AGENTS.md`、本计划、长期架构和任务列出的参考文件。
2. 检查工作区状态和外部参考仓库 commit，记录任何偏差。
3. 在临时实施进度文档中把唯一当前任务标为进行中，不能同时开启两个任务。
4. 先写或更新纯模型、schema 和纯函数测试。
5. 实现薄 API/React/Controller 外壳。
6. 只在需要时增加持久化 schema 或运行时上下文。
7. 运行最小且充分的格式、lint、类型和相关测试。
8. 触发运行时调试条件时，先定义复现证据，再修改和复验。
9. 审核边界、性能、可访问性、国际化和错误状态。
10. 更新长期架构“当前 Terax 基线”、临时进度和本计划 checklist。
11. 使用独立 `alpha` scope Conventional Commit 提交。

## 验证矩阵

| 任务 | 前端单元/组件 | Python/API | 真实 Tauri | 性能测试 |
| --- | --- | --- | --- | --- |
| 1 | 必须 | 仅现有 bars 回归 | 视页面/面板真实尺寸决定 | 查询单飞 |
| 2 | 必须 | 证券详情必须 | 必须 | pane 拖动无逐帧状态 |
| 3 | 必须 | 无 | 下载行为按需 | 有界 DOM/CSV |
| 4 | 必须 | 必须 | 不要求 | 批量计算上限 |
| 5 | 必须 | 指标 API 回归 | 必须 | 10k bars + 4 studies |
| 6 | 必须 | 无 | 必须 | rAF 合并 |
| 7 | 必须 | bars 范围查询回归 | 必须 | 3 对比上限 |
| 8 | 必须 | 必须 | 必须 | tick、订阅和内存 |

前端修改至少运行：

```text
pnpm lint
pnpm check-types
pnpm test
```

Python 修改运行 Alpha 已有格式、静态检查和相关 pytest。若任务跨 FastAPI、前端和 WebSocket 边界，三个层次都必须验证。纯文档进度更新只需 Markdown、链接、UTF-8、禁止字符和 `git diff --check`。

## 全局测试不变量

### 行情与查询

- 查询键完整包含所有影响数据含义的字段。
- 迟到响应不能污染新标的、新周期或新复权。
- bars 始终升序、去重、OHLC 合法。
- 范围查询、历史分页、指标和对比共享一致时间语义。

### Controller

- Strict Mode 重挂载后没有重复监听器。
- 主题、类型、元数据、指标和对比切换不重建 chart。
- series 删除后没有悬空引用。
- range、crosshair、resize 和实时命令有明确 mutation guard。
- destroy 取消所有 rAF、observer、事件和动态 series。

### 持久化

- 旧版本或缺失字段有显式迁移或默认归一化。
- 无效单 panel config 不破坏其他 panel。
- 运行时对象和事件不进入 JSON。
- 多进程共享状态继续通过白名单 shared store 合并写入。

### UI

- loading、empty、error 和 partial error 可区分。
- 紧凑面板不会被完整工具栏挤压。
- 所有可见文本、tooltip、aria 和错误国际化。
- 键盘可以操作选择器、菜单、导出和可访问性表格。
- reduced motion 和现有动画约束不被破坏。

## 进度清单

### 批次一

- [x] 任务 1：受控公共图表配置。
- [x] 任务 2：专业价格、时间与 pane 语义。
- [ ] 任务 3：图表导出与可访问性。

### 批次二

- [ ] 任务 4：指标领域协议与首批服务端计算。
- [ ] 任务 5：指标 pane、legend 与管理界面。
- [ ] 任务 6：多图时间范围与十字线同步。
- [ ] 任务 7：对比标的叠加。

### 批次三

- [ ] 任务 8：实时行情尾部与“回到最新”。

## 全部计划完成标准

- 数据页和工作台 Chart Panel 复用同一公共图表与 Scene，独立行情页已经明确暂缓并可在后续作为薄页面接入。
- 图表具备受控周期、复权、类型、成交量、精度、时区、昨收和最新价语义。
- PNG、CSV 和可访问性形成完整用户入口。
- 首批五类指标由 Alpha 服务端计算，并支持 overlay、独立 pane、legend 和版本化配置。
- 多图范围、十字线和标的绑定彼此独立。
- 最多 3 个对比标的以清晰的相对收益语义展示。
- 实时快照、增量、连接状态和“回到最新”形成可恢复闭环。
- 未启用的指标、同步、对比和实时能力不产生请求、订阅、计算或 eager bundle 成本。
- 所有任务均有针对核心不变量的测试、必要的真实 Tauri 验证和独立 `alpha` scope 提交。

完成八个任务后，应把长期结论合并进 `docs/architecture/alpha-quant-workstation.md`，删除本计划中的临时执行细节，并按 `AGENTS.md` 规则清理临时实施进度入口。
