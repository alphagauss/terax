# Alpha 综合量化工作站设计与参考项目指南

本文记录 Alpha 综合量化工作站的产品边界、前后端职责、公共组件复用方式、外部参考项目审查结论、建议阅读路径和分阶段实施顺序。后续开发应先阅读本文，再由 Codex 或开发者围绕当前功能定向检索两个参考项目的实现、测试和交互，优先吸收经过验证的实践。本文列出的文件和建议是起点而非封闭清单，最终方案仍需结合 Terax 约束独立判断和实现。

本文是长期设计参考，已完成实现以“当前 Terax 基线”为准，其余设计不表示相关功能已经实现。当前阶段和下一项任务记录在临时的 [实施进度](./alpha-quant-workstation-implementation.md) 中。Alpha 与 Terax 的进程和业务边界仍以 [Alpha 集成架构](./alpha-integration.md) 和根目录 `AGENTS.md` 为准。

## 产品目标

Alpha 的目标不是单独增加一张专业 K 线图，而是在 Terax 中形成个人自用的综合量化工作站，逐步覆盖：

- 行情数据管理、质量检查和历史浏览。
- 专业行情图、多图对照、技术指标和绘图。
- 标的研究、筛选、组合分析和风险分析。
- 策略开发、参数配置、回测、优化和复盘。
- 模拟交易、实时行情、虚拟订单、持仓、账户和风险监控。
- 可组合面板、场景化布局模板、标的联动和多屏工作流。
- AI Agent 对数据、策略、回测和模拟交易状态的统一访问。

工作站不是一个包含全部功能的单体页面。Terax 顶层 Workbench 继续负责 Terminal、Editor 和 Alpha 页面之间的标签与分割；Alpha 量化工作台页面内部可以拥有面向量化场景的高密度面板网格。

当前设计范围止于模拟交易闭环。真实券商接入、实盘订单执行和对应技术选型留到模拟盘稳定后单独设计，本文不提前指定实现框架或适配器。

```text
Terax Space / Workbench
  Terminal
  Editor
  Alpha 数据管理
  Alpha 策略与回测
  Alpha 综合工作台
    工作台工具栏
    布局模板与面板库
    Alpha 面板网格（Panel Grid）
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
- 同一个公共 K 线组件用于数据管理、独立行情、多图、回测复盘和模拟交易页面，不为每个页面复制图表实现。
- 公共图表组件不直接请求 Alpha API，不认识回测 ID、模拟账户、工作台面板或 Workbench 标签。
- 普通页面和工作台面板通过业务场景组件（Scene）连接查询、回测标记、实时订阅和模拟交易状态。
- Terax 顶层 SplitView 继续只使用 `react-resizable-panels`。Alpha 页面内部的自由面板网格是不同层级的布局能力，不替换顶层 SplitView。
- Alpha 面板网格（Panel Grid）固定使用 24 列逻辑网格，禁止重叠，碰撞时自动重排并采用纵向紧凑排列。窄窗口保持逻辑坐标并允许横向滚动，不维护另一套响应式持久化布局。
- 首期标的联动只提供工作台主标的跟随和单面板固定。多联动组、时间范围同步和十字线同步按真实多图需求渐进增加。
- Alpha 不自行实现原生窗口框架。轻量业务视图复用通用辅助窗口，完整工作页的复制复用 Workspace 跨窗口能力。
- 工作台、图表、绘图和指标状态都使用可版本化 JSON 表达，不持久化 React、Canvas、Controller、Query 或连接实例。
- Alpha FastAPI 是量化领域和权威数据边界。Rust 只负责生命周期、凭据注入和通用代理，不复制行情、策略、订单或风险领域模型。
- 当前实施顺序优先建设 Terax 自有的公共金融图表和工作台内核，再补齐数据同步恢复与后续领域协议，不一次引入所有面板、指标和绘图工具。

## 复用层次与术语

本节既用于统一文档表述，也是 Codex 和开发者新增 Alpha 页面、工作台面板或图表能力前必须检查的复用约束。目标是让同一业务内容只有一份实现，避免普通页面和工作台各自维护请求、状态、数据转换或图表代码。

| 代码术语 | 统一中文名称 | 职责 |
| --- | --- | --- |
| `Controller` | 控制器 | 管理 Lightweight Charts 实例和命令，不请求业务数据。 |
| 公共 React 组件 | 公共内容组件 | 渲染可复用的图表、表格或其他业务内容，不认识具体页面和工作台布局。 |
| `Scene` | 业务场景组件 | 把公共内容组件连接到行情、回测、实时事件或模拟交易数据，可被普通页面和工作台面板共同使用。 |
| `Panel` | 工作台面板 | 对业务场景组件进行薄包装，补充标的绑定、可见性和面板配置，使其能够进入工作台。 |
| `Panel Chrome` | 面板控制栏 | 提供标题、拖动、跟随或固定、删除等工作台操作，不包含业务内容。 |
| `Panel Grid` | 面板网格 | 使用 24 列坐标摆放、移动和缩放工作台面板，不认识行情、回测或交易模型。 |

图表当前和后续应保持以下复用关系：

```text
公共图表组件
  ↓ 连接具体业务数据
