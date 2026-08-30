"""EventEngine 到受认证 WebSocket 的单向事件适配器。

Gateway 只维护远程 selector、串行发送队列和行情租约，不保存领域状态或事件
历史。慢连接会被关闭，客户端重连后通过 HTTP 权威快照恢复。
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from alpha.realtime.feed import MarketFeed
from alpha.realtime.model import MarketDataKey
from alpha.runtime.event import Event, EventEngine
from alpha.runtime.event_types import (
    EVENT_MARKET_BAR,
    EVENT_MARKET_STATUS,
    PUBLIC_EVENT_TYPES,
)

OUTBOUND_QUEUE_CAPACITY = 64
MAX_CONNECTION_SUBSCRIPTIONS = 64
Selector = tuple[str, str | None]


class _SubscriptionCommand(BaseModel):
    """远程订阅和取消订阅使用的严格公共命令。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    op: Literal["subscribe", "unsubscribe"]
    version: Literal[1]
    event: str = Field(min_length=1, max_length=64)
    key: str | None = Field(default=None, min_length=1, max_length=256)


@dataclass(slots=True)
class _Connection:
    """单个远程客户端的事件 selector 和串行发送队列。"""

    id: str
    websocket: WebSocket
    outbound: asyncio.Queue[dict[str, object]]
    selectors: set[Selector] = field(default_factory=set)
    closing: bool = False


