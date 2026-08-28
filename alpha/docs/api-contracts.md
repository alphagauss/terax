# Alpha API 协议

本文记录 `/api/alpha` 的公共协议不变量，不复制完整 OpenAPI。具体 endpoint、参数和响应字段以 `alpha/api/routes/`、`alpha/api/models.py` 和路由测试为准。

## 认证与访问边界

- HTTP 和 WebSocket 都必须携带与服务进程一致的 Bearer 凭据。
- Alpha 默认只监听 `127.0.0.1:11123`，但监听地址不能替代认证。
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
- 最新页额外返回非负 `live_sequence`。存在活跃实时订阅时，响应在同一服务锁下读取 sequence 和最多 512 根内存尾部，再按时间替换或追加到数据库结果；历史 `before` 页不拼接实时尾部。
- 历史分页共享完整数据覆盖范围的复权锚点，拼接页面不能在边界产生价格跳变。
- `reference_close` 和 `reference_time` 独立于 bars 数组，使用与本次周期和复权一致的查询语义。
- 日线和周线参考价取当前锚点前一根已完成 K 线；盘中参考价取当前交易时段之前最近的已完成日线。没有可靠前序数据时返回 `null`。

存储和复权实现见 [行情数据与存储](./market-data.md)。

## 图表指标

- `GET /studies` 返回服务端权威 definition，只包含稳定 type、参数 key 与范围、output ID、pane、series kind 和参考水平，不返回名称、颜色或图表引擎类型。
- `POST /studies/calculate` 首批支持 SMA、EMA、BOLL、RSI 和 MACD，单次最多 8 个实例、4,000 根显示区间行情。参数缺失使用 definition 默认值，未知参数、越界、错误步进、重复 instance ID 和 `MACD fast >= slow` 会在读取行情前拒绝。
- 前端只提交 `vt_symbol + interval + adjust + start/end + studies`。请求模型禁止上传原始 bars，Alpha 根据全部实例的最大 lookback 从自身存储一次读取显示区间和 warmup；存在同键实时尾部时按时间替换或追加后计算，响应只保留显示区间。
- 回测和图表共用 `alpha/analytics/indicator.py` 的 TA-Lib 数组计算内核。`alpha/chart/studies.py` 只增加图表 definition、参数规则与 output 映射，API 外壳独自处理数据库查询和 wire time，公式不在前端或路由中复制。
- 日线和周线点使用交易日字符串，盘中点使用带偏移 ISO 时间，与 `/bars` 相同。每个 output 与显示区间 bars 一一对应并严格升序，未形成的 warmup 值为 `null`；NaN 和 Infinity 不进入 wire format。
- TA-Lib 异常、非有限输入或输出长度错位会让整次请求返回结构化 `study_calculation_failed`，不能返回部分实例或部分 output。

## 任务协议

- 启动长任务后立即返回稳定任务 ID，不等待回测、优化或同步完成。
- 任务查询返回状态快照；日志接口与任务结果分开。取消不存在的任务返回 404，无法由进程管理器取消时返回 409，调用方不能假设取消天然幂等。
- API 状态可与内部进程退出码不同步一小段时间，读取任务时必须先刷新运行状态。
- 服务重启后不能假设进程内任务仍存在；需要持久化的结果由对应领域模块显式保存。
- `POST /sync/bars` 启动 A 股日线增量同步。可选 `vt_symbols` 最多接受 500 个规范证券代码，用于复用同一任务定向重试；同一时间只允许一个日线同步任务。
- `GET /sync/overview` 只返回轻量任务状态和最近一次持久化质量快照。质量明细最多 100 条，重试标的最多 500 个；完整异常数和受影响标的数使用独立计数字段，不因明细截断而丢失。
- 非法行情批次不会写入。合法但覆盖不足、批次失败和写后 overview 不一致会进入质量快照；前端不得自行重算或扩大重试标的集合。

## WebSocket 基线

`/events` 保留 `{"type":"ping"}` 与 `pong`，实时行情协议版本固定为 1：

- 客户端用 `subscribe` 和 `unsubscribe` 管理一个完整 `vt_symbol + interval + adjust` 数据键。周期只接受 `1m`、`1h`、`d`、`w`，复权只接受 `none`、`forward`、`backward`；单连接最多 32 个键，服务进程最多 128 个活跃唯一键。
- 服务端用 `subscribed` 返回当前 sequence。每个键独立单调递增；`bar` 携带完整 OHLC、累计 volume/amount、`is_final`、`previous_final` 和显式 `volume_mode`。当前东方财富源固定发布 `cumulative`，协议仍允许后续受控源发布 `incremental`。
- 同 bucket 更新当前 bar；更晚 bucket 追加并以 `previous_final=true` 确认上一根完成。更早时间、已稳定历史修订或复权锚点变化触发 `bar_reset`，调用方不得自行修补历史。
- `market_status` 只表示当前上游读取链路的 `live`、`delayed` 或 `disconnected`，不表示交易所一定处于开市状态，也不参与 sequence。
- 首次订阅、sequence gap、`bar_reset`、慢客户端队列溢出和断线重连后，客户端暂停应用增量，重新请求最新 `/bars`，以 `live_sequence` 为衔接点丢弃重复消息并按序应用其后的缓冲增量。
- WebSocket 增量不是永久事实存储。最后消费者释放后停止上游任务；服务重启或重新订阅仍以 HTTP 快照恢复。

## 修改协议时

1. 先更新 Pydantic 模型或封闭的路由 schema。
2. 增加路由测试，锁定成功、非法输入和失败路径。
3. 更新前端 Zod 边界与 API 测试。
4. 只有传输能力变化时才修改 Rust 通用代理。
5. 同步更新本文中的长期不变量，不维护容易漂移的字段清单。
