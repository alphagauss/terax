# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项跨层任务，不重复长期架构和具体实现设计。Rust 与前端细节记录在 `docs/architecture/`，Python 实现基线记录在 [`alpha/docs/`](../../alpha/docs/README.md)。完成任务时同步更新对应长期文档；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：公共金融图表三批八项任务。已完成。
- 当前任务：任务 8，实时行情尾部与“回到最新”。已完成。
- 下一任务：未安排。阶段三回测复盘、阶段四模拟交易或暂缓的独立行情页需要另行确定范围。
- 已暂缓：独立 `alpha-market` 行情页，待确有页面需求时作为复用现有 Scene 的薄页面重新安排。
- 阻塞：无。

## 当前任务

任务 8 已在真实 Alpha 协议上建立共享实时 K 线闭环：Alpha 按完整数据键提供有界订阅、sequence、上游状态和内存尾部；前端单 WebView 内复用一条 Rust 通用 WebSocket 代理连接，以 HTTP `/bars` 为权威恢复快照，并直接更新现有图表 Controller。

- 实时功能只属于工作台 Chart Panel 的显式开关。数据页不显示入口，也不动态加载 Hub 或建立订阅。
- 服务端当前读取最近两根完整 K 线，固定发布累计 volume 与 amount；协议和前端纯合并仍能明确处理 `incremental`，但不为不存在的 tick 源增加浏览器聚合。
- 首次订阅、sequence gap、服务端 reset、慢消费者重校准和断线重连都重新请求 `/bars`，以前端收到的 `liveSequence` 衔接缓冲增量。
- 同 bucket 直接 `update()`；新 bucket 追加并确认上一根 final。用户离开右侧尾部后不再自动滚回，点击“回到最新”只执行受控实时滚动。

完成标准：同一数据键多消费者只产生一个前端订阅和一个 Python 上游任务；恢复没有重复或 sequence 缺口；旧数据键不能写入当前图表；未启用实时功能没有请求、连接、rAF 或 eager bundle 成本。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

### 实施边界

1. Python `alpha/realtime/` 独立于交易 `live/` 占位模块和内部 `EventEngine`。默认行情源惰性创建轻量 HTTP 连接池，不导入 pandas；服务按数据键引用计数，单连接最多 32 键、服务最多 128 键，每键内存尾部最多 512 根。
2. `/events` 协议版本 1 只接受严格 `subscribe`、`unsubscribe` 和既有 ping。`bar` 带单调 sequence、final 语义和 volume mode；状态消息不参与 sequence。
3. `/bars` 最新页原子返回实时 sequence 并拼接内存尾部，排他历史页不拼接。指标计算在同键活跃时读取相同尾部，前端仍不上传原始 bars。
4. Rust 通用代理路径、凭据注入、消息上限和 closed/error 事件已经满足需求，不增加 Alpha 领域结构或自动重连逻辑。
5. 前端 Hub 通过动态 import 接入，复用单条连接和数据键订阅；Controller 保持图表实例稳定，实时模块不进入默认 eager graph。

### 验证标准

- Python 单元和路由测试锁定数据键参数、引用计数、sequence、重复抑制、追加、修订 reset、快照尾部与 WebSocket 鉴权和消息校验。
- 前端纯函数和 Hub 测试锁定累计与增量 volume、单连接复用、最后引用释放、重复、gap、重连与快照衔接。
- Controller 和 React 测试锁定同 bucket 更新、新 bucket 追加、旧键拒绝、离开尾部、回到最新、显式开关、状态国际化和数据页零订阅。
- 完整前端检查、Python 相关测试、真实上游读取和真实 Tauri WebView 使用相同数据键验证；运行时调试产生的共享配置和临时目录必须恢复。

### 执行结果

- Alpha 服务按完整 `vtSymbol + interval + adjust` 共享活跃上游任务。sequence 与最多 512 根尾部在同一锁下读取，稳定历史修订发布 reset；连续读取失败依次降级为 delayed 和 disconnected。默认源在首个订阅前不创建 HTTP 客户端。
- `/bars` 最新快照返回 `live_sequence` 并按时间替换或追加实时尾部；日线和周线参考价随合并后的最新 bar 校准。指标 API 在活动键上合并相同尾部，新 bar 完成后的刷新仍共用服务端计算规则。
- WebView `MarketDataHub` 复用一条 Rust 代理连接，同键引用计数、快照请求单飞、sequence 去重、gap 和重连恢复集中处理；bar 在 rAF 中有界派发，连接和 freshness 状态保持独立。
- Controller 直接更新主价格与成交量 series。同 bucket 不复制完整历史数组；新 bucket 才追加一次并在仍跟随时滚到实时位置。历史平移、HTTP 重校准、主题、配置和服务恢复不重建 chart。
- 工作台 Chart Panel 配置保存实时开关，默认关闭。Frame 的紧凑菜单、状态点和“回到最新”均已国际化；数据页没有入口，关闭或隐藏页面会释放消费者。
- Python 自动化执行 238 个 pytest 用例，2 个既有外部集成用例跳过；当前量化环境缺少已声明的 `pytest-asyncio`，唯一异步容器测试改用 `asyncio.run` 单独执行并通过。真实东方财富源读取到 `000001.SZSE` 最近两根前复权日线。
- 完整前端检查通过。真实 Tauri WebView 中两张 `000001.SZSE|d|forward` 图表同时达到 live，两个独立 binding 共享同一个 Hub、一个数据键 record 和一个 socket；record 为 sequence 1、binding 计数 2。后来订阅的第二张图按顺序重放快照后的 delta，与第一张图都显示 2026-08-28 尾部。
- 服务重启期间状态从 live 进入 reconnecting 并恢复 live，两张图的宿主和主 Canvas 身份保持。真实 pointer 拖离尾部后“回到最新”出现，点击后消失且 Canvas 不变；逐个停用实时后 binding 从 2 降到 1 再到 0，最后一个消费者释放后 record 清空、socket 关闭。最终无面板错误或新 console error。
- 调试使用的共享 Alpha 配置和 Terax 设置按 SHA-256 逐字节恢复；三个 debug Tauri 会话只按记录 PID 停止，release Terax 进程未触碰。端口 1420、9224、11123 已释放，临时 WebView 与备份目录已删除。

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
- [x] 完成多图时间范围与十字线同步。
- [x] 完成最多 3 个对比标的的相对收益叠加。
- [x] 完成实时行情快照、增量、恢复状态和“回到最新”。
- [ ] 在确有页面需求时重新安排独立行情页。

### 后续阶段

- [ ] 阶段二：数据同步、质量检查、失败恢复和领域 API 边界。
  - [x] 完成 A 股日线同步的最小质量与定向重试闭环。
- [ ] 阶段三：策略、回测和复盘。
- [ ] 阶段四：实时行情和模拟交易。
  - [x] 完成共享实时 K 线尾部与图表恢复闭环。
