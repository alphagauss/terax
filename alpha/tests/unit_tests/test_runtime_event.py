from __future__ import annotations

import asyncio
from threading import Event as ThreadingEvent

from alpha.runtime.event import Event, EventEngine
from alpha.utils import SingletonMeta


def _fresh_event_engine() -> EventEngine:
    """创建不受单例缓存影响的事件引擎。"""

    SingletonMeta._instances.pop(EventEngine, None)
    return EventEngine(interval=1)


def test_event_engine_should_dispatch_async_handler_on_bound_loop() -> None:
    """验证事件引擎可以把异步处理器调度到指定事件循环。"""

    async def scenario() -> None:
        engine = _fresh_event_engine()
        received = asyncio.Event()
        values: list[str] = []

        async def handler(event: Event) -> None:
            values.append(str(event.data))
            received.set()

        engine.sub("test", handler)
        engine.start(asyncio.get_running_loop())
        try:
            engine.put(Event(type="test", data="ok"))
            await asyncio.wait_for(received.wait(), timeout=1.0)
        finally:
            engine.stop()

        assert values == ["ok"]

    asyncio.run(scenario())


def test_event_engine_should_deduplicate_and_unsubscribe_handlers() -> None:
    """验证普通订阅会去重，取消订阅后仍保留全局处理器。"""

    engine = _fresh_event_engine()
    received = ThreadingEvent()
    values: list[tuple[str, str]] = []

    def typed_handler(event: Event) -> None:
        values.append(("typed", str(event.data)))

    def general_handler(event: Event) -> None:
        values.append(("general", str(event.data)))
        received.set()

    engine.sub("test", typed_handler)
    engine.sub("test", typed_handler)
    engine.sub_general(general_handler)
    engine.start()
    try:
        engine.put(Event(type="test", data="one"))
        assert received.wait(timeout=1.0) is True
        assert values == [("typed", "one"), ("general", "one")]

        received.clear()
        engine.unsub("test", typed_handler)
        engine.put(Event(type="test", data="two"))

        assert received.wait(timeout=1.0) is True
        assert values == [
            ("typed", "one"),
            ("general", "one"),
            ("general", "two"),
        ]
    finally:
        engine.stop()