业务场景组件（Scene）
  ├─ 普通页面直接使用
  └─ 工作台面板（Panel）薄包装
       ↓
     24 列面板网格（Panel Grid）
```

例如，`MarketChartScene` 是行情图表场景组件。数据页和独立行情页直接使用它；`AlphaChartPanel` 只负责把它包装成工作台图表面板，再交给 `AlphaPanelGrid` 摆放。三处共用同一套图表和行情查询逻辑，但各自拥有适合自身尺寸和交互的运行中图表实例，不跨页面搬运同一个 DOM 或 Canvas。

新增或修改 Alpha 功能前必须遵守以下检查顺序：

1. 先检查现有 `chart/`、`scenes/`、业务组件和工作台面板注册表，确认是否已经存在可复用实现。
2. 普通页面需要已有业务内容时直接复用业务场景组件，不为页面复制请求、缓存、归一化或渲染逻辑。
3. 工作台需要已有业务内容时新增或复用薄面板包装，不在面板中建立第二套业务实现。
4. 只有内容确实需要进入可拖拽工作台时才使用工作台面板；普通页面不依赖面板控制栏、面板网格、工作台模板或工作台持久状态。
5. 第二个独立页面需要可拖拽布局时可以复用面板网格和稳定挂载能力，但必须拥有自己的模板和持久状态键，不能误用综合工作台的布局状态。
6. 如果没有第二个真实使用方，也没有长期架构明确要求复用，则不为了假设中的需求提前增加公共抽象。

轻量辅助窗口也可以复用业务场景组件，但辅助窗口拥有独立的 WebView 和 React 根。它应通过封闭注册的辅助页面薄包装重新创建自己的业务内容实例，复用同一个 Alpha 后端和共享磁盘配置，但不与主窗口共享内存查询缓存、DOM、Canvas 或 Controller。面板控制栏、面板网格和综合工作台持久状态不得成为轻量辅助窗口的默认依赖；完整工作台需要进入另一个窗口时使用完整 Workspace 窗口能力。

## 当前 Terax 基线

- Alpha FastAPI 共享服务、Rust 生命周期管理、凭据注入及通用 HTTP、WebSocket 代理已经接通，前端不直接管理 Python 进程或服务凭据。
- 数据目录已经支持证券资料与行情覆盖的联合查询、服务端搜索与 Facet 过滤、分页、覆盖区间和全局摘要，数据页复用这些接口展示当前数据状态。
- 后端已有证券、指数成分和日线同步任务，以及重叠区校验和异常报告基础；当前业务 API 只提供同步任务列表，尚未形成启动、重试、质量查看和失败恢复闭环。
- 前端行情模型和归一化位于 `src/modules/alpha/market/`，明确区分无时区交易日和带时区绝对时间，并统一处理 OHLC 校验、顺序、去重和跨页合并。
- 公共金融图表已经拆分到 `src/modules/alpha/chart/`。`FinancialChartController` 管理单个 Lightweight Charts 实例、蜡烛图、OHLC Bar、收盘线、成交量 pane、主题、rAF 尺寸更新、十字线和 viewport 命令；React 外壳不拥有查询。
- 行情图表场景组件 `MarketChartScene` 使用现有排他 `before` 游标执行左侧历史分页，仅在用户操作时间轴后请求；React Query 保持请求单飞和标的查询键隔离，停滞游标终止分页，跨页数据线性合并并补偿逻辑范围。数据页已经直接复用该业务场景组件和公共图表，旧 `AlphaFinancialChart` 和兼容包装已删除。
- 图表实例只在宿主挂载时创建，日线使用 `BusinessDay`，主题和图表类型切换只应用 options，页面隐藏、尺寸变化和历史 prepend 不重建 Canvas。工具栏、OHLC/成交量/成交额信息栏、加载、空数据、错误、最早数据和历史重试状态已经接入中英文文案；用户平移越过数据两端时保留少量 K 线，重置视图恢复价格自动缩放和全量时间范围。图内 TradingView 标识已经替换为设置页中的用户可见署名链接。
- 工作台公共协议已经位于 `src/modules/alpha/workstation/`。`schemaVersion: 1` 布局分别保存面板实例和 24 列网格坐标，只接受纯 JSON 配置；解析边界校验版本、ID、panel/grid 一一对应、横向范围、最小尺寸、重叠、singleton 和 descriptor 配置。
- 面板注册表（Panel Registry）已经集中面板标题键、分类、singleton、pinnable、默认尺寸、默认配置、配置校验和懒加载入口。每种类型的 `React.lazy` 组件在注册时创建并缓存，枚举 metadata 不执行 loader，未知类型由挂载层局部显示可恢复状态。
- `AlphaPanelPool` 为每个 panel ID 保持固定 DOM 容器，并通过 portal 连接 `AlphaPanelHost`。宿主替换、暂时消失、排序和页面隐藏不会重挂载面板；显式删除才销毁实例，单个 loader 失败由面板级错误边界隔离。
- Alpha 综合工作台已经作为可恢复 Workbench 页面接入导航。页面使用固定 24 列 `react-grid-layout`、纵向紧凑排列、碰撞重排和 1,200 px 最小逻辑宽度；拖动和缩放期间不提交业务状态，只在 stop 事件保存最终坐标。布局锁定同时关闭移动和缩放。
- 工作台首批只注册复用现有 `MarketChartScene` 的图表面板（Chart Panel），内置单图和双图模板每次生成新的布局与 panel ID。面板控制栏（Panel Chrome）统一提供标题、拖动、删除和 follow/pinned，工作台主标的变化只影响 follow 面板。
- `AlphaWorkstationState` 把主标的、锁定和布局作为 `terax-alpha.json` 的单个 `workstation` 键原子保存。所有窗口都可以合并写入并在应用关闭前 flush，也通过共享 store 变更通知刷新，不建立窗口级持久化所有权。
- `/bars` 同时支持 `start + end` 范围查询和基于排他 `before` 游标的有界历史查询。历史查询从最新分片向前执行倒序 `LIMIT`，返回升序数据、`has_more_before`、下一游标和实际范围；不同页面共享完整覆盖范围的复权锚点。
- [`getAlphaBars()`](../../src/modules/alpha/api.ts) 已接入统一行情归一化和分页元数据；数据页使用日线、前复权和每页 500 根的左侧历史加载。公共图表对稳定尾部使用 `update()`，对历史修订使用 `setData()`，尚未接入周期、复权切换或实时增量。
- 当前 Alpha 页面包括综合工作台、数据、回测和设置，尚没有独立行情页、策略页、回测复盘页和模拟交易页。
- Terax Workbench 已有递归分割树、稳定 tab ID 和 `WorkbenchViewPool`。移动、分割和隐藏页面不应重挂载其运行时实例。
- 迁移时保留 `alphaBusinessDay()` 的时区不变量和测试，将其下沉到行情归一化模块。不要继续把新能力堆入现有临时组件。

## 外部源码位置、版本和许可证

假定两个参考项目位于 `D:\OneDrive\open`。这些本地源码同时供 Codex 和开发者进行功能检索、架构比较、交互研究和测试设计，不局限于人工阅读或本文已经列出的文件。它们仍不是 Terax 的构建或运行时依赖，不得成为构建输入、运行时查找路径或 Terax 源码导入路径。

| 项目 | 本地目录 | 审查提交 | 许可证 | 主要定位 |
| --- | --- | --- | --- | --- |
| [shioaji-pro-app](https://github.com/Sinotrade/shioaji-pro-app) | `D:\OneDrive\open\shioaji-pro-app` | `a6c9bd2` | AGPL-3.0-only | 交易终端产品形态、自由面板布局和 LWC 5.2 实现 |
| [OpenTerminalUI](https://github.com/Hitheshkaranth/OpenTerminalUI) | `D:\OneDrive\open\OpenTerminalUI` | `fc16fd6` | MIT | 综合工作站页面、Launchpad、联动组、图表能力和测试场景 |

开始相关功能的设计或开发前，先运行 `git rev-parse --short HEAD` 检查本地版本，再围绕功能关键词、相邻模块和测试定向检索两个项目。提交不同不要求重新通读整个项目；已经审查过的关键文件仅在发生实质变化时重新通读。

Terax 使用 Apache-2.0。`shioaji-pro-app` 是 AGPL-3.0-only，在没有额外授权或兼容的重新许可前，只能吸收产品思想、公开行为和架构经验并独立实现，不能把其源码直接复制或轻微修改后合入 Terax。MIT 和 Apache-2.0 项目如需复用代码，仍要保留许可证、版权和 NOTICE 要求，并在采用前确认目标文件没有额外来源限制。

## 两个项目的参考价值总览

| 能力 | 首选参考 | 补充参考 | Terax 的采用方式 |
| --- | --- | --- | --- |
| 综合面板工作台 | OpenTerminalUI Launchpad | shioaji-pro-app Workspace | 自有版本化面板协议、懒加载 registry、网格布局和稳定 PanelPool |
| 终端密度与交互 | shioaji-pro-app | OpenTerminalUI | 吸收 24 列网格、面板控制栏、布局模板、主标的跟随和固定交互 |
| 专业 K 线生命周期 | shioaji-pro-app | OpenTerminalUI | Lightweight Charts Controller 与 React 外壳分离 |
| 标的联动 | shioaji-pro-app | OpenTerminalUI | 首期使用工作台主标的与 per-panel pin，多联动组按需扩展 |
| 多图同步 | OpenTerminalUI | shioaji-pro-app | 时间范围和十字线使用独立开关与轻量运行时事件，不与标的绑定混合 |
| 回测复盘页面 | OpenTerminalUI | shioaji-pro-app 图表 | 复用公共图表、交易标记、回放和统计面板 |
| 模拟交易 | OpenTerminalUI | shioaji-pro-app 交互 | Alpha 维护虚拟账户、订单、成交、持仓和风险权威状态 |
| 图表运行时和生命周期 | shioaji-pro-app | OpenTerminalUI | 只围绕 Lightweight Charts 建设 Controller、测试和扩展能力 |
| 绘图与指标交互 | OpenTerminalUI | shioaji-pro-app | 仅按阶段所需能力独立实现，指标计算以 Alpha Python 为准 |
| 测试和边界行为 | OpenTerminalUI | shioaji-pro-app | 提取纯函数、性能测试和场景测试，不复制单体组件 |

正常开发的参考规则为：

1. 新增或实质修改 Alpha 功能、架构和交互前，优先在两个项目中查找相同或相邻能力的实现、测试与边界行为；本文未列出的相关文件也可以按需阅读。
2. `OpenTerminalUI` 是默认主参考，覆盖综合工作台、图表、多图同步、回测、模拟交易和测试。
3. `shioaji-pro-app` 是交易终端产品形态、Lightweight Charts 生命周期、实时更新、24 列高密度布局和主标的联动的重点补充参考。
4. 参考项目不替代 Terax 的架构判断。可以组合、简化或拒绝其方案，但应记录关键取舍，避免无依据地重新设计已有成熟能力。
5. Terax 从第一版就拥有自己的领域协议、组件 API、状态和持久化边界，不采用先耦合外部实现再整体移除的过渡架构。

## 工作站总体架构

### 两级布局

Terax 保留两级、不同职责的布局系统：

1. 顶层 Workbench

   - 负责 Terminal、Editor、Alpha 页面和其他资源标签。
   - 使用现有递归 `react-resizable-panels` SplitView。
   - 使用稳定 `WorkbenchViewPool` 保持页面运行时实例。

2. Alpha 综合工作台页面

   - 负责行情、研究、回测和模拟交易小面板的高密度组合。
   - 使用 24 列 `react-grid-layout` 实现页面内部网格，其定位不是新的顶层 SplitView。
   - 禁止面板重叠，碰撞时自动重排并纵向紧凑排列；工作区可以向下扩展。
   - 窄窗口不改写逻辑坐标，通过最小工作区宽度和横向滚动保留用户布局。
   - 布局默认可编辑，并提供与标的固定相互独立的工作台级布局锁定。
   - 网格依赖必须随 Alpha 工作台懒加载，未打开时不得增加 eager bundle、Observer、连接或定时器。
   - 面板拖动和缩放期间由布局库通过 `transform` 更新视觉位置，只在 `onDragStop` 和 `onResizeStop` 提交最终布局。

递归 SplitView 适合 IDE 资源布局，自由网格适合交易终端面板。不要让用户通过顶层 Workbench 的每个 Tab 手工模拟整套交易终端，也不要在普通 Alpha 数据页中嵌套完整网格。

完整 `AlphaWorkstationPage` 将来可以作为可重建页面复制到临时 Workspace 窗口，但 Alpha 不拥有窗口启动、跨进程交接或原生生命周期。具体边界见 [Workspace 工作页跨窗口复制](./workspace-page-handoff.md)。

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
  AlphaRiskPage.tsx
  AlphaSettingsPage.tsx
```

