"""测试轻量 MarketFeed 的租约、重复抑制和公共事件发布。"""

from __future__ import annotations

import asyncio
from queue import Queue

from alpha.realtime.feed import MarketFeed
from alpha.realtime.model import MarketDataKey, RealtimeBar
from alpha.runtime.event import Event, EventEngine
from alpha.runtime.event_types import EVENT_MARKET_BAR, EVENT_MARKET_STATUS


class FakeSource:
    """由测试控制每次 fetch 结果的行情源。"""

    def __init__(self) -> None:
        self.results: asyncio.Queue[list[RealtimeBar] | Exception] = asyncio.Queue()
        self.fetch_count = 0
        self.closed = False

    async def fetch(self, _key: MarketDataKey) -> list[RealtimeBar]:
        """等待下一批测试结果。"""

        self.fetch_count += 1
        result = await self.results.get()
        if isinstance(result, Exception):
            raise result
        return result

    async def close(self) -> None:
        """记录 Provider 已关闭。"""

        self.closed = True


def _bar(time: str, close: float, volume: float = 10) -> RealtimeBar:
    """创建合法累计 K 线。"""

    return RealtimeBar(
        time=time,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=volume,
        amount=volume * close,
    )


def test_market_feed_shares_upstream_and_stops_after_last_owner() -> None:
    """同键多个 owner 共用轮询，最后租约释放后删除全部运行状态。"""

    async def scenario() -> None:
        engine = EventEngine(interval=60)
        source = FakeSource()
        feed = MarketFeed(engine, source=source, poll_interval=60)
        key = MarketDataKey("000001.SZSE", "d", "forward")
        events: Queue[Event] = Queue()
        engine.sub(EVENT_MARKET_BAR, events.put)
        engine.start()
        try:
            await feed.acquire(key, "chart-1")
            await feed.acquire(key, "paper-1")
            await source.results.put([_bar("2026-08-28", 11.65)])
            event = await asyncio.to_thread(events.get, True, 1)

            assert event.key == key.identifier()
            assert event.data["bar"]["close"] == 11.65
            assert source.fetch_count == 1
            assert await feed.active_owner_count(key) == 2

            await feed.release(key, "chart-1")
            assert await feed.active_owner_count(key) == 1
            await feed.release(key, "paper-1")
            assert await feed.active_owner_count(key) == 0
        finally:
            await feed.close()
            engine.stop()
        assert source.closed

    asyncio.run(scenario())


def test_market_feed_only_publishes_changed_latest_bar_and_failure_status() -> None:
    """重复最新值不发 bar，读取失败通过 market.status 表达。"""

    async def scenario() -> None:
        engine = EventEngine(interval=60)
        source = FakeSource()
        feed = MarketFeed(engine, source=source, poll_interval=0)
        key = MarketDataKey("000001.SZSE", "d", "none")
        bars: Queue[Event] = Queue()
        statuses: Queue[Event] = Queue()
        engine.sub(EVENT_MARKET_BAR, bars.put)
        engine.sub(EVENT_MARKET_STATUS, statuses.put)
        engine.start()
        try:
            await feed.acquire(key, "chart")
            current = _bar("2026-08-28", 11.60)
            await source.results.put([current])
            bar_event = await asyncio.to_thread(bars.get, True, 1)
            assert bar_event.data["bar"]["close"] == 11.60
            assert (await asyncio.to_thread(statuses.get, True, 1)).data[
                "status"
            ] == "live"

            await source.results.put([current])
            assert (await asyncio.to_thread(statuses.get, True, 1)).data[
                "status"
            ] == "live"
            assert bars.empty()

            await source.results.put(RuntimeError("upstream down"))
            status_event = await asyncio.to_thread(statuses.get, True, 1)
            assert status_event.data["status"] == "delayed"
        finally:
            await feed.close()
            engine.stop()

    asyncio.run(scenario())


def test_market_feed_ignores_bar_older_than_published_latest() -> None:
    """上游短暂回退不能破坏最新值去重状态或向前端发布迟到 bar。"""

    async def scenario() -> None:
        engine = EventEngine(interval=60)
        source = FakeSource()
        feed = MarketFeed(engine, source=source, poll_interval=0)
        key = MarketDataKey("000001.SZSE", "d", "none")
        bars: Queue[Event] = Queue()
        engine.sub(EVENT_MARKET_BAR, bars.put)
        engine.start()
        try:
            current = _bar("2026-08-28", 11.60)
            await feed.acquire(key, "chart")
            await source.results.put([current])
            assert (await asyncio.to_thread(bars.get, True, 1)).data["bar"][
                "time"
            ] == "2026-08-28"

            await source.results.put([_bar("2026-08-27", 11.50)])
            await asyncio.sleep(0.01)
            assert bars.empty()

            await source.results.put([current])
            await asyncio.sleep(0.01)
            assert bars.empty()
        finally:
            await feed.close()
            engine.stop()

    asyncio.run(scenario())