class WebSocketEventGateway:
    """把公共 EventEngine 事件转换为一个 WebSocket 订阅协议。"""

    def __init__(self, event_engine: EventEngine, market_feed: MarketFeed) -> None:
        """创建尚未绑定 FastAPI 事件循环的 Gateway。"""

        self.event_engine = event_engine
        self.market_feed = market_feed
        self._loop: asyncio.AbstractEventLoop | None = None
        self._connections: dict[str, _Connection] = {}
        self._started = False

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """绑定 FastAPI loop 并订阅公共事件白名单。"""

        if self._started:
            return
        self._loop = loop
        for event_type in PUBLIC_EVENT_TYPES:
            self.event_engine.sub(event_type, self.on_event)
        self._started = True

    async def close(self) -> None:
        """停止接收事件并关闭全部远程连接。"""

        if not self._started:
            return
        for event_type in PUBLIC_EVENT_TYPES:
            self.event_engine.unsub(event_type, self.on_event)
        self._started = False
        self._loop = None
        connections = list(self._connections.values())
        for connection in connections:
            connection.closing = True
            with suppress(Exception):
                await connection.websocket.close(code=1001)
        self._connections.clear()

    async def serve(self, websocket: WebSocket) -> None:
        """处理一个已经完成认证和 accept 的 WebSocket。"""

        if self._loop is None or not self._started:
            raise RuntimeError("事件 Gateway 尚未启动")
        connection = _Connection(
            id=str(uuid4()),
            websocket=websocket,
            outbound=asyncio.Queue(maxsize=OUTBOUND_QUEUE_CAPACITY),
        )
        self._connections[connection.id] = connection
        sender = asyncio.create_task(
            self._send_messages(connection),
            name=f"alpha-events-{connection.id}",
        )
        try:
            while True:
                raw = await websocket.receive_text()
                await self._handle_command(connection, raw)
        except WebSocketDisconnect:
            pass
        finally:
            self._connections.pop(connection.id, None)
            await self._release_all(connection)
            sender.cancel()
            with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await sender

    def on_event(self, event: Event) -> None:
        """把 EventEngine 线程中的回调安全切换到 FastAPI loop。"""

        loop = self._loop
        if loop is None or not self._started or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._dispatch, event)

    async def _handle_command(self, connection: _Connection, raw: str) -> None:
        """解析一个 ping、订阅或取消订阅命令。"""

        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            await self._reply_error(
                connection, "invalid_json", "WebSocket 消息必须是 JSON"
            )
            return
        if message == {"op": "ping"}:
            await connection.outbound.put({"op": "pong"})
            return
        try:
            command = _SubscriptionCommand.model_validate(message)
            if command.event not in PUBLIC_EVENT_TYPES:
                raise ValueError("事件类型不允许远程订阅")
            selector = (command.event, command.key)
            if command.event in {EVENT_MARKET_BAR, EVENT_MARKET_STATUS}:
                if command.key is None:
                    raise ValueError("行情事件必须提供数据键")
                selector = (
                    command.event,
                    MarketDataKey.from_identifier(command.key).identifier(),
                )
        except (ValidationError, ValueError) as exc:
            await self._reply_error(connection, "invalid_message", str(exc))
            return

        if command.op == "subscribe":
            await self._subscribe(connection, selector)
        else:
            await self._unsubscribe(connection, selector)

    async def _subscribe(
        self,
        connection: _Connection,
        selector: Selector,
    ) -> None:
        """登记 selector，并为行情事件获取对应 Provider 租约。"""

        if selector in connection.selectors:
            await self._reply_subscription(connection, "subscribed", selector)
            return
        if len(connection.selectors) >= MAX_CONNECTION_SUBSCRIPTIONS:
            await self._reply_error(
                connection,
                "subscription_limit",
                "单连接事件订阅数量已达上限",
            )
            return
        owner = self._owner(connection, selector)
        connection.selectors.add(selector)
        try:
            if selector[0] in {EVENT_MARKET_BAR, EVENT_MARKET_STATUS}:
                await self.market_feed.acquire(
                    MarketDataKey.from_identifier(selector[1] or ""),
                    owner,
                )
        except (RuntimeError, ValueError) as exc:
            connection.selectors.discard(selector)
            await self._reply_error(connection, "subscription_failed", str(exc))
            return
        await self._reply_subscription(connection, "subscribed", selector)

    async def _unsubscribe(
        self,
        connection: _Connection,
        selector: Selector,
    ) -> None:
        """移除 selector 并释放对应行情租约。"""

        if selector in connection.selectors:
            connection.selectors.remove(selector)
            await self._release(connection, selector)
        await self._reply_subscription(connection, "unsubscribed", selector)

    async def _release_all(self, connection: _Connection) -> None:
        """连接结束时释放其全部领域租约。"""

        selectors = list(connection.selectors)
        connection.selectors.clear()
        for selector in selectors:
            await self._release(connection, selector)

    async def _release(self, connection: _Connection, selector: Selector) -> None:
        """释放一个 selector 关联的行情租约。"""

        if selector[0] not in {EVENT_MARKET_BAR, EVENT_MARKET_STATUS}:
            return
        await self.market_feed.release(
            MarketDataKey.from_identifier(selector[1] or ""),
            self._owner(connection, selector),
        )

    def _dispatch(self, event: Event) -> None:
        """在 FastAPI loop 中向匹配 selector 的连接无阻塞投递事件。"""

        payload = {
            "op": "event",
            "version": 1,
            "event": event.type,
            "key": event.key,
            "revision": event.revision,
            "time": event.occurred_at.isoformat(),
            "data": jsonable_encoder(event.data),
        }
        for connection in list(self._connections.values()):
            if connection.closing:
                continue
            if (event.type, event.key) not in connection.selectors and (
                event.type,
                None,
            ) not in connection.selectors:
                continue
            try:
                connection.outbound.put_nowait(payload)
            except asyncio.QueueFull:
                connection.closing = True
                asyncio.create_task(self._close_slow(connection))

    async def _close_slow(self, connection: _Connection) -> None:
        """关闭无法消费事件的客户端，避免其反向阻塞事件总线。"""

        with suppress(Exception):
            await connection.websocket.close(code=1013, reason="事件消费者过慢")

    async def _send_messages(self, connection: _Connection) -> None:
        """串行发送响应和事件，禁止并发写同一个 WebSocket。"""

        while True:
            await connection.websocket.send_json(await connection.outbound.get())

    async def _reply_subscription(
        self,
        connection: _Connection,
        op: str,
        selector: Selector,
    ) -> None:
        """发送订阅命令确认。"""

        await connection.outbound.put(
            {"op": op, "version": 1, "event": selector[0], "key": selector[1]}
        )

    async def _reply_error(
        self,
        connection: _Connection,
        code: str,
        message: str,
    ) -> None:
        """发送结构化协议错误。"""

        await connection.outbound.put(
            {"op": "error", "version": 1, "code": code, "message": message}
        )

    @staticmethod
    def _owner(connection: _Connection, selector: Selector) -> str:
        """构造只在当前 Gateway 生命周期内使用的租约 owner。"""

        return f"{connection.id}:{selector[0]}:{selector[1] or '*'}"
