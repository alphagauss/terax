# Alpha API 协议

本文记录 `/api/alpha` 的公共协议不变量，不复制完整 OpenAPI。具体 endpoint、参数和响应字段以 `alpha/api/routes/`、`alpha/api/models.py` 和路由测试为准。

## 认证与访问边界

- HTTP 和 WebSocket 都必须携带与服务进程一致的 Bearer 凭据。
- Alpha 默认只监听 `127.0.0.1:11123`，但监听地址不能替代认证。
- 当前健康检查协议版本为 3；旧服务必须由 Rust 生命周期管理器替换，不能继续接受旧事件协议。
- Terax WebView 不持有凭据；Rust 通用代理在受信边界内注入凭据。
- `/api/alpha/system/*` 是服务生命周期接口，只允许 Terax 专用生命周期命令访问，不属于普通业务代理入口。
- 缺失或错误凭据返回 HTTP 401；WebSocket 使用策略违规关闭语义。

## 当前接口分组

| 分组 | 主要职责 |
| --- | --- |
| `health`、`status` | 服务身份、协议版本、revision、就绪状态和轻量业务摘要 |
| `settings` | 查询和更新 Alpha Python 持久配置 |
| `data`、`securities` | 数据目录概览、Facets、证券分页和证券详情 |
| `bars` | 范围行情和基于排他游标的有界历史行情 |
| `strategies` | 策略发现、详情和显式刷新 |
| `backtests` | 回测启动、列表、结果分片、日志和回放数据 |
| `sync`、`tasks` | 后台任务快照、日志和取消 |
| `events` | 受认证的实时 K 线订阅、增量、状态与 ping/pong |

## 通用约定

- 请求和响应使用 JSON，正式业务路径统一位于 `/api/alpha`。
- Pydantic 在 API 边界校验公开形状；内部 ORM、provider 对象和 NumPy 类型不能直接进入响应。
- FastAPI 业务错误使用 HTTP 状态码和 `detail`；传输失败与业务失败必须保持可区分。
- 可分页列表显式返回总数和分页信息；固定且有界的轻量摘要可以直接返回数组。
- 时间、数值和枚举在返回前转换为 JSON 可表达的稳定类型；NaN 和 Infinity 不能进入 wire format。
- 用户可见文案、颜色和图标不属于 Python API，由 Terax 国际化与主题层生成。

## 行情时间与复权

- 公开周期使用 `1m`、`1h`、`d`、`w` 和 `tick`。图表是否允许某周期由证券详情的真实覆盖决定。
- 公开复权使用 `none`、`forward` 和 `backward`；Python 内部可归一化为 `non`、`pre` 和 `post`，内部值不能泄漏给调用方。
- 日线和周线时间是无时区交易日。盘中时间必须带显式 UTC 偏移，前端不能根据 WebView 本地时区猜测。
- 证券详情返回 IANA 时区、价格颜色约定、成交量单位和最小价格跳动等静态市场语义。

## bars 分页与参考价

- `start + end` 表示范围查询；`before` 表示历史分页的排他上界，两种模式不能混用。
- 历史页内部按时间倒序有界读取，公共响应恢复为升序。
- 响应显式提供 `has_more_before`、`next_before`、`actual_start` 和 `actual_end`，调用方不能自行构造游标。
- `/bars` 只返回数据库权威历史，不读取 EventEngine 或 MarketFeed 的瞬时值。实时图表在前端按时间把 `market.bar` 替换或追加到 HTTP 数据。
- 历史分页共享完整数据覆盖范围的复权锚点，拼接页面不能在边界产生价格跳变。
- `reference_close` 和 `reference_time` 独立于 bars 数组，使用与本次周期和复权一致的查询语义。
- 日线和周线参考价取当前锚点前一根已完成 K 线；盘中参考价取当前交易时段之前最近的已完成日线。没有可靠前序数据时返回 `null`。

存储和复权实现见 [行情数据与存储](./market-data.md)。

## 图表指标

