"""测试共享实时行情服务。

锁定完整数据键隔离、最后引用释放、单调 sequence、重复抑制、bar final 和修订重校准。
"""

from __future__ import annotations

import asyncio

from alpha.realtime.market_data import RealtimeMarketDataService, RealtimeQueue
from alpha.realtime.model import MarketDataKey, RealtimeBar


class FakeSource:
    """由测试逐次投递结果的可控行情源。"""

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
        """记录连接池已经关闭。"""

        self.closed = True


def _bar(time: str, close: float, volume: float = 10) -> RealtimeBar:
    """创建 OHLC 关系合法的测试 K 线。"""

    return RealtimeBar(
        time=time,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=volume,
        amount=volume * close,
    )


async def _receive_type(queue: RealtimeQueue, message_type: str) -> dict[str, object]:
    """有界等待指定消息，忽略同轮状态消息。"""

    while True:
        message = await asyncio.wait_for(queue.get(), timeout=1)
        if message.get("type") == message_type:
            return message


def test_market_data_service_shares_key_and_releases_last_consumer() -> None:
    """同一键只有一个轮询任务，最后消费者释放后删除快照。"""

    async def scenario() -> None:
        source = FakeSource()
        service = RealtimeMarketDataService(source=source, poll_interval=60)
        key = MarketDataKey("000001.SZSE", "d", "forward")
        first: RealtimeQueue = RealtimeQueue(maxsize=8)
        second: RealtimeQueue = RealtimeQueue(maxsize=8)
        await service.subscribe(key, first)
        await service.subscribe(key, second)
        await source.results.put([_bar("2026-08-28", 11.65)])

        assert (await _receive_type(first, "bar"))["sequence"] == 1
        assert (await _receive_type(second, "bar"))["sequence"] == 1
        assert source.fetch_count == 1

        await service.unsubscribe(key, first)
        assert (await service.snapshot(key))[0] == 1
        await service.unsubscribe(key, second)
        assert await service.snapshot(key) == (0, [])
        await service.close()
        assert source.closed is True

    asyncio.run(scenario())


def test_market_data_service_sequences_replace_append_and_reset() -> None:
    """重复批次不发增量，替换、追加和历史修订严格递增 sequence。"""

    async def scenario() -> None:
        source = FakeSource()
        service = RealtimeMarketDataService(source=source, poll_interval=0)
        key = MarketDataKey("000001.SZSE", "d", "none")
        queue: RealtimeQueue = RealtimeQueue(maxsize=16)
        await service.subscribe(key, queue)

        previous = _bar("2026-08-27", 11.59)
        current = _bar("2026-08-28", 11.60)
        await source.results.put([previous, current])
        first = await _receive_type(queue, "bar")
        assert first["sequence"] == 1
        assert first["previous_final"] is False
        assert first["volume_mode"] == "cumulative"

        await source.results.put([previous, current])
        await asyncio.sleep(0)
        replacement = _bar("2026-08-28", 11.65, 12)
        await source.results.put([previous, replacement])
        assert (await _receive_type(queue, "bar"))["sequence"] == 2

        next_bar = _bar("2026-08-29", 11.70)
        await source.results.put([replacement, next_bar])
        appended = await _receive_type(queue, "bar")
        assert appended["sequence"] == 3
        assert appended["previous_final"] is True

        revised = _bar("2026-08-28", 5.82)
        await source.results.put([revised, next_bar])
        reset = await _receive_type(queue, "bar_reset")
        assert reset["sequence"] == 4
        assert reset["reason"] == "adjustment"
        sequence, bars = await service.snapshot(key)
        assert sequence == 4
        assert bars == [revised, next_bar]
        await service.close()

    asyncio.run(scenario())
