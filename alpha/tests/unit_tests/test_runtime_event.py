"""测试统一同步 EventEngine 的顺序、业务键过滤和订阅释放。"""

from __future__ import annotations

from threading import Event as ThreadEvent

from alpha.runtime.event import Event, EventEngine


def test_event_engine_dispatches_generic_keyed_and_general_handlers_in_order() -> None:
    """同一事件依次到达类型、精确键和全局处理器。"""

    engine = EventEngine(interval=60)
    received = ThreadEvent()
    values: list[str] = []

    def generic(_event: Event) -> None:
        values.append("generic")

    def keyed(_event: Event) -> None:
        values.append("keyed")

    def general(_event: Event) -> None:
        values.append("general")
        received.set()

    engine.sub("task.updated", generic)
    engine.sub("task.updated", keyed, key="bt-1")
    engine.sub_general(general)
    engine.start()
    try:
        engine.put(Event(type="task.updated", key="bt-1", data={"status": "running"}))
        assert received.wait(timeout=1)
    finally:
        engine.stop()

    assert values == ["generic", "keyed", "general"]


def test_event_engine_deduplicates_and_unsubscribes_exact_selector() -> None:
    """重复 callback 不重复调用，取消精确 selector 不影响通用订阅。"""

    engine = EventEngine(interval=60)
    received = ThreadEvent()
    values: list[str] = []

    def keyed(_event: Event) -> None:
        values.append("keyed")

    def generic(_event: Event) -> None:
        values.append("generic")
        received.set()

    engine.sub("market.bar", keyed, key="000001.SZSE|d|forward")
    engine.sub("market.bar", keyed, key="000001.SZSE|d|forward")
    engine.sub("market.bar", generic)
    engine.unsub("market.bar", keyed, key="000001.SZSE|d|forward")
    engine.start()
    try:
        engine.put(Event(type="market.bar", key="000001.SZSE|d|forward"))
        assert received.wait(timeout=1)
    finally:
        engine.stop()

    assert values == ["generic"]
