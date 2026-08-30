# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项跨层任务，不重复长期架构和具体实现设计。Rust 与前端细节记录在 `docs/architecture/`，Python 实现基线记录在 [`alpha/docs/`](../../alpha/docs/README.md)。完成任务时同步更新对应长期文档；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：统一量化事件运行时。已完成。
- 当前任务：EventEngine、TaskManager、MarketFeed 和公共 EventClient 破坏式收敛。已完成。
- 下一任务：阶段三回测复盘或阶段四模拟交易需要另行确定范围；详细 `backtest.frame` 回放只保留扩展点。
- 已暂缓：独立 `alpha-market` 行情页，待确有页面需求时作为复用现有 Scene 的薄页面重新安排。
- 阻塞：无。

## 当前任务

Alpha 已从独立实时行情状态机收敛为统一事件运行时。EventEngine 是唯一进程内 callback 总线；TaskManager 是唯一有限任务管理器；MarketFeed 只拥有 Provider 租约；WebSocketEventGateway 和前端 EventClient 把公共 selector 转换为普通 callback。

- 回测、优化和数据同步发布同一种完整 `task.updated` 快照。TaskMessagePublisher 支持逐 bar 或逐批次调用，并把普通跨进程进度限制到最多每 200ms 一次。
- 回测引擎提供传输无关的逐时间切片 `on_progress` hook；详细 K 线、权益和成交回放未来使用独立 `backtest.frame`，不扩张任务协议。
- Python MarketFeed 不保存历史尾部或 sequence，不参与 `/bars` 和指标查询。它按完整行情键共享上游任务并发布 `market.bar`、`market.status`。
- 前端 EventClient 复用单条 Rust 代理连接，按 `event + key` 引用计数并在重连后重放 selector；任务页和数据同步页直接消费任务事件，HTTP 继续承担恢复和最终结果。

完成标准：EventEngine 不拥有领域资源；有限任务只有一个 TaskManager；相同 selector 只有一个远程订阅；任务结果提交先于成功事件；未订阅行情时不创建 Provider 客户端。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

### 实施边界

1. EventEngine 只接受同步 callback，按事件类型和可选业务键顺序分发；异步、跨进程和 WebSocket 都由适配器处理。
2. TaskManager 管理回测、优化和同步的 spawn 子进程，统一验证进度、维护 revision，并在父进程 result handler 提交结果后发布终态。
3. `/events` 协议版本 1 使用 `op + event + key` selector，单连接最多 64 个 selector 和 64 条待发消息；慢客户端关闭后通过 HTTP 恢复。
4. MarketFeed 默认 Provider 惰性创建，不导入 pandas；服务最多 128 个活跃行情键，每键只保存一个最新值用于重复抑制。
5. Rust 通用代理仍只负责路径、凭据、消息上限和 closed/error 传输。前端 EventClient 负责重连和 selector 重放，MarketDataFeed 负责行情协议适配。

### 验证标准

- Python 测试锁定 EventEngine 顺序和业务键、TaskManager 状态先行与结果提交、逐 bar 进度、MarketFeed 最后租约释放、WebSocket 白名单和鉴权。
- 前端测试锁定 EventClient 单连接、selector 引用计数、revision 去重、重连重放，以及图表按时间更新。
- 完整 Python、前端类型、lint 和测试必须通过；本任务不依赖真实 WebView 计算状态，不额外启动运行时调试。

### 执行结果

- 删除 RealtimeMarketDataService、MarketDataHub、live sequence、服务端实时尾部、reset/resync 协议和 inline/thread 回测分支，不保留兼容入口。
- Alpha 健康协议提升到 3，Rust 生命周期管理器会替换仍提供旧事件协议的 Python 服务。
- TaskManager 统一发布完整 TaskSnapshot。同步以 batch 报告真实计数，回测内核逐 bar 报告时间、计数和成交数，普通传输在 Publisher 内节流。
- StrategyManager 通过 TaskManager result handler 保存回测结果，移除每任务 watcher thread，成功事件不会早于结果落盘。
- `/bars` 和指标接口恢复为纯数据库查询；图表 Controller 继续按时间幂等合并 HTTP 历史和实时事件。
- Python 全量测试通过 232 项，2 项外部集成测试跳过；前端全量测试通过 1225 项。类型检查通过，完整 lint 通过且只报告仓库既有提示。
- Rust `cargo clippy --all-targets --locked -- -D warnings` 通过，`cargo test --locked alpha` 通过 19 项相关过滤测试；`cargo fmt --check` 只被本次未修改的 `remote/sftp.rs` 既有格式差异阻断。

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
