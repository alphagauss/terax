"""Alpha 稳定事件类型目录。

事件类型只描述已经发生的领域变化。命令、权威查询和上游资源订阅不通过
这些常量表达，WebSocket 也只允许显式白名单中的公共事件。
"""

EVENT_TIMER = "system.timer"
EVENT_LOG = "log.created"
EVENT_TASK_UPDATED = "task.updated"
EVENT_MARKET_BAR = "market.bar"
EVENT_MARKET_STATUS = "market.status"
EVENT_ORDER_UPDATED = "order.updated"
EVENT_TRADE_CREATED = "trade.created"
EVENT_POSITION_UPDATED = "position.updated"
EVENT_ACCOUNT_UPDATED = "account.updated"
EVENT_STRATEGY_SIGNAL = "strategy.signal"
EVENT_ALERT_TRIGGERED = "alert.triggered"
EVENT_RISK_TRIGGERED = "risk.triggered"
EVENT_NOTIFICATION_CREATED = "notification.created"

PUBLIC_EVENT_TYPES = frozenset(
    {
        EVENT_TASK_UPDATED,
        EVENT_MARKET_BAR,
        EVENT_MARKET_STATUS,
        EVENT_ORDER_UPDATED,
        EVENT_TRADE_CREATED,
        EVENT_POSITION_UPDATED,
        EVENT_ACCOUNT_UPDATED,
        EVENT_STRATEGY_SIGNAL,
        EVENT_ALERT_TRIGGERED,
        EVENT_RISK_TRIGGERED,
        EVENT_NOTIFICATION_CREATED,
    }
)
