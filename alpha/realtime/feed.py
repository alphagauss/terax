"""按活跃业务键管理上游行情租约的轻量 MarketFeed。

MarketFeed 只拥有 Provider 生命周期、引用计数、重复抑制和连接状态。它不保存
历史尾部、不管理 WebSocket、不生成 sequence，也不参与 HTTP 行情合并。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from loguru import logger

from alpha.realtime.eastmoney import EastmoneyRealtimeBarSource
from alpha.realtime.model import MarketDataKey, RealtimeBar
from alpha.runtime.event import Event, EventEngine
from alpha.runtime.event_types import EVENT_MARKET_BAR, EVENT_MARKET_STATUS

MAX_ACTIVE_MARKET_KEYS = 128
POLL_INTERVAL_SECONDS = 3.0


class MarketBarSource(Protocol):
    """行情 Provider 需要实现的最小异步接口。"""

    async def fetch(self, key: MarketDataKey) -> list[RealtimeBar]:
        """返回按时间升序排列的最近 K 线。"""

    async def close(self) -> None:
        """释放 Provider 连接。"""


@dataclass(slots=True)
class _FeedState:
    """单个行情键的最小运行状态。"""

    owners: set[str] = field(default_factory=set)
    task: asyncio.Task[None] | None = None
    latest: RealtimeBar | None = None
    failures: int = 0


class MarketFeed:
    """共享上游行情，并把变化发布为普通领域事件。"""

    def __init__(
        self,
        event_engine: EventEngine,
        *,
        source: MarketBarSource | None = None,
        poll_interval: float = POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        """创建没有任何活跃上游租约的行情引擎。"""

        self.event_engine = event_engine
        self._source = source
        self._poll_interval = poll_interval
        self._sleep = sleep
        self._states: dict[MarketDataKey, _FeedState] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    async def acquire(self, key: MarketDataKey, owner: str) -> None:
        """获取行情租约；同键首个 owner 启动唯一轮询任务。"""

        if not owner:
            raise ValueError("行情租约 owner 不能为空")
        replay: RealtimeBar | None = None
        async with self._lock:
            if self._closed:
                raise RuntimeError("行情引擎已关闭")
            state = self._states.get(key)
            if state is None:
                if len(self._states) >= MAX_ACTIVE_MARKET_KEYS:
                    raise ValueError("实时行情活跃数据键数量已达上限")
                state = _FeedState()
                self._states[key] = state
            state.owners.add(owner)
            replay = state.latest
            if state.task is None or state.task.done():
                state.task = asyncio.create_task(
                    self._poll(key),
                    name=f"alpha-market-{key.identifier()}",
                )
        # 新消费者复用既有上游时重发最后值，时间键幂等，无需维护事件历史。
        if replay is not None:
            self._publish_bar(key, replay, previous_final=False)

    async def release(self, key: MarketDataKey, owner: str) -> None:
        """释放行情租约；最后一个 owner 离开后取消轮询并删除状态。"""

        task: asyncio.Task[None] | None = None
        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            state.owners.discard(owner)
            if state.owners:
                return
            task = state.task
            self._states.pop(key, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def close(self) -> None:
        """取消全部行情任务并关闭共享 Provider。"""

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

    async def active_owner_count(self, key: MarketDataKey) -> int:
        """返回测试和诊断使用的当前租约数量。"""

        async with self._lock:
            state = self._states.get(key)
            return 0 if state is None else len(state.owners)

    async def _poll(self, key: MarketDataKey) -> None:
        """在租约存续期间串行读取单个行情键。"""

        try:
            while True:
                try:
                    source = await self._get_source()
                    bars = await source.fetch(key)
                    if not bars:
                        raise ValueError("实时行情源没有返回 K 线")
                    await self._apply_latest(key, max(bars, key=lambda bar: bar.time))
                    await self._publish_status(key, "live")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("实时行情读取失败 {}: {}", key, exc)
                    await self._record_failure(key)
                await self._sleep(self._poll_interval)
        except asyncio.CancelledError:
            return

    async def _get_source(self) -> MarketBarSource:
        """在首个租约需要读取时惰性创建共享 Provider。"""

        async with self._lock:
            if self._source is None:
                self._source = EastmoneyRealtimeBarSource()
            return self._source

    async def _apply_latest(self, key: MarketDataKey, latest: RealtimeBar) -> None:
        """只在最新 bar 前进或同时间内容变化时发布完整累计值。"""

        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            previous = state.latest
            if previous is not None and latest.time < previous.time:
                return
            state.latest = latest
            state.failures = 0
        if previous == latest:
            return
        self._publish_bar(
            key,
            latest,
            previous_final=previous is not None and latest.time > previous.time,
        )

    def _publish_bar(
        self,
        key: MarketDataKey,
        bar: RealtimeBar,
        *,
        previous_final: bool,
    ) -> None:
        """把 Provider bar 投递到统一 EventEngine。"""

        self.event_engine.put(
            Event(
                type=EVENT_MARKET_BAR,
                key=key.identifier(),
                data={
                    "key": key.wire(),
                    "bar": bar.wire(),
                    "is_final": False,
                    "previous_final": previous_final,
                    "volume_mode": "cumulative",
                },
            )
        )

    async def _publish_status(self, key: MarketDataKey, status: str) -> None:
        """发布不持久化的上游连接状态。"""

        async with self._lock:
            if key not in self._states:
                return
        self.event_engine.put(
            Event(
                type=EVENT_MARKET_STATUS,
                key=key.identifier(),
                data={"key": key.wire(), "status": status},
            )
        )

    async def _record_failure(self, key: MarketDataKey) -> None:
        """把连续失败转换为 delayed 或 disconnected 状态。"""

        async with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            state.failures += 1
            status = "disconnected" if state.failures >= 3 else "delayed"
        await self._publish_status(key, status)
