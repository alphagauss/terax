"""测试 Alpha WebSocket 事件广播工具。

锁定 JSON 编码、失败连接清理和慢客户端超时，广播器不直接订阅内部事件总线。
"""

from __future__ import annotations

import asyncio

from alpha.api.events import EventBroadcaster
from alpha.common.schema_core import EVENT_LOG
from alpha.common.schema_trade import LogData
from alpha.runtime.event import Event


class FakeWebSocket:
    """广播器测试用 WebSocket 替身。"""

    def __init__(self) -> None:
        self.messages: list[object] = []

    async def send_json(self, data: object) -> None:
        """记录广播消息。"""

        self.messages.append(data)


class FailingWebSocket:
    """会发送失败的 WebSocket 替身。"""

    def __init__(self) -> None:
        self.send_count = 0

    async def send_json(self, _data: object) -> None:
        """记录发送次数并模拟连接异常。"""

        self.send_count += 1
        raise RuntimeError("连接已断开")


class SlowWebSocket:
    """永不完成发送的慢客户端替身。"""

    def __init__(self) -> None:
        """初始化发送次数。"""

        self.send_count = 0

    async def send_json(self, _data: object) -> None:
        """模拟被网络背压永久阻塞的发送。"""

        self.send_count += 1
        await asyncio.Event().wait()


def test_event_broadcaster_should_send_jsonable_event() -> None:
    """验证广播器会把事件编码为 WebSocket 可发送的消息。"""

    async def scenario() -> None:
        broadcaster = EventBroadcaster()
        websocket = FakeWebSocket()

        await broadcaster.connect(websocket)
        await broadcaster.publish(
            Event(
                type=EVENT_LOG,
                data=LogData(msg="测试日志", gateway_name="策略引擎"),
            )
        )

        assert len(websocket.messages) == 1
        message = websocket.messages[0]
        assert isinstance(message, dict)
        assert message["type"] == "event"
        assert message["event_type"] == EVENT_LOG
        assert message["data"]["msg"] == "测试日志"
        assert message["data"]["gateway_name"] == "策略引擎"

    asyncio.run(scenario())


def test_event_broadcaster_should_remove_failed_clients() -> None:
    """验证发送失败的客户端会被移除，后续广播不会继续发送。"""

    async def scenario() -> None:
        broadcaster = EventBroadcaster()
        healthy_websocket = FakeWebSocket()
        failing_websocket = FailingWebSocket()
        event = Event(
            type=EVENT_LOG,
            data=LogData(msg="测试日志", gateway_name="策略引擎"),
        )

        await broadcaster.connect(healthy_websocket)
        await broadcaster.connect(failing_websocket)

        await broadcaster.publish(event)
        await broadcaster.publish(event)

        assert len(healthy_websocket.messages) == 2
        assert failing_websocket.send_count == 1

    asyncio.run(scenario())


def test_event_broadcaster_should_remove_slow_clients() -> None:
    """验证单个慢客户端不会永久阻塞后续广播。"""

    async def scenario() -> None:
        broadcaster = EventBroadcaster(send_timeout=0.01)
        healthy_websocket = FakeWebSocket()
        slow_websocket = SlowWebSocket()
        event = Event(
            type=EVENT_LOG,
            data=LogData(msg="测试日志", gateway_name="策略引擎"),
        )

        await broadcaster.connect(healthy_websocket)
        await broadcaster.connect(slow_websocket)

        await broadcaster.publish(event)
        await broadcaster.publish(event)

        assert len(healthy_websocket.messages) == 2
        assert slow_websocket.send_count == 1

    asyncio.run(scenario())
