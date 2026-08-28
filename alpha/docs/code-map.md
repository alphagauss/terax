# `alpha` 代码地图

本文用于快速定位 `alpha/` 源码。按任务找到入口后，应以源码、测试和 API 模型为准。后端依赖方向见 [后端架构](./architecture.md)，公共协议见 [API 协议](./api-contracts.md)，存储不变量见 [行情数据与存储](./market-data.md)。Alpha 与 Terax、Rust 代理及 `alpha-native` 的职责边界见 [Alpha 集成架构](../../docs/architecture/alpha-integration.md)。

## 按任务定位

| 要做什么 | 首要入口 | 通常还要看 |
| --- | --- | --- |
| 修改服务启动、检查或关闭 | `alpha/__main__.py`、`alpha/server.py`、`alpha/runtime_check.py` | `alpha/api/app.py`、`alpha/api/routes/system.py` |
| 新增或修改业务 API | `alpha/api/routes/` | `alpha/api/router.py`、`alpha/api/models.py`、`alpha/api/container.py` |
| 修改 Alpha 配置 | `alpha/config.py` | `alpha/api/routes/settings.py` |
| 修改证券目录或行情查询 | `alpha/storage/database.py` | `alpha/storage/repositories/`、`alpha/api/routes/securities.py`、`alpha/api/routes/bars.py` |
| 修改外部行情接入 | `alpha/market/` | `alpha/sync_tasks/base.py`、`alpha/sync_tasks/gm_async.py` |
| 修改公共实时 K 线 | `alpha/realtime/` | `alpha/api/routes/events.py`、`alpha/api/routes/bars.py`、实时单元测试 |
| 修改数据同步 | `alpha/sync_tasks/tasks/` | `alpha/sync_tasks/planners.py`、`alpha/sync_tasks/writers.py`、`alpha/sync_tasks/validators.py` |
| 修改策略加载或生命周期 | `alpha/strategy/manager.py` | `alpha/strategy/loader.py`、`alpha/strategy/engine.py`、`alpha/strategy/models.py` |
| 修改回测或优化 | `alpha/backtest/backtesting.py` | `alpha/backtest/runner.py`、`alpha/backtest/analysis.py`、`alpha/backtest/optimize.py` |
| 修改技术指标公式或图表指标协议 | `alpha/analytics/indicator.py`、`alpha/chart/studies.py` | `alpha/api/routes/studies.py`、指标单元与路由测试 |
| 修改后台任务或事件 | `alpha/runtime/processes.py`、`alpha/runtime/event.py` | `alpha/api/routes/tasks.py`、`alpha/api/routes/sync.py`、`alpha/api/routes/events.py` |
| 修改存储格式或复权数据 | `alpha/storage/` | `alpha/common/schema_market.py`、相关仓储测试 |
| 维护 SQLite 数据库 | `alpha/scripts/vacuum_sqlite_dbs.py` | `alpha/tests/unit_tests/test_vacuum_sqlite_dbs.py` |

## 目录地图

| 路径 | 职责 |
| --- | --- |
| `alpha/api/` | FastAPI 应用、认证、依赖注入、响应模型和业务路由。正式接口统一挂载在 `/api/alpha`。 |
| `alpha/common/` | 跨模块共享的枚举、事件常量和市场、交易、回测数据模型。 |
| `alpha/runtime/` | 事件分发和子进程任务生命周期管理。 |
| `alpha/market/` | 东方财富和 GM 等外部行情源适配。 |
| `alpha/realtime/` | 按活跃数据键共享的轻量实时 K 线源、sequence、内存尾部和引用计数。 |
| `alpha/storage/` | SQLite、CSV 存储门面、领域仓储和数据转换。 |
| `alpha/strategy/` | 策略加载、运行时接口和任务生命周期管理。 |
| `alpha/backtest/` | 回测数据准备、撮合、组合管理、统计分析和参数优化。 |
| `alpha/analytics/` | 回测与图表共用的数值分析和技术指标数组计算。 |
| `alpha/chart/` | 图表 definition、参数校验和服务端指标结果编排。 |
| `alpha/sync_tasks/` | 同步计划、归一化、校验、写入及证券、指数成分、K 线同步任务。 |
| `alpha/live/`、`alpha/paper/` | 实盘和模拟盘的预留运行入口，当前没有完整实现。 |
| `alpha/scripts/` | 显式执行的离线维护工具。 |
| `alpha/tests/` | API 和启动测试，以及单元、集成、手工测试。 |

## 关键入口

### 应用与 API

- `alpha/__main__.py`：`python -m alpha` 命令入口。
- `alpha/server.py`：Uvicorn 前台运行器。
- `alpha/api/app.py`：FastAPI 应用工厂和服务生命周期入口。
- `alpha/api/router.py`：业务路由聚合入口。
- `alpha/api/container.py`：数据库、策略、事件和进程任务等运行对象的组装边界。
- `alpha/api/models.py`：业务 API 的请求和响应模型。
- `alpha/api/routes/`：健康、系统、状态、设置、数据、证券、行情、策略、回测、同步、任务和事件接口。

### 领域与运行时

- `alpha/storage/database.py`：统一存储门面，具体领域读写委托给 `alpha/storage/repositories/`。
- `alpha/strategy/manager.py`：策略装载、任务启动、状态查询和结果读取的总控。
- `alpha/backtest/backtesting.py`：回测主引擎。
- `alpha/backtest/runner.py`：回测和优化任务的进程执行入口。
- `alpha/analytics/indicator.py`：回测与图表共用的 TA-Lib 指标数组计算内核。
- `alpha/chart/studies.py`：首批图表指标 definition、参数规则和 output 映射。
- `alpha/realtime/market_data.py`：实时行情引用计数、sequence、状态与有界尾部。
- `alpha/realtime/eastmoney.py`：不依赖 pandas 的最近两根实时 K 线源。
- `alpha/runtime/processes.py`：子进程任务的启动、停止、状态刷新和清理。
- `alpha/runtime/event.py`：进程内事件队列、订阅和异步分发。
- `alpha/sync_tasks/tasks/`：证券、指数成分和 K 线同步任务实现。

## 重要边界

- FastAPI 是 Alpha 的业务协议边界。Terax Rust 层只负责生命周期、凭据注入和通用转发，不复制领域模型。
- `DataBase` 是存储访问门面。API 和策略层不直接承担分片 SQLite 的读写细节。
- 长时间运行的回测、优化和同步工作由进程任务管理器承载，API 路由只负责编排和返回状态。
- `alpha/live/runner.py` 和 `alpha/paper/runner.py` 当前是占位入口，不应视为可用交易运行时。
- `__init__.py`、叶子辅助函数和测试文件不在本文逐个展开。定位测试时，从被修改模块的同名或同领域测试开始。

## 测试位置

- `alpha/tests/test_*.py`：应用、API、配置和服务启动测试。
- `alpha/tests/unit_tests/`：存储、同步、回测、策略、运行时和工具函数单元测试。
- `alpha/tests/integration_tests/`：需要外部行情源或真实凭据的集成测试。
- `alpha/tests/manual/`：人工执行的数据库检查、回测和示例策略脚本。
