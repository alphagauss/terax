# Alpha 综合量化工作站设计与参考项目指南

本文记录 Alpha 综合量化工作站的产品边界、前后端职责、公共组件复用方式、外部参考项目审查结论、建议阅读路径和分阶段实施顺序。后续开发应先阅读本文，再按当前任务定向阅读少量参考源码，避免重复通读外部仓库或把不同项目的实现直接拼接到 Terax。

本文是长期设计参考，不表示相关功能已经实现。Alpha 与 Terax 的进程和业务边界仍以 [Alpha 集成架构](./alpha-integration.md) 和根目录 `AGENTS.md` 为准。

## 产品目标

Alpha 的目标不是单独增加一张专业 K 线图，而是在 Terax 中形成个人自用的综合量化工作站，逐步覆盖：

- 行情数据管理、质量检查和历史浏览。
- 专业行情图、多图对照、技术指标和绘图。
- 标的研究、筛选、组合分析和风险分析。
- 策略开发、参数配置、回测、优化和复盘。
- 模拟交易、实盘行情、订单、持仓、账户和风险监控。
- 可组合面板、场景化布局模板、标的联动和多屏工作流。
- AI Agent 对数据、策略、回测和实盘状态的统一访问。

工作站不是一个包含全部功能的单体页面。Terax 顶层 Workbench 继续负责 Terminal、Editor 和 Alpha 页面之间的标签与分割；Alpha 交易工作台页面内部可以拥有面向量化场景的高密度面板网格。

```text
Terax Space / Workbench
  Terminal
  Editor
  Alpha 数据管理
  Alpha 策略与回测
  Alpha 综合工作台
    工作台工具栏
    布局模板与面板库
    Alpha Panel Grid
      证券列表
      K 线图
      行情快照
      五档与逐笔
      指标与信号
      回测统计与交易列表
      持仓、委托、账户和风险
```

## 已确定的方向

- 金融行情图使用 `lightweight-charts`，统计、分布、组合分析和参数曲面等普通图表继续使用 ECharts。
- Lightweight Charts 是 Alpha 唯一的正式金融图表运行时引擎。不维护双引擎适配层，也不为假设中的替代引擎提前设计 renderer interface。
- Terax 自己拥有行情数据协议、React 组件 API、工作台协议、工具栏、主题、状态、持久化和场景适配层。
- 同一个公共 K 线组件用于数据管理、独立行情、多图、回测复盘和实盘页面，不为每个页面复制图表实现。
- 公共图表组件不直接请求 Alpha API，不认识回测 ID、实盘连接、工作台面板或 Workbench 标签。
- 页面和工作台面板通过薄场景适配层连接查询、回测标记、实时订阅和交易状态。
- Terax 顶层 SplitView 继续只使用 `react-resizable-panels`。Alpha 页面内部的自由面板网格是不同层级的布局能力，不替换顶层 SplitView。
- 工作台、图表、绘图和指标状态都使用可版本化 JSON 表达，不持久化 React、Canvas、Controller、Query 或连接实例。
- Alpha FastAPI 是量化领域和权威数据边界。Rust 只负责生命周期、凭据注入和通用代理，不复制行情、策略、订单或风险领域模型。
- 第一阶段先完成可复用图表和工作台内核，再逐步接入行情、回测和实盘，不一次引入所有面板、指标和绘图工具。

## 当前 Terax 基线

- `package.json` 当前使用 `lightweight-charts ^5.2.0`、`echarts ^6.1.0` 和 `react-resizable-panels ^4.12.1`。
- 临时 K 线位于 [`AlphaFinancialChart.tsx`](../../src/modules/alpha/components/AlphaFinancialChart.tsx)，目前只在 [`AlphaDataPage.tsx`](../../src/modules/alpha/pages/AlphaDataPage.tsx) 的固定高度区域内使用。
- 现有图表实例只在挂载时创建，日线使用 `BusinessDay`，成交量使用独立 pane，主题切换通过 `applyOptions()` 完成，页面隐藏时保留 Canvas。
- 当前数据更新只有整体 `setData()`。[`getAlphaBars()`](../../src/modules/alpha/api.ts) 固定请求日线、前复权和最近 500 根，没有周期切换、历史分页或实时增量。
- 当前 Alpha 页面包括数据、回测和设置，尚没有独立行情页、综合工作台、策略页、回测复盘页和实盘页。
- Terax Workbench 已有递归分割树、稳定 tab ID 和 `WorkbenchViewPool`。移动、分割和隐藏页面不应重挂载其运行时实例。
- 迁移时保留 `alphaBusinessDay()` 的时区不变量和测试，将其下沉到行情归一化模块。不要继续把新能力堆入现有临时组件。

## 外部源码位置、版本和许可证

假定开发者把参考项目放在 `D:\OneDrive\open`。这些目录只用于人工阅读，不得成为构建输入、运行时查找路径或 Terax 源码导入路径。

