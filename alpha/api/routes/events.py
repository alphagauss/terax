"""Alpha 公共实时行情 WebSocket 协议。

路由只解析封闭消息并维护单连接订阅集合，sequence、上游任务和引用计数由
共享实时行情服务负责；内部 EventEngine 不会被无选择地暴露。
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Literal, cast

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, ValidationError

from alpha.api.auth import require_alpha_websocket_token
from alpha.api.container import AlphaServiceContainer
from alpha.realtime.market_data import OUTBOUND_QUEUE_CAPACITY, RealtimeQueue
from alpha.realtime.model import MarketDataKey

router = APIRouter()
MAX_CONNECTION_SUBSCRIPTIONS = 32


class _WireKey(BaseModel):
    """客户端消息使用的严格行情数据键。"""

    model_config = ConfigDict(extra="forbid")

    vt_symbol: str
    interval: Literal["1m", "1h", "d", "w"]
    adjust: Literal["none", "forward", "backward"]

    def domain(self) -> MarketDataKey:
        """转换为领域键并执行证券代码校验。"""

        return MarketDataKey(
            vt_symbol=self.vt_symbol.strip().upper(),
            interval=self.interval,
            adjust=self.adjust,
        )


class _SubscriptionMessage(BaseModel):
    """订阅或取消订阅消息。"""

    model_config = ConfigDict(extra="forbid")

    type: Literal["subscribe", "unsubscribe"]
    version: Literal[1]
    key: _WireKey


async def _send_messages(websocket: WebSocket, queue: RealtimeQueue) -> None:
    """串行发送全部响应和增量，避免并发写同一个 WebSocket。"""

    while True:
        await websocket.send_json(await queue.get())


@router.websocket("/events")
async def events(websocket: WebSocket) -> None:
    """建立受认证的 Alpha 双向事件连接。

    Args:
        websocket: 当前 WebSocket 连接。
    """

    await require_alpha_websocket_token(websocket)
    await websocket.accept()
    services = cast(AlphaServiceContainer, websocket.app.state.alpha_services)
    outbound: RealtimeQueue = RealtimeQueue(maxsize=OUTBOUND_QUEUE_CAPACITY)
    subscriptions: set[MarketDataKey] = set()
    sender = asyncio.create_task(_send_messages(websocket, outbound))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await outbound.put(
                    {
                        "type": "error",
                        "code": "invalid_json",
                        "message": "WebSocket 消息必须是 JSON",
                    }
                )
                continue
            if message == {"type": "ping"}:
                await outbound.put({"type": "pong"})
                continue
            try:
                command = _SubscriptionMessage.model_validate(message)
                key = command.key.domain()
            except (ValidationError, ValueError):
                await outbound.put(
                    {
                        "type": "error",
                        "code": "invalid_message",
                        "message": "不支持或格式非法的客户端消息",
                    }
                )
                continue
            if command.type == "subscribe":
                if (
                    key not in subscriptions
                    and len(subscriptions) >= MAX_CONNECTION_SUBSCRIPTIONS
                ):
                    await outbound.put(
                        {
                            "type": "error",
                            "code": "subscription_limit",
                            "message": "单连接实时行情订阅数量已达上限",
                        }
                    )
                    continue
                try:
                    sequence = await services.market_data.subscribe(key, outbound)
                except (RuntimeError, ValueError) as exc:
                    await outbound.put(
                        {
                            "type": "error",
                            "version": 1,
                            "key": key.wire(),
                            "code": "subscription_failed",
                            "message": str(exc),
                        }
                    )
                    continue
                subscriptions.add(key)
                await outbound.put(
                    {
                        "type": "subscribed",
                        "version": 1,
                        "key": key.wire(),
                        "sequence": sequence,
                    }
                )
                continue
            if key in subscriptions:
                subscriptions.remove(key)
                await services.market_data.unsubscribe(key, outbound)
            await outbound.put(
                {"type": "unsubscribed", "version": 1, "key": key.wire()}
            )
    except WebSocketDisconnect:
        pass
    finally:
        for key in list(subscriptions):
            await services.market_data.unsubscribe(key, outbound)
        sender.cancel()
        with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            await sender
