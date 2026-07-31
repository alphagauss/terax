# `alpha` 代码地图

这份文档是 `alpha/` 项目的源码索引。`alpha` 是通过 FastAPI 接入 Terax 的独立量化业务模块，负责量化 API、领域能力和任务运行时。Terax 负责桌面界面、工作区和 AI Agent，详细边界见 [`docs/architecture/alpha-integration.md`](../../docs/architecture/alpha-integration.md)。

使用原则：
- 先按目录定位，再看对应文件。
- 改动 API、CLI、回测、策略、存储、同步任务或测试时先看这里。
- `alpha/live/runner.py` 和 `alpha/paper/runner.py` 目前只是运行入口占位文件。
- 各子包里的 `__init__.py` 大多只承担命名空间或轻量导出，不再逐个展开。

## 应用入口

- `alpha/__main__.py`: `python -m alpha` 模块入口；解析监听地址、端口、日志级别和开发调试用的 `-t/--token`，并把前台服务启动交给 `alpha.server`。未显式传入凭据时继续读取 `TERAX_ALPHA_TOKEN`。
- `alpha/runtime_check.py`: Python 3.11 最低版本及运行依赖自检入口；读取 `requirements-runtime.txt`，通过稳定 JSON 向 Rust 报告缺失或损坏依赖。
- `alpha/server.py`: 单 Uvicorn 协调进程运行器；创建 FastAPI 应用并以前台模式运行，把应用内关闭回调绑定到当前 Server，不管理 daemon、PID 或日志文件。
- `alpha/live/runner.py`、`alpha/paper/runner.py`: 实盘和模拟盘运行入口占位文件，当前只保留模块边界和导出。

备注：Alpha 的正式调用边界是 `/api/alpha`。离线数据库维护继续使用 `alpha/scripts/` 中的显式脚本，不再维护绕过 FastAPI 的业务 CLI。

## API 层

- `alpha/api/app.py`: 独立 FastAPI 应用工厂；从运行环境读取服务凭据，管理 `AlphaServiceContainer` 生命周期，并把业务路由挂载到 `/api/alpha`。
- `alpha/api/auth.py`: HTTP Bearer 服务凭据验证；负责保护 Alpha 业务路由，不承接领域权限判断。
- `alpha/api/routes/events.py`: 受认证的双向 JSON WebSocket 端点；当前只提供 ping/pong 基础协议，后续在 FastAPI 内增加公共事件的显式按需订阅，不直接暴露内部事件总线。
- `alpha/api/router.py`: Alpha API 总路由；聚合 `health`、`system`、`status`、`data`、`securities`、`bars`、`strategies`、`backtests`、`tasks`、`sync` 十组路由。自身不带前缀，由独立 FastAPI 应用统一挂载到 `/api/alpha`。
- `alpha/api/container.py`: `AlphaServiceContainer` 持有数据库、懒加载策略管理器、事件引擎和进程任务管理器；`create_alpha_service_container()` 延迟创建核心对象，供 FastAPI 应用组装；容器只负责运行对象组装与关闭，不承接具体 API 响应编排。`_LazyStrategyManager` 额外暴露回测结果概要与单结果读取，供工作台结果页复用现有 `StrategyResult`。
- `alpha/api/deps.py`: FastAPI 依赖注入入口；只负责从 `app.state.alpha_services` 读取 `AlphaServiceContainer`。
- `alpha/api/models.py`: Alpha 业务 API 响应模型，包括带服务协议和归档哈希的 `HealthResponse`、`ShutdownResponse`、带 `bars/security_profile/index_constituents` 聚合字段的 `DataOverviewResponse`、`StrategyInfo`、以及包含 `backtest_id/status` 的 `BacktestStartResponse`。
- `alpha/api/events.py`: `EventWebSocket` 协议和带单客户端发送超时的 `EventBroadcaster`；当前 WebSocket 路由不连接该工具，后续只用于显式订阅的公共事件。
- `alpha/api/routes/_utils.py`: Alpha 工作台路由辅助函数；集中处理分页上限、日期解析、周期/复权/产品归一、任务状态映射以及轻量字段提取，避免各 route 重复拼装。
- `alpha/api/routes/health.py`: `GET /health`，返回 Alpha 服务身份、协议版本和当前源码归档哈希，供 Terax 识别共享服务。
- `alpha/api/routes/system.py`: `POST /system/shutdown`，在 Bearer 鉴权后请求当前 Uvicorn Server 正常退出，供任意 Terax 窗口停止共享服务。
- `alpha/api/routes/status.py`: `GET /status`，返回 Alpha 是否启用、数据库是否就绪、数据目录、最新交易日、证券数量与运行中任务数；数据库异常会转换为 `database_ready=false` 的轻量状态响应。
- `alpha/api/routes/data.py`: `GET /data/overview`，读取容器中的数据库并在路由层汇总行情数据概览；除保留旧的 `total_bar_count/bar_overview` 外，还新增按周期聚合的 `bars` 结构。
- `alpha/api/routes/securities.py`: `GET /securities`、`GET /securities/{vt_symbol}`，复用 `DataBase.load_security_profiles()`、状态游标和股本变更接口，向前端返回证券搜索摘要、覆盖范围和受限详情。
- `alpha/api/routes/bars.py`: `GET /bars`，把工作台的周期/复权参数归一为现有 `BarDataQuery`，调用数据库门面返回带数量上限保护的图表友好 K 线结构。
- `alpha/api/routes/strategies.py`: `GET /strategies`、`GET /strategies/{strategy_id}`、`POST /strategies/reload`，读取容器中的策略管理器并在路由层过滤加载错误条目、兼容 loader 里的 `paramaters` 字段，并输出前端可直接消费的策略参数列表。
- `alpha/api/routes/backtests.py`: `GET /backtests`、`POST /backtests` 以及 `/backtests/{id}` 下的 `summary/equity/drawdown/daily-returns/trades/config/logs/replay` 分片接口；创建时会把 Web 表单请求转换为现有 `BacktestReq`，结果读取优先复用 `StrategyResult` 已保存 JSON。
- `alpha/api/routes/tasks.py`: `GET /tasks/{task_id}`、`GET /tasks/{task_id}/logs`、`POST /tasks/{task_id}/cancel`，统一从 `StrategyManager.get_status_dict()` 读取任务快照，并在支持时调用 `ProcessTaskManager.stop()` 取消进程任务。
- `alpha/api/routes/sync.py`: `GET /sync/tasks`，读取容器中的进程任务管理器并在路由层过滤同步任务快照。

