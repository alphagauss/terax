"""API 事件广播工具。"""

from __future__ import annotations

import asyncio
from typing import Protocol

from fastapi.encoders import jsonable_encoder
from loguru import logger

from alpha.runtime.event import Event


class EventWebSocket(Protocol):
    """广播器所需的 WebSocket 最小协议。"""

    async def send_json(self, data: object) -> None:
        """发送 JSON 消息。

        Args:
            data: 可 JSON 编码的消息对象。
        """


class EventBroadcaster:
    """把运行时事件广播给已连接的 WebSocket 客户端。"""

    def __init__(self, *, send_timeout: float = 2.0) -> None:
        """初始化广播器。

        Args:
            send_timeout: 单客户端发送超时，超时连接会被移除。
        """

        self._send_timeout = send_timeout
        self._clients: set[EventWebSocket] = set()
        self._clients_lock = asyncio.Lock()
        self._broadcast_lock = asyncio.Lock()

    async def connect(self, websocket: EventWebSocket) -> None:
        """登记一个 WebSocket 客户端。

        Args:
            websocket: 已完成 accept 的 WebSocket 客户端。
        """

        async with self._clients_lock:
            self._clients.add(websocket)

    async def disconnect(self, websocket: EventWebSocket) -> None:
        """移除一个 WebSocket 客户端。

        Args:
            websocket: 需要移除的 WebSocket 客户端。
        """

        async with self._clients_lock:
            self._clients.discard(websocket)

    async def publish(self, event: Event) -> None:
        """广播一条运行时事件。

        Args:
            event: 待广播的运行时事件。
        """

        payload = {
            "type": "event",
            "event_type": event.type,
            "data": jsonable_encoder(event.data),
        }

        async with self._broadcast_lock:
            async with self._clients_lock:
                clients = list(self._clients)

            failed_clients: list[EventWebSocket] = []
            for websocket in clients:
                try:
                    await asyncio.wait_for(
                        websocket.send_json(payload),
                        timeout=self._send_timeout,
                    )
                except Exception as exc:
                    failed_clients.append(websocket)
                    logger.warning("WebSocket 事件广播失败: {}", exc)

            if failed_clients:
                async with self._clients_lock:
                    for websocket in failed_clients:
                        self._clients.discard(websocket)
