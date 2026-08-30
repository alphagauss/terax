# Alpha Python 后端文档

本目录只记录 `alpha/` Python 服务自身的架构、公共业务协议和数据不变量。Terax Rust 生命周期、通用代理和 React 工作台属于宿主应用，统一记录在 `docs/architecture/`，不在这里复制。

## 文档入口

- [后端架构](./architecture.md)：FastAPI、领域模块、任务运行时和存储之间的依赖方向。
- [API 协议](./api-contracts.md)：认证、错误、时间、复权、分页、任务和 WebSocket 约定。
- [统一事件运行时](./event-runtime.md)：EventEngine、TaskManager、MarketFeed、公共事件和进度边界。
- [行情数据与存储](./market-data.md)：数据目录、SQLite 分片、复权锚点和同步不变量。
- [代码地图](./code-map.md)：按任务定位源码入口、关联模块和测试。

跨进程边界见 [Alpha 集成架构](../../docs/architecture/alpha-integration.md)，前端工作台和公共金融图表见 [Alpha 综合量化工作站](../../docs/architecture/alpha-quant-workstation.md)。

## 开发与验证

Terax 正常运行时由 Rust 使用用户选择的 Python 解释器管理 Alpha 服务，开发者通常不需要手工启动第二个服务。

- 运行依赖：`alpha/requirements-runtime.txt`。
- 开发和测试依赖：`alpha/requirements.txt`。
- 运行环境检查：`python -E -m alpha.runtime_check`。
- 后端测试：`python -m pytest alpha/tests`。
- Python 格式检查：`python -m black --check <本次修改的 Python 文件>`。
- 手工启动入口：`python -E -m alpha`。服务必须取得 `TERAX_ALPHA_TOKEN` 或显式 `--token`，默认只监听 `127.0.0.1:11123`。

不要让 Terax 自动安装或修改用户的 Python 环境。缺失依赖由运行环境检查报告，依赖安装由用户或开发者在所选环境中显式完成。

## 文档维护原则

- 文档记录长期边界和不明显的不变量，不逐个复述类、函数或响应字段。
- FastAPI 路由、Pydantic 模型和测试是具体 wire format 的源码权威。
- SQLite 建表语句、仓储实现和存储测试是物理格式的源码权威。
- 尚未实现的模拟交易和实盘策略能力只记录当前边界，不写成可用功能。