- `GET /studies` 返回服务端权威 definition，只包含稳定 type、参数 key 与范围、output ID、pane、series kind 和参考水平，不返回名称、颜色或图表引擎类型。
- `POST /studies/calculate` 首批支持 SMA、EMA、BOLL、RSI 和 MACD，单次最多 8 个实例、4,000 根显示区间行情。参数缺失使用 definition 默认值，未知参数、越界、错误步进、重复 instance ID 和 `MACD fast >= slow` 会在读取行情前拒绝。
- 前端只提交 `vt_symbol + interval + adjust + start/end + studies`。请求模型禁止上传原始 bars，Alpha 根据全部实例的最大 lookback 从自身存储一次读取显示区间和 warmup，响应只保留显示区间。
- 回测和图表共用 `alpha/analytics/indicator.py` 的 TA-Lib 数组计算内核。`alpha/chart/studies.py` 只增加图表 definition、参数规则与 output 映射，API 外壳独自处理数据库查询和 wire time，公式不在前端或路由中复制。
- 日线和周线点使用交易日字符串，盘中点使用带偏移 ISO 时间，与 `/bars` 相同。每个 output 与显示区间 bars 一一对应并严格升序，未形成的 warmup 值为 `null`；NaN 和 Infinity 不进入 wire format。
- TA-Lib 异常、非有限输入或输出长度错位会让整次请求返回结构化 `study_calculation_failed`，不能返回部分实例或部分 output。

## 任务协议

- 启动长任务后立即返回稳定任务 ID，不等待回测、优化或同步完成。
- `GET /tasks/{task_id}` 和 `task.updated` 使用同一完整 TaskSnapshot，包含 `kind`、`status`、`stage`、`progress`、`metrics`、`message` 和单调 `revision`；日志和最终领域结果使用独立接口。
- 子进程可以逐 bar 或逐批次报告进度，跨进程普通进度最多每 200ms 发布一次；阶段变化、完成点和终态立即发布。
- 领域 result handler 先保存最终结果，TaskManager 随后发布 `succeeded`。取消不存在的任务返回 404，无法取消时返回 409。
- `GET /backtests` 只合并 `backtest` 任务与持久化回测结果；同 ID 的成功运行态不会生成重复列表项，参数优化任务不混入回测列表。
- 服务重启后不能假设进程内任务仍存在；需要持久化的结果由对应领域模块显式保存。
- `POST /sync/bars` 启动 A 股日线增量同步。可选 `vt_symbols` 最多接受 500 个规范证券代码，用于复用同一任务定向重试；同一时间只允许一个日线同步任务。
- `GET /sync/overview` 只返回轻量任务状态和最近一次持久化质量快照。质量明细最多 100 条，重试标的最多 500 个；完整异常数和受影响标的数使用独立计数字段，不因明细截断而丢失。
- 非法行情批次不会写入。合法但覆盖不足、批次失败和写后 overview 不一致会进入质量快照；前端不得自行重算或扩大重试标的集合。

## WebSocket 基线

`/events` 使用统一公共事件协议版本 1。`{"op":"ping"}` 返回 `{"op":"pong"}`：

- 客户端发送 `{"op":"subscribe","version":1,"event":"task.updated","key":"task-id"}`，取消订阅使用相同 selector 和 `unsubscribe`。缺少 key 表示订阅整个公共事件族。
- 公共事件由 `event + key` 路由，单连接最多 64 个 selector；EventEngine 内部事件只有进入显式白名单后才能远程订阅。
- `market.bar` 和 `market.status` 必须使用 `vt_symbol|interval|adjust` 键。服务端会把证券代码和交易所规范为大写后确认订阅。周期只接受 `1m`、`1h`、`d`、`w`，复权只接受 `none`、`forward`、`backward`；服务最多 128 个活跃行情键。
- `market.bar` 携带完整 OHLC、累计 volume/amount、`is_final`、`previous_final` 和显式 `volume_mode`。同时间由前端替换，更晚时间追加，迟到时间拒绝。
- `market.status` 的 `live`、`delayed` 或 `disconnected` 只表示上游读取链路，不表示交易所一定开市。
- 每条连接最多排队 64 条响应或事件。慢连接直接关闭，客户端重连、重放 selector 并重新查询 HTTP 权威状态。
- WebSocket 事件不是永久事实存储，不提供 sequence、历史重放、`bar_reset` 或 `resync_required`。

## 修改协议时

1. 先更新 Pydantic 模型或封闭的路由 schema。
2. 增加路由测试，锁定成功、非法输入和失败路径。
3. 更新前端 Zod 边界与 API 测试。
4. 只有传输能力变化时才修改 Rust 通用代理。
5. 同步更新本文中的长期不变量，不维护容易漂移的字段清单。
