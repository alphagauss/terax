"""进程内共享的实时行情订阅服务。

服务按完整数据键引用计数，只在存在消费者时轮询上游，并以单调 sequence、
有界内存尾部和显式状态向 WebSocket 路由提供公共增量。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from loguru import logger

from alpha.realtime.eastmoney import EastmoneyRealtimeBarSource
from alpha.realtime.model import MarketDataKey, RealtimeBar

MAX_ACTIVE_MARKET_KEYS = 128
MAX_REALTIME_TAIL_BARS = 512
OUTBOUND_QUEUE_CAPACITY = 64
POLL_INTERVAL_SECONDS = 3.0

RealtimeMessage = dict[str, object]
RealtimeQueue = asyncio.Queue[RealtimeMessage]


class RealtimeBarSource(Protocol):
    """实时行情源需要满足的最小异步协议。"""

    async def fetch(self, key: MarketDataKey) -> list[RealtimeBar]:
        """返回按时间升序的最近 K 线。"""

    async def close(self) -> None:
        """释放行情源资源。"""


@dataclass(slots=True)
class _KeyState:
    """单个数据键的有界运行状态。"""

    sequence: int = 0
    bars: list[RealtimeBar] = field(default_factory=list)
    consumers: set[RealtimeQueue] = field(default_factory=set)
    task: asyncio.Task[None] | None = None
    failures: int = 0


class RealtimeMarketDataService:
    """共享实时行情源、sequence 和订阅引用计数。"""

    def __init__(
        self,
        *,
        source: RealtimeBarSource | None = None,
        poll_interval: float = POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        """创建尚未启动任何上游任务的服务。"""

        # 默认行情源在首个真实订阅时才创建，未启用实时功能不分配 HTTP 连接池。
        self._source = source
        self._poll_interval = poll_interval
        self._sleep = sleep
        self._states: dict[MarketDataKey, _KeyState] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    async def subscribe(self, key: MarketDataKey, queue: RealtimeQueue) -> int:
        """增加数据键引用，并返回当前 sequence。"""

        async with self._lock:
            if self._closed:
                raise RuntimeError("实时行情服务已关闭")
            state = self._states.get(key)
            if state is None:
                if len(self._states) >= MAX_ACTIVE_MARKET_KEYS:
                    raise ValueError("实时行情活跃数据键数量已达上限")
                state = _KeyState()
                self._states[key] = state
            state.consumers.add(queue)
            if state.task is None or state.task.done():
                state.task = asyncio.create_task(
                    self._poll(key),
                    name=f"alpha-market-{key.vt_symbol}-{key.interval}-{key.adjust}",
                )
            return state.sequence

    async def unsubscribe(self, key: MarketDataKey, queue: RealtimeQueue) -> None:
        """减少引用，最后一个消费者离开时停止并移除上游任务。"""

        task: asyncio.Task[None] | None = None
        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            state.consumers.discard(queue)
            if state.consumers:
                return
            task = state.task
            self._states.pop(key, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def snapshot(self, key: MarketDataKey) -> tuple[int, list[RealtimeBar]]:
        """原子读取当前 sequence 和有界实时尾部。"""

        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return 0, []
            return state.sequence, list(state.bars)

    async def close(self) -> None:
        """停止全部上游任务并释放行情源连接。"""

        async with self._lock:
            if self._closed:
                return
            self._closed = True
            tasks = [state.task for state in self._states.values() if state.task]
            self._states.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._source is not None:
            await self._source.close()

    async def _poll(self, key: MarketDataKey) -> None:
        """在引用存续期间串行读取单个数据键。"""

        try:
            while True:
                try:
                    source = await self._get_source()
                    bars = await source.fetch(key)
                    if not bars:
                        raise ValueError("实时行情源没有返回 K 线")
                    await self._apply_source_bars(key, bars)
                    await self._publish_status(key, "live")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("实时行情读取失败 {}: {}", key, exc)
                    await self._record_failure(key)
                await self._sleep(self._poll_interval)
        except asyncio.CancelledError:
            return

    async def _get_source(self) -> RealtimeBarSource:
        """在事件循环内惰性创建一次共享行情源。"""

        async with self._lock:
            if self._source is None:
                self._source = EastmoneyRealtimeBarSource()
            return self._source

    async def _apply_source_bars(
        self,
        key: MarketDataKey,
        incoming: list[RealtimeBar],
    ) -> None:
        """检测修订、替换和追加，并生成单调 sequence。"""

        messages: list[RealtimeMessage] = []
        consumers: list[RealtimeQueue] = []
        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            ordered = sorted(
                {bar.time: bar for bar in incoming}.values(), key=lambda bar: bar.time
            )
            if not ordered:
                return
            existing_by_time = {bar.time: bar for bar in state.bars}
            stable_revision = any(
                bar.time in existing_by_time
                and existing_by_time[bar.time] != bar
                and bar.time != ordered[-1].time
                for bar in ordered
            )
            time_regressed = bool(state.bars and ordered[-1].time < state.bars[-1].time)
            if stable_revision or time_regressed:
                state.sequence += 1
                state.bars = ordered[-MAX_REALTIME_TAIL_BARS:]
                messages.append(
                    {
                        "type": "bar_reset",
                        "version": 1,
                        "key": key.wire(),
                        "sequence": state.sequence,
                        "reason": "adjustment" if stable_revision else "source_reset",
                    }
                )
            else:
                previous_latest = state.bars[-1] if state.bars else None
                merged = {bar.time: bar for bar in state.bars}
                merged.update({bar.time: bar for bar in ordered})
                state.bars = sorted(merged.values(), key=lambda bar: bar.time)[
                    -MAX_REALTIME_TAIL_BARS:
                ]
                latest = state.bars[-1]
                if previous_latest != latest:
                    state.sequence += 1
                    messages.append(
                        {
                            "type": "bar",
                            "version": 1,
                            "key": key.wire(),
                            "sequence": state.sequence,
                            "bar": latest.wire(),
                            "is_final": False,
                            "previous_final": bool(
                                previous_latest and latest.time > previous_latest.time
                            ),
                            "volume_mode": "cumulative",
                        }
                    )
            state.failures = 0
            consumers = list(state.consumers)
        for message in messages:
            self._dispatch(consumers, key, message)

    async def _publish_status(self, key: MarketDataKey, status: str) -> None:
        """发布不参与 sequence 的上游连接状态。"""

        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            consumers = list(state.consumers)
        self._dispatch(
            consumers,
            key,
            {
                "type": "market_status",
                "version": 1,
                "key": key.wire(),
                "status": status,
            },
        )

    async def _record_failure(self, key: MarketDataKey) -> None:
        """累计读取失败并区分暂时延迟和持续断开。"""

        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            state.failures += 1
            status = "disconnected" if state.failures >= 3 else "delayed"
            consumers = list(state.consumers)
        self._dispatch(
            consumers,
            key,
            {
                "type": "market_status",
                "version": 1,
                "key": key.wire(),
                "status": status,
            },
        )

    @staticmethod
    def _dispatch(
        consumers: list[RealtimeQueue],
        key: MarketDataKey,
        message: RealtimeMessage,
    ) -> None:
        """无阻塞投递；慢客户端只保留一次明确的快照重校准要求。"""

        for queue in consumers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                while not queue.empty():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                queue.put_nowait(
                    {
                        "type": "resync_required",
                        "version": 1,
                        "key": key.wire(),
                    }
                )
