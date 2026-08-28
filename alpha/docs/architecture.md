# Alpha Python 后端架构

本文定义 `alpha/` 内部的长期模块边界。Terax 如何打包、启动、认证和代理 Alpha，见 [Alpha 集成架构](../../docs/architecture/alpha-integration.md)。

## 架构定位

Alpha 是独立的 FastAPI 量化业务服务。它拥有行情、证券资料、同步、策略、回测、任务和数据访问语义，但不拥有 Terax UI、Workspace、共享设置或 Rust 进程生命周期。

```text
FastAPI /api/alpha
        |
        v
AlphaServiceContainer
        |
        +--> DataBase --> 领域 Repository --> SQLite / CSV
        |
        +--> StrategyManager --> Backtest / Optimize
        |
        +--> ProcessTaskManager --> spawn 子进程任务
        |
        +--> EventEngine
```

`alpha/api/app.py` 在应用 lifespan 中创建一个 `AlphaServiceContainer`，全部业务路由共享该容器。应用退出时统一关闭数据库、任务管理器和事件运行对象。

## 模块职责

| 模块 | 职责 | 不能承担 |
| --- | --- | --- |
| `alpha/api/` | FastAPI 应用、认证、依赖注入、响应模型和业务路由 | SQLite 分片细节、前端展示和 Terax 生命周期 |
| `alpha/common/` | 跨领域枚举、schema 和市场静态语义 | FastAPI 路由、存储连接或 UI 模型 |
| `alpha/storage/` | 数据库门面、领域仓储、物理分片和数据转换 | HTTP 参数、任务页面或用户文案 |
| `alpha/sync_tasks/` | 同步计划、外部读取、归一化、校验、写入和报告 | 直接维护前端状态或绕过存储门面 |
| `alpha/market/` | 东方财富、GM 等外部行情源适配 | 定义 Terax 网络代理或 UI 协议 |
| `alpha/strategy/` | 策略发现、加载、管理和任务编排 | 直接拥有 Workbench 文件编辑状态 |
| `alpha/backtest/` | 回测数据准备、撮合、组合、统计和优化 | 阻塞 FastAPI 事件循环 |
| `alpha/analytics/` | 回测、图表等场景共用的数值与技术指标数组计算 | HTTP、存储读取或前端时间模型 |
| `alpha/chart/` | 图表 definition、参数规则和服务端计算编排 | 图表引擎类型、主题样式或用户文案 |
| `alpha/runtime/` | 进程任务和进程内事件生命周期 | 暴露未经定义的内部事件为公共协议 |
| `alpha/live/`、`alpha/paper/` | 预留运行入口 | 当前不能视为完整实盘或模拟交易实现 |

源码定位见 [代码地图](./code-map.md)。

## 依赖方向

- API 路由只做输入校验、业务编排和响应构造，通过容器访问领域服务。
- `DataBase` 是存储访问门面。API、策略和同步任务不直接依赖具体 SQLite 分片文件。
- Repository 按领域拆分查询和写入，底层连接、文件级写锁和分片命名由 `SQLiteStorageBase` 统一管理。
- 跨模块公共 schema 放在 `alpha/common/`，不能依赖 FastAPI、React 或 Lightweight Charts。
- 外部数据先经过适配、归一化和校验，再进入 writer 和存储，不把 provider 原始对象扩散到 API。
- 日线质量检查属于 `alpha/sync_tasks/`。它在 provider 批次上执行线性校验，并通过一次主库 overview 读取确认写入覆盖；不得在 API 请求或前端轮询时扫描行情分片。
- `alpha/analytics/indicator.py` 是回测和图表共用的 TA-Lib 数组计算内核；既有 `alpha.backtest.indicator` 只保留兼容导出，不建立第二套公式。
- `alpha/chart/studies.py` 集中首批指标 definition、参数校验和输出映射。API 路由独自负责按证券、周期、复权和区间读取行情、补 warmup 及转换 wire time，回测不依赖 HTTP 返回形状。
- `alpha-native` 只能作为可替换计算实现，不改变 Python 公开接口和 FastAPI wire format。

## 长任务模型

回测、优化和同步等重型工作使用 `ProcessTaskManager` 的 `spawn` 子进程执行。任务 ID 在管理器内唯一，子进程通过受控队列上报日志、结果或错误，API 只返回快照并提供查询和取消入口。

任务状态固定为 `running`、`succeeded`、`failed`、`cancelled` 或 `timeout`。停止时先 `terminate` 并有界等待，仍未退出才 `kill`。服务关闭时由容器决定是否停止仍在运行的任务，不能留下无所有者的子进程。

当前 `/events` WebSocket 只提供受认证的 JSON ping/pong 基础协议，不转发全部内部 `EventEngine`。公共实时事件必须先定义独立协议，再选择性桥接。

## 配置与状态归属

- Alpha 主目录默认是 `~/.terax/alpha/`，测试可通过 `TERAX_ALPHA_HOME` 指向隔离目录。
- Python 持久配置只包含 Alpha 自身字段，当前为绝对 `data_dir`，保存在 `config.json` 并原子替换。
- 可同步业务数据位于 `data_dir`；轻量运行状态位于 Alpha 主目录的 `state/`。
- 最近一次日线同步质量快照位于 `state/data-quality/latest.json`，只保存有界异常摘要和定向重试标的，不复制行情正文。
- Python 不读取或写入 Terax 的 `terax-alpha.json`。工作台布局、前端偏好和解释器选择属于 Terax。
- 服务凭据只从显式参数或 `TERAX_ALPHA_TOKEN` 取得，不写入 Alpha 配置或业务数据。

## 关键不变量

- FastAPI 是 Alpha 对外的唯一业务协议边界。
- 业务错误在 API 边界结构化返回，不能依赖 Rust 或前端解释 Python 内部异常。
- 重型计算不得阻塞 API 事件循环。
- 指标 API 不接受前端上传的原始 bars；行情由 Alpha 存储权威读取，前端只提交数据键、显示区间和有界指标实例。
- 存储写入先归一化和校验，读取结果在 API 边界转换为公共时间和字段语义。
- HTTP 查询结果是权威状态，WebSocket 增量不能取代恢复所需的快照。
- 当前未完成的 `live` 和 `paper` 入口不得被文档、API 或 UI 宣称为可用交易系统。

## 测试分层

- `alpha/tests/test_*.py` 覆盖应用、API、配置、服务入口和容器生命周期。
- `alpha/tests/unit_tests/` 覆盖存储、同步、策略、回测、图表指标、运行时和纯函数。
- `alpha/tests/integration_tests/` 依赖外部行情源或真实凭据，不属于默认离线测试前提。
- `alpha/tests/manual/` 是人工诊断脚本，不代替自动化回归。