依赖方向固定为：

```text
alpha.api
  -> alpha core
```

## 共享基础

- `alpha/common/enums.py`: 枚举定义，覆盖 `Interval`、`Exchange`、`Direction`、`Offset`、`Status`、`Product`、`OrderType`、`OptionType` 等；`ACTIVE_STATUSES` 定义活跃委托集合。
- `alpha/config.py`: Alpha 配置模型、`~/.terax/alpha/config.json` 原子读写和固定本机状态目录入口；可同步业务数据由配置中的 `data_dir` 指向。
- `alpha/common/schema_core.py`: 事件常量（`EVENT_TIMER`、`EVENT_TICK` 等）、`STOPORDER_PREFIX`、`INTERVAL_DELTA_MAP`，以及 `vt_symbol` 和时间戳转换工具。
- `alpha/common/schema_backtest.py`: 回测请求和结果辅助模型，如 `BacktestReq`、`HoldData`、`AccountData`。
- `alpha/common/schema_market.py`: 市场数据 payload/query 模型，如 `BarDataPayload`、`SecurityProfilePayload`、`SecurityDailyInfoRecord`、`BarOverview`、`TickData`。
- `alpha/common/schema_trade.py`: 交易/委托/报价/合约模型，如 `OrderData`、`TradeData`、`QuoteData`、`OrderRequest`、`QuoteRequest`、`ContractData`。
- `alpha/common/schema.py`: 兼容旧导入路径的聚合导出。
- `alpha/utils/__init__.py`: 通用工具与回测结果读写；包含 `SingletonMeta`、`virtual()`、`round_to()`、`floor_to()`、`ceil_to()`、`get_digits()`、`suppress_execution_time_logging()`、`log_execution_time()`、`get_contract_setting()`、`save_contract_setting()`、`StrategyResult`。
- `alpha/utils/helpers.py`: `ensure_dir()`、`timestamp()`、`current_time_str()`。

## 运行时

- `alpha/runtime/event.py`: `Event` 消息模型和 `EventEngine`；核心方法是 `start()`、`stop()`、`put()`、`sub()`、`unsub()`、`sub_general()`、`unsub_general()`，内部负责事件队列、定时事件和异步 handler 调度。
- `alpha/runtime/processes.py`: 子进程任务编排；`TaskStatus`、`ProcessTask`、`ProcessMessagePublisher`、`ProcessTaskManager` 负责启动、等待、停止、刷新和清理任务。

## 市场接入

