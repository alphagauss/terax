# Alpha 后端文档

本目录记录 Python 领域语义；Terax 生命周期与代理见 [Alpha 集成](../../docs/architecture/alpha-integration.md)，前端见 [工作站](../../docs/architecture/alpha-quant-workstation.md)。

- [架构](architecture.md)：领域与配置归属。
- [API 协议](api-contracts.md)：时间、分页、指标及公共接口语义。
- [行情存储](market-data.md)：原始行情、复权与同步质量。
- [事件运行时](event-runtime.md)：有限任务、MarketFeed 与订阅恢复。

## 开发

Terax 使用用户选择的 Python 解释器管理服务，不自动安装或修改 Python 环境。运行依赖为 `requirements-runtime.txt`，开发依赖为 `requirements.txt`，最低 Python 版本由运行检查确认。

```sh
python -E -m alpha.runtime_check
python -m pytest alpha/tests
python -m black --check <本次修改的Python文件>
```

需要独立运行时使用 `python -E -m alpha`，提供 `TERAX_ALPHA_TOKEN` 或显式 token 参数；不要与受管服务占用同一端口。外部数据源与真实凭据集成测试不属于默认离线验证前提。

具体 HTTP 字段以路由、Pydantic 模型和测试为准，物理存储以仓储和建表语句为准，不另维护代码地图或字段镜像。
