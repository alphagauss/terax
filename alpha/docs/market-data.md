# Alpha 行情数据与存储

本文记录 Alpha Python 后端拥有的行情数据目录、SQLite 分片、复权、时间和同步不变量。具体表结构与 SQL 以 `alpha/storage/base.py`、领域 Repository 和存储测试为准。

## 数据目录

`AlphaConfig.data_dir` 必须是绝对路径，默认位于 `~/.terax/alpha/data/`：

```text
data_dir/
  sqlite_db/
    main.db
    d_YYYY.db
    w_YYYY.db
    1m_YYYY_MM.db
    1h_YYYY_MM.db
    tick_YYYY_MM_DD.db
  csv_db/
```

- `main.db` 保存证券资料、数据覆盖、复权因子、股本、状态游标和其他目录元数据。
- K 线正文按周期和时间写入独立分片，避免单库无界增长。
- 日线和周线按年分片，分钟和小时线按月分片，tick 按日分片。
- `csv_db/` 保存交易日历和证券池等仍由 CSV 入口提供的数据。
- Alpha 主目录下的 `state/` 保存轻量运行状态，不与可同步业务数据混放。

## 存储分层

`DataBase` 是对 API、策略和同步任务开放的唯一数据库门面。它把调用委托给证券、行情、数据目录、指数成分和股本等领域 Repository；`SQLiteStorageBase` 只负责连接、建表、分片命名和文件级写入串行化。

关键约束：

- API 路由不直接打开 SQLite 文件。
- Repository 不自行发明分片命名或跨文件锁。
- 读取使用短生命周期连接并移到工作线程，避免阻塞 asyncio 事件循环。
- 同一数据库文件的写入串行执行，不宣称跨多个 SQLite 文件原子提交。
- 新分片在第一次写入前完成建表，读路径不会为了查询空范围创建分片。

## 写入与数据目录

- K 线入库只接受未复权原始价格，复权视图在读取时计算。
- 同一批写入要求主键和字段形态一致；主行情 upsert 与日线限价补写是不同写入模式。
- provider 数据先经过归一化和一次线性校验，再交给 writer 和 `DataBase`。日线校验覆盖计划标的与日期范围、有限数值、OHLC 高低价关系、非负数量字段和批内重复主键。
- 非法日线批次整体拒绝写入；合法但少于同步计划预期行数的批次保存已有数据，同时把标的加入有界重试集合。
- 正常写入同步更新 `bar_overview`；批量导入可以延后，并在结束后显式重建 overview。
- 日线任务写完后只读取一次主库 `bar_overview`，核对本次合法数据的起止时间和最小行数，不逐证券回扫行情分片。
- union 证券目录由资料和行情覆盖共同构成，允许 `profile_only`、`bars_only` 和完整状态，不读取所有分片后再在 Python 中分页。

## 历史读取与游标

`BarHistoryQuery.before` 是排他游标。存储层从最新分片向前惰性读取，每个分片执行倒序限制，累计到 `limit + 1` 后停止，再把返回页恢复为升序。

- `has_more_before` 来自多读的一条记录，不通过 overview 行数猜测。
- `next_before` 使用当前页最早真实时间，只在仍有更早数据时返回。
- 游标保留小数秒，不能向下截断后误删同秒内更早记录。
- 跨年、跨月和跨日分片不能产生重复边界记录。
- API 把存储本地时间转换为公共行情时间，前端只消费响应游标。

## 实时事件

- MarketFeed 只在存在租约时按完整证券、周期和复权键读取最近两根上游 K 线；前端和未来内部领域 Engine 共享唯一键的上游任务。
- 当前上游返回完整 K 线，volume 和 amount 固定使用累计值。MarketFeed 每键只保留一个最新 bar 用于重复抑制，拒绝时间早于最新值的上游回退，新时间通过 `previous_final=true` 确认上一根完成。
- MarketFeed 不保存历史尾部，不参与 `/bars` 或指标查询，也不生成 sequence。前端以 HTTP 历史为基础，按时间替换或追加实时 bar。
- 实时源按请求直接返回 `none`、`forward` 或 `backward` 口径。服务重启、断线重连或最后租约释放后由 Provider 重新发布最新值。
- 当前 `live` 表示上游读取链路健康，不等同于交易所开市；连续读取失败依次降级为 `delayed` 和 `disconnected`。

## 复权语义

Alpha 只存原始 K 线和稀疏累计复权因子：

- `none` 返回原始价格。
- `forward` 以前端视图或查询窗口的最新端因子为锚点，`backward` 以最早端因子为锚点。
- 有界历史分页属于同一个连续视图，必须改用完整数据覆盖范围两端的固定锚点，不能让每一页按自身首尾重新定基。
- 因子区间读取包含查询起点之前最近一次已生效因子，避免区间前半段错误回退为 1。
- 复权只调整价格视图字段，成交量和成交额不在缺少明确市场规则时擅自换算。

复权因子缺失时当前实现回退为原始价格。任何改变该策略的工作都必须同时更新存储测试和 [API 协议](./api-contracts.md)。

## 时间与市场元数据

- 存储中的日线和周线代表交易日，不代表 UTC 午夜。
- 盘中存储时间按证券交易所本地时间解释，API 返回时增加显式偏移。
- 交易所 IANA 时区、涨跌颜色约定和成交量单位集中在 `alpha/common/market_metadata.py`。
- `price_tick` 来自证券资料；前端可以据此计算价格精度，但不能维护第二份交易所价格表。
- bars 参考价属于查询结果，不属于证券静态资料。它随周期、复权和查询锚点变化。

## 同步流水线

同步代码按以下顺序组织：

```text
planner -> provider/adapter -> normalizer -> validator -> writer -> report
```

- planner 根据覆盖、交易日历和同步游标决定请求范围。
- provider 适配外部接口，不能把供应商对象直接写入存储。
- normalizer 生成 Alpha schema，validator 在同一次字典遍历中完成字段校验、按标的分组和覆盖计数，并继续检查重叠区差异。
- writer 通过 `DataBase` 保存数据并推进成功游标。
- report 记录失败和异常，不能把部分成功伪装为完整覆盖。

最近一次 API 日线同步的质量快照保存在 Alpha 状态目录的 `data-quality/latest.json`，服务重启后仍可读取。快照最多保留 100 条异常明细和 500 个定向重试标的，同时保留完整异常计数；它不是行情数据或 Terax 前端配置。重叠区差异用于报告供应商修订，当前仍允许合法新数据通过既有 upsert 更新。

证券资料、指数成分、K 线和状态同步各自拥有任务入口，但共享上述边界。长任务由进程任务管理器执行，API 路由不直接运行无界同步循环。

## 验证入口

- 存储和复权：`alpha/tests/unit_tests/test_database.py`、`test_adjustment.py`。
- 同步计划与写入：`test_sync_tasks_planners.py`、`test_sync_tasks_io.py`、`test_sync_tasks_tasks.py`。
- 行情 API：`alpha/tests/test_router.py`。
- 实时行情源与租约：`test_realtime_eastmoney.py`、`test_market_feed.py`。
- 数据库 VACUUM 实现与约束：`alpha/scripts/vacuum_sqlite_dbs.py` 和对应单元测试。当前没有独立 CLI 入口，不能把导入模块写成维护命令。