| 项目 | 本地目录 | 审查提交 | 许可证 | 主要定位 |
| --- | --- | --- | --- | --- |
| [shioaji-pro-app](https://github.com/Sinotrade/shioaji-pro-app) | `D:\OneDrive\open\shioaji-pro-app` | `a6c9bd2` | AGPL-3.0-only | 交易终端产品形态、自由面板布局和 LWC 5.2 实现 |
| [OpenTerminalUI](https://github.com/Hitheshkaranth/OpenTerminalUI) | `D:\OneDrive\open\OpenTerminalUI` | `fc16fd6` | MIT | 综合工作站页面、Launchpad、联动组、图表能力和测试场景 |
| [openalgo](https://github.com/marketcalls/openalgo) | `D:\OneDrive\open\openalgo` | `f1329e23d` | AGPL-3.0-only | 经纪商接口、实盘交易、策略 Flow、图上交易和风险边界 |
| [lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing) | `D:\OneDrive\open\lightweight-charts-drawing` | `5f2afc3` | `package.json` 声明 MIT | Lightweight Charts 绘图插件候选 |
| [lightweight-charts-indicators](https://github.com/deepentropy/lightweight-charts-indicators) | `D:\OneDrive\open\lightweight-charts-indicators` | `31756c8` | MIT | 指标计算、metadata、结果协议和回归测试参考 |

开始开发前运行 `git rev-parse --short HEAD` 检查本地版本。提交不同不要求重新通读整个项目，只在本文列出的关键文件发生实质变化或命中“需要重新审查外部源码的条件”时定向复核。

Terax 使用 Apache-2.0。`shioaji-pro-app` 和 `openalgo` 是 AGPL-3.0-only，在没有额外授权或兼容的重新许可前，只能吸收产品思想、公开行为和架构经验并独立实现，不能把其源码直接复制或轻微修改后合入 Terax。MIT 和 Apache-2.0 项目如需复用代码，仍要保留许可证、版权和 NOTICE 要求，并在采用前确认目标文件没有额外来源限制。

## 五个项目的参考价值总览

| 能力 | 首选参考 | 补充参考 | Terax 的采用方式 |
| --- | --- | --- | --- |
| 综合面板工作台 | OpenTerminalUI Launchpad | shioaji-pro-app Workspace | 自有版本化面板协议、懒加载 registry、网格布局和稳定 PanelPool |
| 交易终端密度与交互 | shioaji-pro-app | openalgo Trading | 吸收 Panel Chrome、布局模板、联动/锁定和多图工作流 |
| 专业 K 线生命周期 | shioaji-pro-app | OpenTerminalUI、openalgo | Lightweight Charts Controller 与 React 外壳分离 |
| 多图与联动组 | OpenTerminalUI | shioaji-pro-app、openalgo | 颜色联动频道，只传播标的、时间和十字线等必要事件 |
| 回测复盘页面 | OpenTerminalUI | openalgo | 复用公共图表、交易标记、回放和统计面板 |
| 实盘与图上交易 | openalgo | shioaji-pro-app | Alpha 权威订单和风险状态，图表只发命令意图 |
| 策略可视化编排 | openalgo Flow | OpenTerminalUI Model Lab | 后期独立页面，不塞入行情工作台内核 |
| 图表运行时和生命周期 | shioaji-pro-app | OpenTerminalUI | 只围绕 Lightweight Charts 建设 Controller、测试和扩展能力 |
| 绘图 | lightweight-charts-drawing | OpenTerminalUI、openalgo | 隔离验证后按小工具集接入 |
| 指标协议 | lightweight-charts-indicators | OpenTerminalUI | 自有 engine-neutral descriptor，Alpha Python 提供权威计算 |
| 测试和边界行为 | OpenTerminalUI | shioaji-pro-app | 提取纯函数、性能测试和场景测试，不复制单体组件 |

正常开发的参考优先级为：

1. `shioaji-pro-app`：Lightweight Charts 生命周期、实时更新和交易终端布局。
2. `OpenTerminalUI`：综合工作台、多图同步、回测复盘和测试。
3. `lightweight-charts-drawing`：Lightweight Charts 绘图候选。
4. `lightweight-charts-indicators`：指标 metadata 和结果协议。
5. `openalgo`：经纪商边界、实盘、图上交易、策略 Flow 和风险，不参考其图表引擎调用。

## 工作站总体架构

### 两级布局

Terax 保留两级、不同职责的布局系统：

1. 顶层 Workbench

   - 负责 Terminal、Editor、Alpha 页面和其他资源标签。
   - 使用现有递归 `react-resizable-panels` SplitView。
   - 使用稳定 `WorkbenchViewPool` 保持页面运行时实例。

2. Alpha 综合工作台页面

   - 负责行情、研究、回测和实盘小面板的高密度组合。
   - 可以定向评估 `react-grid-layout`，其定位是网格，不是新的顶层 SplitView。
   - 网格依赖必须随 Alpha 工作台懒加载，未打开时不得增加 eager bundle、Observer、连接或定时器。
   - 面板拖动和缩放期间由布局库通过 `transform` 更新视觉位置，只在 `onDragStop` 和 `onResizeStop` 提交最终布局。

递归 SplitView 适合 IDE 资源布局，自由网格适合交易终端面板。不要让用户通过顶层 Workbench 的每个 Tab 手工模拟整套交易终端，也不要在普通 Alpha 数据页中嵌套完整网格。

### 建议页面地图

```text
src/modules/alpha/pages/
  AlphaDataPage.tsx
  AlphaMarketPage.tsx
  AlphaWorkstationPage.tsx
  AlphaStrategiesPage.tsx
  AlphaBacktestsPage.tsx
  AlphaBacktestReviewPage.tsx
  AlphaPaperTradingPage.tsx
  AlphaLiveTradingPage.tsx
  AlphaRiskPage.tsx
  AlphaSettingsPage.tsx
```

- `AlphaDataPage`：数据目录、同步、质量、覆盖范围和紧凑行情预览。
- `AlphaMarketPage`：单标的全尺寸专业行情浏览。
- `AlphaWorkstationPage`：自由组合的行情、研究、回测或实盘面板工作台。
- `AlphaStrategiesPage`：策略文件、版本、参数、依赖和运行入口。
- `AlphaBacktestsPage`：任务列表、比较、优化和结果导航。
- `AlphaBacktestReviewPage`：公共 K 线、交易标记、回放、成交列表和统计面板。
- `AlphaPaperTradingPage`：模拟账户、订单、持仓和事件。
- `AlphaLiveTradingPage`：实盘连接、交易、风险和恢复状态，必须显式区别模拟环境。
- `AlphaRiskPage`：组合风险、压力测试、限额、异常和审计。

第一阶段不需要同时创建全部页面。页面地图用于约束公共组件边界，避免当前页面中的临时实现成为以后无法复用的单体。

### 建议模块边界

```text
src/modules/alpha/
  api/
  market/
    model.ts
    normalize.ts
    MarketDataHub.ts
    realtime.ts
  chart/
    model.ts
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
      MarketChartScene.tsx
      BacktestChartScene.tsx
      LiveChartScene.tsx
  workstation/
    model.ts
    registry.ts
    layout.ts
    persistence.ts
    selectionChannels.ts
    components/
      AlphaPanelGrid.tsx
      AlphaPanelPool.tsx
      AlphaPanelChrome.tsx
      AlphaPanelLibrary.tsx
      AlphaLayoutLibrary.tsx
  panels/
    chart/
    securities/
    depth/
    tape/
    backtest/
    trading/
    risk/
  pages/
```

职责约束：

- `market/model.ts` 不导入 Alpha API schema、React 或 `lightweight-charts`。
- `FinancialChartController` 拥有图表实例和命令，不拥有 HTTP、WebSocket 或账户连接。
- `FinancialChart` 只负责 Canvas 宿主、生命周期和受控输入。
- `FinancialChartFrame` 负责专业工具栏、legend 和状态覆盖层。
- `scenes/` 把公共图表连接到行情查询、回测结果或实时事件。
- `panels/` 把 scene 放入工作台面板外壳，不反向污染公共组件。
- `AlphaPanelGrid` 只处理逻辑网格和拖动结果，不认识具体行情或交易模型。
- `AlphaPanelPool` 保持昂贵面板实例稳定。移动和缩放不得重建图表、查询或订阅。
- 所有场景共享同一个行情归一化入口，不分别实现时间、精度和颜色转换。

不要设计第二种渲染引擎接口。Controller 内部可以使用 Lightweight Charts 类型，业务模型、scene 和公共组件 props 不暴露这些类型即可。这里的隔离目标是保持业务边界清晰，不是支持运行时切换引擎。

## 工作台公共协议

### 面板实例与布局分离

```ts
type AlphaPanelInstance = {
  id: string;
  type: AlphaPanelType;
  binding: AlphaSymbolBinding;
  config: Record<string, unknown>;
};

type AlphaGridItem = {
  panelId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type AlphaWorkstationLayout = {
  schemaVersion: 1;
  id: string;
  name: string;
  panels: AlphaPanelInstance[];
  grid: AlphaGridItem[];
};
```

工作台加载时必须校验：

- `schemaVersion` 可识别并可迁移。
- panel ID 唯一，grid 与 panel 一一对应。
- 类型存在于 registry，未知类型以可恢复占位面板显示或安全移除。
- 坐标、尺寸和最小尺寸有限且位于允许范围。
- singleton、环境能力和实盘权限约束成立。
- 模板实例化生成新的运行时 ID，不与现有 Controller 或订阅冲突。

### Panel Registry

```ts
type AlphaPanelDescriptor<TConfig> = {
  type: string;
  titleKey: string;
  category: "market" | "research" | "backtest" | "trading" | "risk" | "tools";
  singleton: boolean;
  pinnable: boolean;
  defaultSize: { w: number; h: number; minW: number; minH: number };
  createDefaultConfig(): TConfig;
  validateConfig(value: unknown): TConfig;
  load(): Promise<{ default: React.ComponentType<AlphaPanelProps<TConfig>> }>;
};
```

面板库、默认尺寸、单例判断、懒加载、配置校验和可用环境都从 descriptor 生成。不要建立一个持续增长的中央 JSX `switch`。

首批面板只需覆盖真实页面需求：

- 证券列表。
- 专业 K 线。
- 行情快照。
- 数据质量和覆盖范围。
- 回测指标。
- 回测交易列表。
- 任务和事件。

五档、逐笔、下单、持仓、账户和风险面板等到 Alpha 后端存在对应权威协议时再注册。

### 标的联动频道

Shioaji 的全局跟随/锁定适合简单布局，OpenTerminalUI 的颜色 Link Group 更适合综合工作站。Terax 建议使用：

```ts
type AlphaLinkChannel = "red" | "blue" | "green" | "yellow";

type AlphaSymbolBinding =
  | { mode: "follow"; channel: AlphaLinkChannel }
  | { mode: "pinned"; vtSymbol: string };
```

- 证券列表、信号或筛选器向所属频道发布标的。
- K 线、五档、逐笔和下单面板只跟随相同频道。
- pinned 面板不响应频道更新。
- 发布事件携带来源 panel ID，防止循环回写。
- 多窗口同步通过 Terax 进程间事件或共享状态协议实现，不依赖浏览器 `BroadcastChannel`。
- 联动只传播标的、时间范围、十字线和必要选择，不共享图表实例。

### 状态和持久化

状态至少分为四层：

1. 运行时状态

   Controller、连接、订阅、请求、DOM 和 Canvas，只存在内存中。

2. 面板状态

   标的绑定、周期、复权、图表类型、筛选条件和显示选项，随布局保存。

3. 当前 Space 布局

   属于当前 Terax Workspace 进程和 Space，不改变进程环境。

4. 命名模板和全局偏好

   通过 Terax 白名单共享 store 执行加锁、读取最新值、最小变更和原子替换。不得使用 `localStorage` 或整表覆盖共享状态。

布局拖动期间不写 React 业务状态或持久化存储。只在交互结束后读取和提交最终坐标；连续结束事件使用短暂合并，且必须可取消。

## 公共金融图表和跨页面复用

同一 K 线图能够在数据管理、回测和实盘页面复用，前提是把图表分成四层：

```text
FinancialChart
  纯显示和命令输入

FinancialChartFrame
  工具栏、legend、状态和扩展插槽

Scene Adapter
  Market / Backtest / Live 的查询和事件连接

Page or Panel
  页面导航、工作台绑定和周边组件
```

典型用法：

- 数据管理页使用紧凑 `FinancialChart`，显示选中证券的覆盖数据，不创建实时订阅。
- 独立行情页使用完整 `FinancialChartFrame`，支持历史分页、周期、复权、导出和多 pane。
- 回测复盘 scene 向相同图表注入成交标记、持仓区间和回放命令。
- 实盘 scene 连接 HTTP 权威快照与 WebSocket 增量，并注入订单、持仓和 freshness 状态。
- 工作台 Chart Panel 只负责 binding、尺寸和 Panel Chrome，内部仍复用对应 scene。

公共组件 props 不暴露 Alpha API response、回测 ID、订单 SDK 或 Lightweight Charts 类型。

### 公共行情数据协议

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

- `vtSymbol`、代码、名称和交易所。
- 交易所时区。
- `pricePrecision` 和 `minMove`。
- 成交量单位。
- 红涨绿跌或绿涨红跌约定。
- 支持的周期和复权方式。

不要根据当前 500 根数据猜测精度、时区或市场颜色约定。

指标协议先保持渲染引擎无关：

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

## 行情共享与实时边界

多个面板不得各自建立重复连接和轮询。建议使用进程内 `MarketDataHub`：

```text
Alpha HTTP 权威快照 + WebSocket 增量
  Rust 通用代理
    MarketDataHub
      查询缓存与请求单飞
      标的/频道订阅引用计数
      freshness 和重连状态
      快照重新校准
      rAF 批处理
        Chart Controller
        Depth Panel
        Tape Panel
        Signal Panel
```

- 初次进入或断线恢复后查询权威快照。
- WebSocket 只提供增量，不被当作永久事实存储。
- 多个消费者订阅同一数据键时复用底层订阅。
- 最后一个消费者离开后才解除订阅。
- 页面隐藏时保留实例，但释放或暂停非必要的可见性相关工作。
- `live`、`delayed`、`stale`、`reconnecting` 和 `disconnected` 必须是显式状态。
- 实盘交易操作不能因行情显示为 live 就假定账户或订单通道可用。

## 五个参考项目的定向审查

### shioaji-pro-app

工作台优先阅读：

- `src/lib/workspace.ts`
- `src/App.tsx` 中 `BlockBody`、`BlockView` 和 workspace 操作
- `src/grid.css.ts`
- `src/components/panel-chrome.tsx`
- `src/components/panel-library.tsx`
- `src/components/layout-library.tsx`
- `src/lib/layout-thumb.ts`

图表优先阅读：

- `src/components/candle-chart.tsx`
- `src/lib/utils/kbars.ts`
- `src/lib/chart-indicators.ts`
- `src/lib/indicator-defs.ts`
- `src/lib/indicators.ts`
- `src/lib/theme-store.ts`

工作台亮点：

- `Workspace = blocks + layout` 分离业务实例和网格坐标。
- 24 列 `react-grid-layout` 提供高密度自由拖拽和缩放。
- `BLOCK_META` 集中描述分类、单例、绑定能力和默认/最小尺寸。
- `PanelChrome` 统一拖动、跟随、锁定、弹出和删除。
- 全局标的与 per-panel pin 组合出联动和独立面板。
- 内置标准看盘、日内、双图、衍生品、研究等场景模板。

图表亮点：

- 使用 `loadedKeyRef` 冻结标的和周期切换期间的实时更新，防止旧尾部写入新序列。
- 通过 `subscribeVisibleLogicalRangeChange` 在接近左边界时加载更早历史。
- 合并历史页后重新聚合跨分页边界的分钟 K 线，并重新拼接历史加载期间形成的实时尾部。
- 初始快照使用 `setData()`，实时当前 K 线使用 `update()`。
- 十字线 legend 使用 `requestAnimationFrame` 限流。
- 新 bar 完成时才触发指标重算，当前 bar 内 tick 不重算全量指标。
- 使用 pane stretch factor 保存和恢复窗格比例。
- 标的切换后恢复价格轴自动缩放，避免沿用前一个标的的价格范围。

不要直接移植：

- AGPL 源码。
- 大型 `App.tsx`、约 1,500 行 `CandleChart` 和中央 JSX `switch`。
- Shioaji 合约、SSE quote、下单、止盈止损和 trigger engine 协议。
- 捕获并忽略所有 `series.update()` 异常的做法。
- 固定按天数拉取 1 分钟数据并在浏览器聚合全部周期。
- `localStorage` 布局以及拖动期间持续写状态的方式。

### OpenTerminalUI

综合工作台优先阅读：

- `frontend/src/components/layout/LaunchpadContext.tsx`
- `frontend/src/components/layout/LaunchpadWorkspace.tsx`
- `frontend/src/components/layout/LaunchpadGrid.tsx`
- `frontend/src/components/layout/LaunchpadPanels.tsx`
- `frontend/src/components/layout/PanelChrome.tsx`
- `frontend/src/components/layout/TemplateGallery.tsx`
- `frontend/src/data/workspaceTemplates.ts`
- `frontend/src/contexts/SymbolLinkContext.tsx`
- `frontend/src/__tests__/launchpadTemplates.test.tsx`
- `frontend/src/__tests__/launchpadContextPersistence.test.tsx`
- `frontend/src/__tests__/symbolLinkContext.test.ts`

图表工作站优先阅读：

- `frontend/src/components/chart-workstation/ChartGridContainer.tsx`
- `frontend/src/components/chart-workstation/ChartPanel.tsx`
- `frontend/src/components/chart-workstation/ChartPanelHeader.tsx`
- `frontend/src/components/chart-workstation/LayoutSelector.tsx`
- `frontend/src/contexts/CrosshairSyncContext.tsx`
- `frontend/src/store/chartWorkstationStore.ts`

图表内核优先阅读：

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

- 回测工作区：`frontend/src/components/backtesting/workspace/`
- 回测面板：`frontend/src/components/backtesting/panels/`
- 回放：`frontend/src/shared/chart/replay.ts`
- 多图同步：`frontend/src/shared/chart/ChartSyncContext.tsx`
- 导出：`frontend/src/shared/chart/ChartExport.ts`
- 绘图：`frontend/src/shared/chart/drawingEngine.ts`
- 指标窗格：`frontend/src/shared/chart/useIndicators.ts`
- 完整交互清单：`frontend/src/components/chart/TradingChart.tsx`

最值得吸收的设计：

- Launchpad 的 12 列网格、面板配置、布局模板和服务端同步组成了五个项目中最完整的通用工作台参考。
- 面板 registry 使用 `React.lazy()`，未打开面板不加载实现。
- 红、蓝、绿、黄联动组比单一全局标的更适合多图和多屏。
- `IntersectionObserver` 让离屏面板停止渲染昂贵内容，适合作为可见性策略参考。
- Chart Workstation 使用固定 CSS Grid 模板支持 1 到 6 图，对只需要多图而不需要任意小面板的页面更简单。
- 回测工作区把统计面板通过 registry 组合，行为清单和测试覆盖面广。
- 把 K 线转换、尾部判断和 rAF 批处理写成纯函数，并为实时、回填、绘图、回放、同步和导出分别测试。
- 将 Canvas 外的可访问性描述层独立实现。

需要改进后采用：

- Launchpad 当前把业务状态和几何坐标放在同一个 panel 对象，Terax 应分别建模。
- `onLayoutChange` 会持续提交布局，Terax 只在 drag/resize stop 后提交。
- `localStorage + server PUT` 不符合 Terax 的共享 store 和多进程原子写入规则。
- registry 仍是集中手写映射，Terax descriptor 还应包含校验、能力、尺寸和国际化 metadata。
- OpenTerminalUI 同时存在 Launchpad、Chart Grid 和回测 Mosaic 三套布局。Terax 应按场景只保留顶层 Workbench、通用 Alpha Grid 和图表内部 pane 三个明确层级。
- 不直接移植接近 3,000 行的 `TradingChart.tsx`，也不一次引入全部资产、研究和模型功能。

建议参考的测试：

- `ChartEngine.updateGuard.test.tsx`
- `TradingChart.realtime.test.tsx`
- `chartDataService.test.ts`
- `rafBatcher.test.ts`
- `RendererCore.performance.test.ts`
- `CrosshairSyncContext.test.tsx`
- `ChartSyncContext.test.tsx`
- `ChartExport.test.ts`
- `drawingEngine.test.ts`
- `replayUtils.test.ts`
- `useIndicators.panes.test.tsx`
- `workspaceTemplateStore.test.ts`
- `workstationPersistence.test.ts`

### openalgo

工作台和图表优先阅读：

- `frontend/src/pages/Trading.tsx`
- `frontend/src/components/trading/ChartPane.tsx`
- `frontend/src/components/trading/DrawingRail.tsx`
- `frontend/src/components/trading/DrawingStyleBar.tsx`
- `frontend/src/components/trading/IndicatorSettingsDialog.tsx`
- `frontend/src/lib/trading/terminal.ts`
- `frontend/src/lib/trading/chartTheme.ts`
- `frontend/src/lib/trading/chartTypes.tsx`
- `frontend/src/lib/trading/drawTools.tsx`

策略和实盘按需阅读：

- `frontend/src/pages/flow/FlowEditor.tsx`
- `frontend/src/components/flow/nodes/`
- `frontend/src/components/flow/panels/`
- `frontend/src/lib/flow/constants.ts`
- `frontend/src/pages/Scalping.tsx`
- `docs/design/54-scalping-terminal/README.md`
- `frontend/src/pages/StrategyBuilder.tsx`
- `frontend/src/pages/OptionChain.tsx`
- `frontend/src/pages/Sandbox.tsx`
- `frontend/src/pages/monitoring/`

值得吸收的设计：

- Trading 页面使用固定 CSS Grid 预设构造单图、双图、1+2、2x2、3x2 和 4x2，适合多图专用页面。
- 每个 `ChartPane` 有稳定 pane ID、独立标的和周期，页面级绘图轨道作用于当前活动 pane。
- React `ChartPane` 负责工具栏、菜单、对话框和状态；独立 `TradingTerminal` 负责图表实例、行情、命令和事件回调。
- 绘图、指标和高级图表能力按需动态加载。
- 图上买卖、订单线拖动修改、持仓线、止损止盈和 DOM ladder 提供了实盘交互参考。
- 统一 REST/WebSocket 经纪商边界、Sandbox、Action Center、监控和风控页面比它的自由布局更有参考价值。
- Flow Editor 的节点 registry、配置面板、保存、执行和日志适合作为未来可视化策略编排参考。
- Scalping 设计明确 session、市场数据、订单簿、持久止损、服务端风险监控和失败边界。

不要直接移植：

- AGPL 源码。
- OpenAlgo REST、WebSocket、经纪商凭据和下单协议。
- `terminal.ts` 中把行情、图表、交易和持久化集中到一个 Controller 的做法。
- `localStorage` 状态和英文硬编码工具栏。

Terax 的图上交易必须只发送经过校验的命令意图。订单权威状态、幂等键、风险检查、拒单原因和重连恢复均由 Alpha 服务负责，图表不能乐观地假定订单已经成交或修改成功。

### lightweight-charts-drawing

优先阅读：

- `src/core/drawing-manager.ts`
- `src/core/drawing.ts`
- `src/core/types.ts`
- `src/core/geometry.ts`
- `src/rendering/drawing-pane-view.ts`
- `src/interaction/`
- `src/registry/`
- `docs/TOOLS.md`

亮点：

- `DrawingManager`、`IDrawing`、interaction handler、pane view 和 tool registry 边界明确。
- 工具 descriptor 统一声明名称、分类、锚点数、默认样式和 factory。
- selection、hover、editing、control point 和 hit-test 使用统一协议。
- 序列化保存工具类型、锚点、样式和选项，适合映射成 Terax 版本化绘图状态。
- 已实现 68 种工具，适合作为能力清单和交互覆盖参考。

风险：

- 当前没有自动化测试，工具数量不能代替可靠性验证。
- registry 静态导入大量工具，整体接入可能增加 bundle 和初始化成本。
- 多 pane、历史 prepend、隐藏恢复和 Windows WebView pointer 行为需要单独验证。

正式采用前先建立隔离原型验证：

1. 趋势线、水平线、矩形和 Fibonacci retracement。
2. 创建、取消、选中、移动锚点、整体拖动和删除。
3. 磁吸开关、缩放、滚动和高 DPI。
4. 历史数据 prepend 后锚点保持不变。
5. 图表隐藏和恢复后事件监听不重复。
6. JSON 导出、版本校验和恢复。
7. 多 pane 下只在目标 pane 命中。
8. Windows WebView 的 pointer、鼠标和触控行为。

若验证失败，只吸收 manager、geometry、序列化结构和少量基础工具，不移植全部工具。

### lightweight-charts-indicators

优先阅读：

- `README.md` 中的 Output Format 和 Indicator Registry。
- `src/index.ts`
- `src/types.ts`
- `src/standard/sma.ts`
- `src/standard/ema.ts`
- `src/standard/macd.ts`
- `src/standard/rsi.ts`
- `tests/unit/`
- `tests/regression/`

亮点：

- 指标定义与指标实例分离。
- 输入参数、默认值、overlay、plots、水平线和 fill 使用 metadata 表达。
- 计算结果包括 series、markers、bar color、background、labels、lines、boxes 和 tables 等多种输出。
- registry 可以生成动态指标选择器和设置界面。
- 标准、社区和蜡烛形态目录覆盖面广，并包含单元和外部结果回归测试结构。

采用边界：

- 该项目主要提供计算与 metadata，不提供完整 React 指标面板或自动 pane 管理。
- 不把 `oakscriptjs.Bar`、`InputConfig` 或 `IndicatorResult` 作为 Terax 公共类型。
- Alpha 已包含 Python `ta-lib`，正式指标优先由 Alpha 计算，使图表、筛选、回测和 Agent 使用同一口径。
- 如果以后需要浏览器内即时预览，再评估 Web Worker 中的 JS 计算。
- Python 与 JavaScript 双实现必须有固定数据集差分测试，不能各自演进。

## 第一阶段专业图表范围

第一阶段图表目标是成为工作站所有场景可复用的行情基础：

1. 全尺寸独立 `alpha-market` Workbench 页面。
2. 数据管理页复用相同组件的紧凑模式。
3. 工作台使用相同组件的 Chart Panel。
4. 蜡烛图、OHLC Bar 和收盘线。
5. 独立且可调整高度的成交量 pane。
6. 标的、周期、复权和图表类型工具栏。
7. 固定 OHLC、涨跌幅、成交量和成交额信息栏。
8. 十字线、最新价线、昨收参考线和价格轴标签。
9. 左侧历史分页、单飞请求和到达最早数据状态。
10. 用户离开实时尾部后停止自动跟随，并显示“回到最新”。
11. 加载、空数据、错误、延迟和断线状态。
12. 主题、精度、时区和涨跌色约定。
13. 截图和适配内容命令。
14. 交易标记、绘图和指标的扩展插槽，但不实现全部公式。

不要在第一阶段实现新闻、财经日历、社交分享、复杂图形工作区和几十种指标。

## 行情 API 与历史分页

当前 [`alpha/api/routes/bars.py`](../../alpha/api/routes/bars.py) 在没有显式 `start` 时可能使用总览最早时间，存储层读取完整区间后才截取最后若干根。分钟线规模扩大后不能满足专业图表和多面板工作台的历史加载要求。

第一阶段应让存储和 API 支持真正的倒序限量查询：

- 初次加载最近一批 K 线。
- 以当前最早时间作为 `before` cursor 加载更早数据。
- 存储层执行倒序 `LIMIT`，响应再恢复时间升序。
- 响应提供 `has_more_before` 和实际覆盖范围。
- 前端按时间去重，拒绝非法 OHLC 和非单调时间。
- 历史 prepend 后恢复原 visible logical range。

后端输出 `amount` 时，前端 schema 必须同步接收。期货场景按需增加 `open_interest`。

## 性能不变量

### 图表

- 图表实例只在宿主挂载时创建一次。
- 标的或周期初始快照使用 `setData()`。
- 实盘当前 bar 使用 `update()`，不为每个 tick 重建 React bars 数组。
- 同一时间戳替换当前 bar，更晚时间戳追加，迟到数据执行明确策略。
- 十字线和实时 tick 最多每动画帧更新一次 React 展示状态。
- `fitContent()` 只用于首次加载、标的切换或用户主动命令。
- 新 bar 到达不得重置用户缩放和滚动位置。
- 历史回填不得改变用户正在观察的屏幕内容。
- 主题切换只应用 options，不重建 chart。
- 未启用指标或绘图时不加载代码、不创建 pane、不计算数据。

### 工作台

- 面板 ID 在移动、缩放和模板内保持稳定。
- 拖动和缩放过程不更新业务 React 状态，不写 store。
- Panel Grid 不直接拥有行情查询或订阅。
- 同一数据键的查询、实时连接和计算结果尽量复用。
- 面板离屏或页面隐藏时暂停 resize、轮询和非必要绘制，恢复后只同步最终尺寸。
- Panel Library 的预览默认使用静态缩略图，只允许白名单面板按需挂载一个真实预览。
- Alpha 工作台未打开时，不加载网格、绘图、指标或实盘模块。
- 多图十字线和时间范围同步只传播轻量事件，不共享图表实例。

## 实盘安全不变量

- 模拟和实盘环境必须有持续可见且不可混淆的标识。
- 下单、改单、撤单和平仓必须经过 Alpha 服务端参数校验、权限和风险检查。
- 每个交易命令具有幂等键，UI 超时或重连不能重复提交同一操作。
- UI 不以乐观状态替代订单权威状态，失败和未知状态必须可见。
- 行情、账户和订单通道分别展示 freshness，不能用一个绿色连接灯概括全部状态。
- 重连后重新获取账户、持仓、订单和必要行情快照，再应用增量。
- 断线期间的允许操作必须显式定义，不能静默排队危险命令。
- 密钥只进入系统 keychain 或 Alpha 受控凭据路径，不进入布局、日志或浏览器持久化。
- 图表 primitive 只产生交易意图，不直接调用外部经纪商 SDK。

## 测试与验收路由

### 工作台纯函数和模型测试

- schema 校验、迁移和未知 panel fallback。
- panel/grid 一一对应、重复 ID、单例和尺寸范围。
- 模板实例化生成稳定且不冲突的新 ID。
- 增加、删除、复制和切换布局不污染原模板。
- 标的频道跟随、pin、来源去重和跨频道隔离。
- 拖动结束归一化与持久化合并。

### 图表纯函数测试

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
- 面板移动和缩放不重建 Controller。
- 最后一个消费者离开后才解除共享订阅。

### React 测试

- 页面、scene 和工作台面板使用同一个公共图表。
- 面板 registry 懒加载、错误边界和 capability fallback。
- 工具栏命令、受控状态和 Panel Chrome。
- loading、empty、error、delayed、stale、reconnecting 和 disconnected 状态。
- OHLC 信息栏在十字线离开时恢复最新 bar。
- 可访问性文本和所有用户可见文案国际化。

### 实盘协议测试

- 命令幂等、拒单、超时、未知结果和重连恢复。
- 账户、订单、持仓和行情快照与增量的顺序。
- 风险限额和交易环境不可被布局配置绕过。
- 图上订单拖动只在释放后提交，并能恢复服务端拒绝后的权威位置。

### 运行时验证

实现涉及真实网格拖动、pane 调整、可见范围、命中区域、WebView Canvas、ResizeObserver、Pointer Events 或图上交易时，按 [`ui-runtime-debugging.md`](../contributing/ui-runtime-debugging.md) 使用相同复现条件验证修改前后行为。依赖 Alpha IPC、WebSocket 或原生窗口的场景使用真实 Tauri 运行时。

## 分阶段实施顺序

### 阶段一：公共图表基础

- 完成 engine-neutral 行情模型和统一归一化。
- 拆分 `FinancialChartController`、公共组件、专业外壳和 scene。
- 完成历史分页、viewport、状态、主题和导出。
- 数据管理页和独立行情页复用同一个图表。

### 阶段二：工作台内核

- 先用轻量占位面板完成 registry、Panel Chrome、PanelPool 和布局 schema。
- 隔离验证 Alpha 内部网格，确认拖动结束持久化、隐藏恢复和 WebView 行为。
- 完成面板库、布局模板和颜色联动频道。
- 工作台 Chart Panel 复用阶段一公共图表。

### 阶段三：数据研究和回测复盘

- 接入证券列表、数据质量、筛选结果和行情图面板。
- 接入回测交易标记、持仓区间、统计面板和回放控制。
- 完成回测结果比较和参数优化视图。
- 参考 OpenTerminalUI 的 replay、sync、workspace 和性能测试。

### 阶段四：实时行情和模拟交易

- 建立 MarketDataHub、HTTP 快照、WebSocket 增量和订阅引用计数。
- 完成五档、逐笔、信号、账户、持仓、订单和事件面板。
- 先在模拟环境验证重连、幂等、风险和未知状态。

### 阶段五：实盘交易

- 按经纪商适配器边界接入 Alpha，不把适配逻辑放入 React 或 Rust proxy。
- 增加图上交易、订单线、持仓线和风险监控。
- 完成服务端风控、审计、恢复和故障降级。
- 实盘能力必须在完整协议测试和真实运行时验证后启用。

### 阶段六：绘图、指标和高级工作流

- 对 `lightweight-charts-drawing` 完成小工具集验证后逐步扩大。
- 指标使用 engine-neutral descriptor，优先由 Alpha Python 和 TA-Lib 计算。
- 按需加入多图同步、组合研究、压力测试和策略 Flow。
- 只有明确需要浏览器即时预览时才引入 Web Worker 指标计算。

## 需要重新审查外部源码的条件

出现以下情况时才重新阅读对应项目，不需要例行重读全部仓库：

- Alpha 要实现或修改自由面板工作台时，复核 Shioaji Workspace 和 OpenTerminalUI Launchpad。
- Alpha 要实现颜色联动、多窗口同步或模板服务端同步时，复核 OpenTerminalUI 对应 Context、Store 和测试。
- Lightweight Charts 升级主版本或 pane、primitive、marker API 发生变化。
- Terax 要实现实时 tick 聚合时，复核 Shioaji 和 OpenTerminalUI 的实时更新、聚合与边界测试。
- Terax 要实现回放、多图或十字线同步时，复核 OpenTerminalUI 对应模块和测试。
- Terax 要实现图上交易或实盘风险时，复核 openalgo Trading、Scalping 设计和失败边界，但保持独立实现。
- Terax 要实现可视化策略编排时，复核 openalgo Flow Editor 的节点、配置、保存、执行和日志边界。
- Terax 要实现绘图时，复核 `lightweight-charts-drawing` 当前 manager、interaction、serialization 和测试现状。
- Terax 要实现指标时，复核 `lightweight-charts-indicators` registry、output schema、回归测试和依赖版本。
- 本文列出的关键文件在本地参考仓库中已被删除、拆分或 API 发生实质变化。

若只是上游新增无关页面、券商适配、绘图工具或指标数量，不需要更新本文。