- `alpha/market/eastmoney_crawler.py`: 东方财富 HTTP 抓取层，包含固定请求头、限流重试、风控识别、JSON 解码、代码映射和实时/历史数据读取；不管理浏览器会话或 Cookie。核心类是 `EastmoneyMarket`，异常类是 `EastmoneyAntiBotError`。
- `alpha/market/eastmoney_gm.py`: GM 接口适配层，封装当前/历史行情、交易日、交易时段、合约到期、指数成分和基本面查询等函数；`GMTimeoutError` 用于超时错误。

## 存储层

- `alpha/storage/base.py`: `SQLiteStorageBase` 提供分片 SQLite 的打开、读写、主表/分片表处理、大小检查和 sidecar 清理。
- `alpha/storage/database.py`: `DataBase` 是存储门面，聚合 bar、adjust factor、security profile、daily info、status meta、index constituent 和 share capital 的保存/加载接口。
- `alpha/storage/csvdb.py`: CSV 读写与交易日/股票基础信息工具。
- `alpha/storage/transforms.py`: 复权因子和股本变化转换函数，负责从历史数据构造 sparse row 和 meta row。
- `alpha/storage/repositories/market_data.py`: `MarketDataRepository` 处理 bar 数据、复权因子、概览表和分片聚合。
- `alpha/storage/repositories/security.py`: `SecurityRepository` 处理证券档案、日度状态、停复牌和 ST 事件。
- `alpha/storage/repositories/equity.py`: `EquityRepository` 处理股本变更、元数据和时间区间归一。
- `alpha/storage/repositories/index_constituent.py`: `IndexConstituentRepository` 维护指数成分股的时间线区间与元数据。
- `alpha/storage/repositories/sqlite_rows.py`: SQLite 行对象读写辅助。

## 策略层

- `alpha/strategy/models.py`: 策略运行时数据模型，如证券档案、日状态和 snapshot。
- `alpha/strategy/loader.py`: `StrategyLoader` 从默认目录或指定目录加载策略类。
- `alpha/strategy/engine.py`: `StrategyEngine` 向策略暴露交易、持仓、状态和日志等运行时接口。
- `alpha/strategy/manager.py`: `StrategyManager` 是策略生命周期总控，负责装载类、构建任务、启动回测/实盘/模拟盘/优化、持久化结果和查询结果；`LocalStrategyTask` 表示本地任务快照。

## 回测层

- `alpha/backtest/array.py`: `ArrayManager` 管理 OHLCV、成交额和持仓量窗口，并暴露最近值访问接口。
- `alpha/backtest/analysis.py`: `Analysis` 计算回测统计指标与日度指标，向 Web 端返回绘图所需数据；包含 `calculate_dalily()`、`calculate_statistics()`。
- `alpha/backtest/backtesting.py`: `BackTesting` 是回测主引擎，负责参数设置、数据加载、K 线推进、撮合、持仓/账户更新、结果统计和日志输出。
- `alpha/backtest/data.py`: `BacktestDataScope` 和 `BacktestInput` 是回测输入/范围模型；其余函数负责 trade date、history data、profile/state/universe/contract 的构建与转换。
- `alpha/backtest/indicator.py`: 指标封装层，提供 `compare_speed()` 和大量 TALib 风格方法。
- `alpha/backtest/optimize.py`: 优化设置和网格/遗传算法优化入口；`OptimizationSetting`、`check_optimization_setting()`、`run_bf_optimization()`、`run_ga_optimization()`、`ga_evaluate()`。
- `alpha/backtest/portfolio.py`: `PortfolioManager` 处理持仓、账户和日度结果。
- `alpha/backtest/runner.py`: 回测/优化任务执行层；`BacktestJobSpec`、`run_backtest_job()`、`run_backtest_task()`、`run_optimization_job()`、`run_optimization_task()` 等负责业务任务执行。
- `alpha/backtest/template.py`: `StrategyTemplate` 是策略基类，承载生命周期回调、下单/撤单、持仓查询和与回测引擎的桥接。

## 同步任务