- `AlphaDataPage`：数据目录、同步、质量、覆盖范围和紧凑行情预览。
- `AlphaMarketPage`：单标的全尺寸专业行情浏览。
- `AlphaWorkstationPage`：自由组合的行情、研究、回测或模拟交易面板工作台。
- `AlphaStrategiesPage`：策略文件、版本、参数、依赖和运行入口。
- `AlphaBacktestsPage`：任务列表、比较、优化和结果导航。
- `AlphaBacktestReviewPage`：公共 K 线、交易标记、回放、成交列表和统计面板。
- `AlphaPaperTradingPage`：模拟账户、订单、持仓和事件。
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
      PaperTradingChartScene.tsx
  workstation/
    model.ts
    registry.ts
    layout.ts
    persistence.ts
    symbolSelection.ts
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
    paper-trading/
    risk/
  pages/
```

职责约束：

- `market/model.ts` 不导入 Alpha API schema、React 或 `lightweight-charts`。
- `FinancialChartController` 拥有图表实例和命令，不拥有 HTTP、WebSocket 或模拟账户连接。
- `FinancialChart` 只负责 Canvas 宿主、生命周期和受控输入。
- `FinancialChartFrame` 负责专业工具栏、legend 和状态覆盖层。
- `scenes/` 存放业务场景组件，把公共图表连接到行情查询、回测结果或实时事件。
- `panels/` 存放工作台面板，把业务场景组件放入工作台薄外壳，不反向污染公共组件。
- `AlphaPanelGrid` 只处理逻辑网格和拖动结果，不认识具体行情或交易模型。
- `AlphaPanelPool` 使用固定 DOM 容器和 portal 保持昂贵面板实例，`AlphaPanelHost` 只提供当前网格宿主。移动、缩放、自动重排、宿主替换和临时隐藏不得重建图表、查询或订阅。
- 所有场景共享同一个行情归一化入口，不分别实现时间、精度和颜色转换。

不要设计第二种渲染引擎接口。Controller 内部可以使用 Lightweight Charts 类型，业务模型、业务场景组件和公共组件 props 不暴露这些类型即可。这里的隔离目标是保持业务边界清晰，不是支持运行时切换引擎。

## 工作台公共协议

### 面板实例与布局分离

```ts
type AlphaPanelInstance = {
  id: string;
  type: string;
  binding: AlphaSymbolBinding;
  config: AlphaPanelConfig;
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

工作台布局固定使用 24 列坐标。模板、当前布局和持久化状态不维护 12 列或其他 breakpoint 版本；窗口宽度变化只改变坐标到像素的映射。

工作台加载时必须校验：

- `schemaVersion` 必须是当前可识别版本；首版拒绝未知版本，出现真实旧版本后再增加对应迁移。
- panel ID 唯一，grid 与 panel 一一对应。
- 类型存在于 registry，未知类型以可恢复占位面板显示或安全移除。
- 坐标、尺寸和最小尺寸有限，横向范围位于 24 列内，面板互不重叠。
- singleton 和环境能力约束成立。
- 模板实例化生成新的运行时 ID，不与现有 Controller 或订阅冲突。

### Panel Registry

```ts
type AlphaPanelDescriptor = {
  type: string;
  titleKey: string;
  category: "market" | "research" | "backtest" | "trading" | "risk" | "tools";
  singleton: boolean;
  pinnable: boolean;
  defaultSize: { w: number; h: number; minW: number; minH: number };
  createDefaultConfig(): AlphaPanelConfig;
  validateConfig(value: unknown): AlphaPanelConfig;
  load(): Promise<{ default: React.ComponentType<AlphaPanelProps> }>;
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

### 主标的联动与多图同步

首期采用 Shioaji 式工作台主标的与 per-panel pin，界面只需要“跟随”和“固定”两种状态：

```ts
type AlphaSymbolBinding =
  | { mode: "follow" }
  | { mode: "pinned"; vtSymbol: string };
```

- 证券列表、信号或筛选器更新当前工作台主标的。
- K 线、五档、逐笔和下单面板在 follow 状态下响应主标的更新。
- pinned 面板不消费主标的变化，也不自动覆盖主标的。
- pinned 面板恢复 follow 后立即采用当前主标的。
- 发布事件携带来源 panel ID，防止循环回写；联动限定在当前 Workspace 应用进程。

标的联动不隐式开启多图同步。时间范围和十字线属于独立、可分别开关的图表能力，只在对应多图任务中实现：

- 时间范围和十字线只传播轻量运行时事件，不写入布局，不共享图表实例。
- 十字线事件按动画帧限流。
- 首期不为尚未启用的同步能力创建连接、监听器或持久化字段。
- 只有真实工作流需要两套以上独立标的联动时，才提升布局 `schemaVersion` 并增加多联动组；颜色只是一种候选 UI 表达，不是当前协议。

### 状态和持久化

状态至少分为四层：

1. 运行时状态

   Controller、连接、订阅、请求、DOM 和 Canvas，只存在内存中。

2. 面板状态

   标的绑定、周期、复权、图表类型、筛选条件和显示选项，随布局保存。

3. 当前工作台状态

   布局、工作台主标的和布局锁定统一保存在 `~/.terax/shared/terax-alpha.json` 的独立键中，不依附当前 Space。Alpha 当前只在 Local 环境开放，所有窗口共享读取和写入同一份持久化状态。

4. 命名模板和全局偏好

   与当前工作台状态共用 Terax 的 Alpha 白名单共享 store，通过文件锁读取最新值、执行最小键变更并原子替换。不得写入 `~/.terax/alpha/config.json`、Workspace store、`localStorage`，也不得整表覆盖共享状态。

布局拖动期间不写 React 业务状态或持久化存储。只在交互结束后读取和提交最终坐标；连续结束事件使用短暂合并，且必须可取消。

Alpha 页面在临时 Workspace 窗口中按稳定描述重新创建，不改变上述持久化层级，也不建立窗口专用的布局协议。通用辅助窗口中的轻量 Alpha 视图由对应业务类型明确自己的状态来源。

## 公共金融图表和跨页面复用

同一 K 线图能够在数据管理、回测和模拟交易页面复用，前提是把图表分成四层：

```text
FinancialChart
  纯显示和命令输入

FinancialChartFrame
  工具栏、legend、状态和扩展插槽

业务场景组件（Scene）
  行情 / 回测 / 模拟交易的查询和事件连接

普通页面或工作台面板（Panel）
  页面导航、工作台绑定和周边组件
```

典型用法：

- 数据管理页通过 `MarketChartScene` 使用带基础工具栏和状态反馈的 `FinancialChartFrame`，显示选中证券的历史覆盖数据，不创建实时订阅。
- 独立行情页使用完整 `FinancialChartFrame`，支持历史分页、周期、复权、导出和多 pane。
- 回测复盘场景组件向相同图表注入成交标记、持仓区间和回放命令。
- 模拟交易场景组件连接行情快照与增量，并注入虚拟订单、成交和持仓状态。
- 工作台图表面板只负责标的绑定、尺寸和面板控制栏，内部仍复用对应业务场景组件。

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
- 模拟账户和订单状态独立于行情连接状态，不能用行情的 `live` 状态代替交易状态。

## 两个参考项目的定向审查

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
- `PanelChrome` 统一拖动、跟随、固定和删除等高频操作。
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
- 面板级原生弹出窗口。Alpha 页面内部布局不拆成任意浮动面板；确有需要的轻量视图通过通用辅助窗口单独设计。

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

- Launchpad 的 12 列网格、面板配置、布局模板和服务端同步组成了当前参考项目中最完整的通用工作台方案。
- 面板 registry 使用 `React.lazy()`，未打开面板不加载实现。
- 红、蓝、绿、黄联动组可作为未来多套独立标的联动的高级参考，首期不直接采用。
- `IntersectionObserver` 可用于暂停离屏面板的非必要绘制，但不能因此销毁稳定图表实例或错误释放共享订阅。
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

## 专业图表首期范围

首期图表目标是成为工作站所有场景可复用的行情基础：

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

首期不实现新闻、财经日历、社交分享、复杂图形工作区和几十种指标。

## 行情 API 与历史分页

[`alpha/api/routes/bars.py`](../../alpha/api/routes/bars.py) 保留 `start + end` 范围查询，并在没有范围参数时使用有界历史查询。`before` 是排他游标，不能与范围参数混用。

当前已完成的历史读取不变量包括：

- 初次加载最近一批 K 线。
- 以当前最早时间作为 `before` cursor 加载更早数据。
- 存储层执行倒序 `LIMIT`，响应再恢复时间升序。
- 响应提供 `has_more_before` 和实际覆盖范围。
- 前端按时间去重，拒绝非法 OHLC 和非单调时间。
- 跨分片读取在填满 `limit + 1` 条后停止，前复权和后复权跨页保持统一锚点。
- 前端同时接收 `amount` 和可选的 `open_interest`。

历史 prepend 后恢复原 visible logical range 属于公共图表 Controller 和 viewport 的后续工作，不由行情 API 或归一化层持有。

## 性能不变量

### 图表

- 图表实例只在宿主挂载时创建一次。
- 标的或周期初始快照使用 `setData()`。
- 实时当前 bar 使用 `update()`，不为每个 tick 重建 React bars 数组。
- 同一时间戳替换当前 bar，更晚时间戳追加，迟到数据执行明确策略。
- 十字线和实时 tick 最多每动画帧更新一次 React 展示状态。
- `fitContent()` 只用于首次加载、标的切换或用户主动命令。
- 新 bar 到达不得重置用户缩放和滚动位置。
- 历史回填不得改变用户正在观察的屏幕内容。
- 主题切换只应用 options，不重建 chart。
- 未启用指标或绘图时不加载代码、不创建 pane、不计算数据。

### 工作台

- 面板网格固定使用 24 列逻辑坐标，禁止重叠，碰撞时自动重排并纵向紧凑排列。
- 窄窗口通过横向滚动保留逻辑布局，不因容器宽度变化改写持久化坐标。
- 布局默认可编辑；工作台级布局锁定只影响移动和缩放，不影响标的跟随或固定。
- 面板 ID 在移动、缩放和模板内保持稳定。
- 拖动和缩放过程不更新业务 React 状态，不写 store。
- 面板网格不直接拥有行情查询或订阅。
- 同一数据键的查询、实时连接和计算结果尽量复用。
- 面板离屏或页面隐藏时暂停 resize、轮询和非必要绘制，恢复后只同步最终尺寸；可见性优化不得销毁 Controller 或绕过共享订阅引用计数。
- 面板库的预览默认使用静态缩略图，只允许白名单面板按需挂载一个真实预览。
- Alpha 工作台未打开时，不加载网格、绘图、指标或模拟交易模块。
- 标的联动首期只使用工作台主标的与 follow/pinned，不加载多联动组基础设施。
- 多图十字线和时间范围同步只在用户分别启用时传播轻量运行时事件，不共享图表实例。

## 模拟交易不变量

- 模拟环境必须持续可见，所有账户、订单、成交和持仓使用独立的虚拟领域模型。
- 下单、改单、撤单和平仓必须经过 Alpha 服务端参数校验和模拟风控。
- 每个交易命令具有幂等键，UI 超时或重连不能重复提交同一操作。
- UI 不以乐观状态替代 Alpha 权威订单状态，失败和未知状态必须可见。
- 行情、模拟账户和订单处理分别展示 freshness，不能用一个连接状态概括全部状态。
- 服务重启或连接恢复后先获取账户、持仓、订单和必要行情快照，再应用增量。
- 撮合规则、手续费、滑点和成交价格必须显式配置并可复现。
- 布局和面板配置不能绕过模拟风控、修改账户权威状态或伪造成交。

## 测试与验收路由

### 工作台纯函数和模型测试

- schema 校验、迁移和未知 panel fallback。
- panel/grid 一一对应、重复 ID、单例、24 列尺寸范围和禁止重叠。
- 碰撞自动重排、纵向紧凑排列和窄窗口不改写持久化坐标。
- 模板实例化生成稳定且不冲突的新 ID。
- 增加、删除、复制和切换布局不污染原模板。
- 主标的更新、follow、pin、恢复跟随和来源去重。
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
- 面板移动、缩放、自动重排和临时隐藏不重建 Controller。
- 最后一个消费者离开后才解除共享订阅。

### React 测试

- 普通页面和工作台面板复用同一个业务场景组件和公共图表，不复制业务实现。
- 面板 registry 懒加载、错误边界和 capability fallback。
- 工具栏命令、布局锁定、标的跟随/固定和面板控制栏。
- loading、empty、error、delayed、stale、reconnecting 和 disconnected 状态。
- OHLC 信息栏在十字线离开时恢复最新 bar。
- 可访问性文本和所有用户可见文案国际化。

### 模拟交易协议测试

- 命令幂等、拒单、超时、未知结果和服务恢复。
- 账户、订单、持仓和行情快照与增量的顺序。
- 撮合、手续费、滑点和成交结果在固定输入下可复现。
- 风险限额和虚拟账户状态不可被布局配置绕过。

### 运行时验证

实现涉及真实网格拖动、pane 调整、可见范围、命中区域、WebView Canvas、ResizeObserver 或 Pointer Events 时，按 [`ui-runtime-debugging.md`](../contributing/ui-runtime-debugging.md) 使用相同复现条件验证修改前后行为。依赖 Alpha IPC 或 WebSocket 的场景使用真实 Tauri 运行时；只有明确接入通用辅助窗口或 Workspace 工作页交接时才验证原生多窗口。

## 分阶段实施顺序

### 阶段一：公共图表和工作台内核

- 拆分 `FinancialChartController`、公共组件、专业外壳和业务场景组件。
- 完成历史分页、viewport、状态、主题和导出。
- 先完成布局 schema、registry、PanelPool 和局部加载失败状态，不为验证基础设施注册虚构业务面板。
- 接入面板控制栏并隔离验证 24 列 Alpha 内部网格，确认禁止重叠、碰撞重排、横向滚动、拖动结束持久化、隐藏恢复和 WebView 行为。
- 完成面板库、布局模板、默认可编辑与布局锁定、工作台主标的和 follow/pinned。
- 数据管理页、独立行情页和工作台图表面板复用同一个业务场景组件和公共图表。

### 阶段二：数据管理闭环和领域协议

- 保持已经完成的 engine-neutral 行情模型、统一归一化、数据目录和倒序历史分页不变量。
- 完成同步任务、质量检查、覆盖缺口和失败恢复闭环，并接入数据页或工作台的数据质量面板。
- 明确策略、回测、模拟账户和事件的 Alpha 权威模型及 API 边界。

### 阶段三：策略、回测和复盘

- 完成策略版本、参数、回测任务、状态、结果和错误协议。
- 接入回测交易标记、持仓区间、统计面板和回放控制。
- 完成回测结果比较和参数优化视图。
- 参考 OpenTerminalUI 的 replay、sync、workspace 和性能测试。

### 阶段四：实时行情和模拟交易

- 建立 MarketDataHub、HTTP 快照、WebSocket 增量和订阅引用计数。
- 完成五档、逐笔、信号、账户、持仓、订单和事件面板。
- 完成虚拟账户、撮合、订单生命周期、持仓、费用、滑点和模拟风控。
- 验证服务恢复、命令幂等、风险拒绝和未知状态。

实盘交易、复杂绘图工具集、浏览器指标计算和可视化策略编排不在当前实施阶段内。只有前四个阶段形成稳定闭环后，才为这些能力单独补充架构、依赖和验收设计。

## 外部源码检索和重新审查规则

每项新的 Alpha 功能、架构或重要交互都应先在两个项目中执行定向检索。以下情况还需要重新阅读对应的关键实现，不需要例行重读全部仓库：

- Alpha 要实现或修改 24 列自由面板工作台、主标的跟随或固定交互时，复核 Shioaji Workspace，并以 OpenTerminalUI Launchpad 补充 registry、模板和测试场景。
- 只有 Alpha 确认需要多套独立标的联动或模板服务端同步时，才复核 OpenTerminalUI 对应 Context、Store 和测试。
- Lightweight Charts 升级主版本或 pane、primitive、marker API 发生变化。
- Terax 要实现实时 tick 聚合时，复核 Shioaji 和 OpenTerminalUI 的实时更新、聚合与边界测试。
- Terax 要实现回放、多图或十字线同步时，复核 OpenTerminalUI 对应模块和测试。
- Terax 要实现模拟账户、撮合或订单生命周期时，复核 OpenTerminalUI 的 paper trading 服务、页面和测试。
- Terax 要实现指标 pane 或基础绘图时，只复核 OpenTerminalUI 与 Shioaji 已列出的图表模块。
- 本文列出的关键文件在本地参考仓库中已被删除、拆分或 API 发生实质变化。

窗口基础设施是独立公共能力，不触发 Alpha 重新审查参考项目。轻量视图接入遵循 [通用辅助窗口](./auxiliary-windows.md)，完整 Alpha 页面接入遵循 [Workspace 工作页跨窗口交接](./workspace-page-handoff.md)。若只是上游新增无关页面、绘图工具或指标数量，不需要更新本文。
