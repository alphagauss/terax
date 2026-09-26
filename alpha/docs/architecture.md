# Alpha 后端架构

Alpha 拥有行情、证券资料、自选、同步、策略、回测和业务存储；Terax 拥有 UI、Workspace 和应用生命周期。FastAPI 是唯一对外业务边界，路由通过同一服务容器访问领域对象。

## 所有权

- DataBase 是业务存储门面，领域 Repository 管理读写，底层统一处理 SQLite 分片和文件级写入锁；路由、策略和同步任务不直接打开分片。
- 自选分组、成员关系、手动顺序和置顶保存在业务主库，由页面与 Agent 共用命令 API；成员与相对位置命令在事务内精确修改，不接受客户端整表覆盖。添加校验证券目录，移除允许清理已失效证券；业务规则见 [自选协议](api-contracts.md#自选)。
- 外部行情源经过适配、归一化和校验后进入存储，供应商对象不扩散到公共 API。
- 回测与图表共用 analytics 指标数组计算，chart 负责 definition、参数和输出映射；API 负责行情查询、warmup 与 wire time 转换。
- 回测、优化和同步由唯一 TaskManager 管理；长期行情、模拟盘与策略对象由各自领域 Engine 拥有，不建立通用实体运行管理器。详见 [事件运行时](event-runtime.md)。
- live 与 paper 当前是预留入口，不能宣称为可用交易系统。可选原生计算不改变 Python 与 HTTP 公开行为。

## 配置与状态

Alpha 主目录默认 `~/.terax/alpha`，测试可通过 TERAX_ALPHA_HOME 隔离。Python 配置只保存自身字段，当前为绝对 data_dir；业务数据位于该目录，轻量运行状态位于主目录 state。

最近同步质量是有界状态快照，不复制行情正文。Python 不读写 Terax 前端的 terax-alpha.json，服务凭据只来自显式启动输入，不进入配置和业务数据。

重型工作不得阻塞 API 请求循环，服务容器统一关闭领域资源。HTTP 与 Repository 是恢复权威，事件不能作为永久事实存储。
