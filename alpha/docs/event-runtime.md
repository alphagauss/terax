# Alpha 统一事件运行时

本文定义 Alpha 进程内事件、有限任务、公共 WebSocket 和领域状态的长期边界。

## 核心结构

```text
Provider / Worker / Domain Engine
                |
                v
           EventEngine
          /           \
 后端同步 callback   WebSocketEventGateway
                           |
                      前端 EventClient
```

- `EventEngine` 只按事件类型和可选业务键顺序调用同步 callback，不管理领域状态、网络连接或持久化。
- `TaskManager` 是唯一通用运行管理器，只管理有明确终态的回测、优化和同步子进程。
- `MarketFeed` 管理行情 Provider 租约、引用计数和重复抑制，并把变化发布到 `EventEngine`。
- 模拟盘、策略和行情等长期运行对象由各自领域 Engine 管理。本阶段不建立通用 SessionManager、RuntimeManager 或 EntityManager。
- `WebSocketEventGateway` 只允许显式公共事件，按 `event + key` 过滤并为每条连接串行发送。
- HTTP 查询和 Repository 保存权威状态；WebSocket 事件只通知变化。

## 事件模型

内部事件是不可变 envelope：

```python
Event(
    type="task.updated",
    key="bt-123",
    revision=7,
    data=task_snapshot,
)
```

`type` 是稳定事件族，`key` 是任务 ID、行情数据键或账户 ID。只有具有权威快照的状态事件使用单调 `revision`。行情等瞬时事件使用业务时间幂等，不建立全局 sequence。

公共事件类型集中在 `alpha/runtime/event_types.py`。内部事件不会因为存在于 EventEngine 就自动暴露给前端，Gateway 白名单是独立安全边界。

## 有限任务

回测、优化和数据同步统一通过 `TaskManager`：

```text
Worker
  -> TaskMessagePublisher
  -> multiprocessing Queue
  -> TaskManager 更新 TaskSnapshot
  -> task.updated
```

稳定状态为 `running`、`succeeded`、`failed`、`cancelled` 和 `timeout`。任务快照包含 `kind`、`stage`、`progress`、`metrics`、`message` 和 `revision`。跨进程消息队列最多保留 256 条，单任务只保留最近 100 条日志，公共快照只携带最近 20 条。

子进程可以逐 bar 或逐批次调用 `progress()`。Publisher 在子进程本地保留最新值，普通进度最多每 200ms 跨进程发送一次；阶段变化、完成点和终态立即发送。不确定的收尾阶段保留上一阶段的确定进度和指标。任务结果先经过父进程领域 result handler 持久化，随后才发布 `succeeded`。同一任务 ID 再次运行时 revision 继续单调递增。

事件不是任务恢复源。前端订阅 `task.updated + task_id` 后仍通过 `GET /tasks/{task_id}` 获取权威快照；收到成功终态后再读取回测结果或同步质量报告。

## 公共 WebSocket

唯一公共事件连接是 `/api/alpha/events`。命令协议版本为 1：

```json
{"op":"subscribe","version":1,"event":"task.updated","key":"bt-123"}
```

服务端事件：

```json
{
  "op": "event",
  "version": 1,
  "event": "task.updated",
  "key": "bt-123",
  "revision": 7,
  "time": "2026-08-30T12:00:00+00:00",
  "data": {}
}
```

缺少 `key` 表示订阅某一公共事件族的全部事件。行情事件必须提供完整数据键。单连接最多 64 个 selector，发送队列最多 64 条；慢连接直接关闭，客户端重连、重放 selector 并重新查询 HTTP 状态。

前端 `EventClient` 在一个 WebView 内复用一条 Rust 代理连接，并把 selector 转换为普通 callback。同 selector 多个 callback 只产生一次远程订阅，最后 callback 释放后才 unsubscribe。

## 实时行情

行情数据键为 `vt_symbol|interval|adjust`。`MarketFeed` 的首个 owner 启动唯一 Provider 任务，最后 owner 释放后取消任务并删除最新值。

Provider 只发布完整累计 bar 和 `live`、`delayed`、`disconnected` 状态。服务端拒绝比已发布最新时间更早的上游 bar，不保存历史尾部、不生成 sequence、不把实时值拼入 `/bars`。图表先读取 HTTP 历史，再按时间替换或追加实时 bar；重连后重新订阅，Provider 会重新发布当前最新值。

未来模拟盘必须消费真实未复权 quote 或 tick，不能消费图表复权 K 线。它可以与前端共享同一个 MarketFeed 和 EventEngine，但由 PaperTradingEngine 自己拥有订单、成交、持仓和账户权威状态。

## 扩展原则

- 有明确终态、进度和最终结果的工作加入 TaskManager。
- 长期运行能力先放在对应领域 Engine，重复模式确实出现后再抽取运行注册表。
- 订单、成交、持仓、账户和通知先持久化完整状态，再发布变化事件。
- 高频详细回测回放未来使用独立 `backtest.frame` 事件，不把大结果塞入 `task.updated`。
- EventEngine handler 必须快速同步返回；数据库、网络和异步发送通过领域队列或 Gateway 适配。