- `alpha/sync_tasks/base.py`: `BaseSyncProvider` 定义历史行情、symbol、index constituent、trading date、symbol info 的抓取接口。
- `alpha/sync_tasks/__init__.py`: 同步任务命名空间；不再做重导出，避免导入包时提前拉起 pandas/provider 依赖。
- `alpha/sync_tasks/calendar.py`: 交易日对齐、向前/向后平移和区间计数工具。
- `alpha/sync_tasks/constants.py`: 同步任务常量命名空间。
- `alpha/sync_tasks/gm_async.py`: `GmAsyncProvider` 以异步和数据帧方式封装 GM 数据抓取。
- `alpha/sync_tasks/models.py`: 同步计划和结果模型，如 `SecurityInfo`、`SecuritySyncPlan`、`IndexConstituentSyncPlan`、`BarSyncPlan`、`ValidationIssue`、`YearPlan`、`BatchResult`，以及 `StageProfiler`。
- `alpha/sync_tasks/normalizers.py`: 可选浮点/整数/bool 归一化和指数成分 `vt_symbol` 归一化。
- `alpha/sync_tasks/planners.py`: 全量/增量计划构造与分块函数。
- `alpha/sync_tasks/reporting.py`: 阶段耗时格式化与更新报告写入。
- `alpha/sync_tasks/universe.py`: GM symbol/exchange 到 `vt_symbol` 的映射，以及 trade date 和 symbol universe CSV 加载。
- `alpha/sync_tasks/validators.py`: 重叠行分组、已有区间读取和重叠校验。
- `alpha/sync_tasks/writers.py`: 运行缓冲区 flush 和数据库持久化辅助。
- `alpha/sync_tasks/tasks/security_sync.py`: `SecuritySyncTask` 负责证券全量/增量同步、symbol infos CSV 刷新和 symbols snapshot CSV 刷新。
- `alpha/sync_tasks/tasks/index_constituent_sync.py`: `IndexConstituentSyncTask` 负责指数成分抓取、探测缓存、缓存序列化/反序列化与逐个指数同步。
- `alpha/sync_tasks/tasks/bar_sync.py`: `BarSyncTask` 负责增量 bar 同步。

## 工具脚本

- `alpha/scripts/vacuum_sqlite_dbs.py`: SQLite 分片库 VACUUM 维护工具；`iter_sqlite_db_paths()` 选择待处理 `.db` 文件，`vacuum_database()` 执行单库 VACUUM 并返回 `VacuumStats`，`print_stats()` 打印中文摘要。

## 测试索引

- `alpha/tests/test_app.py`: 验证独立 FastAPI 应用的路由挂载、Bearer 鉴权及容器关闭。
- `alpha/tests/test_main.py`: 验证 `python -m alpha` 参数默认值和服务运行器转发。
- `alpha/tests/test_server.py`: 验证 Uvicorn 保持单进程前台启动。
- `alpha/tests/test_runtime_check.py`: 验证 Python 最低版本、WebSocket 运行依赖、缺失依赖和损坏依赖的结构化检查结果。
- `alpha/tests/test_router.py`: 验证 Alpha 最小业务 API 在路由层完成响应编排并调用容器中的核心对象。
- `alpha/tests/test_api_container.py`: 验证 API 容器初始化、懒加载策略管理器和关闭运行对象。
- `alpha/tests/unit_tests/test_api_events.py`: 事件广播工具的 JSON 编码、失败连接清理和慢客户端超时测试。
- `alpha/tests/unit_tests/conftest.py`: 单元测试共用 fixtures、假数据库和假 provider。
- `alpha/tests/integration_tests/test_eastmoney.py`: 东方财富实时分页和空页行为。
- `alpha/tests/integration_tests/test_exec_es_gm_live.py`: GM live smoke 与证券同步 smoke。
- `alpha/tests/manual/backtest.py`: 手工回测脚本。
- `alpha/tests/manual/check_database.py`: 数据库检查脚本。
- `alpha/tests/manual/sma_strategy.py`: `DoubleMaStrategy` 策略示例。
- `alpha/tests/unit_tests/test_adjustment.py`、`test_sync_tasks_foundation.py`: 复权、基础映射和 vt_symbol 转换。
- `alpha/tests/unit_tests/test_sync_tasks_normalizers.py`、`test_sync_tasks_planners.py`、`test_sync_tasks_io.py`、`test_sync_tasks_tasks.py`: 归一化、计划、IO 和任务级同步逻辑。
- `alpha/tests/unit_tests/test_analysis.py`、`test_backtest.py`、`test_backtesting_regression.py`、`test_indicator.py`、`test_strategy_manager.py`: 回测、指标、策略管理和回归测试。
- `alpha/tests/unit_tests/test_database.py`、`test_index_constituents.py`、`test_eastmoney_crawler_fetch.py`、`test_vacuum_sqlite_dbs.py`: 存储、指数成分、东方财富抓取和 SQLite 维护。
- `alpha/tests/unit_tests/test_runtime_event.py`、`test_runtime_processes.py`、`test_utils.py`、`test_schema_split.py`: 运行时事件/进程、工具函数和 schema 兼容性。
