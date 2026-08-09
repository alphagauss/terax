"""Alpha API TTL 缓存的复用、强制刷新和并发不变量测试。"""

from __future__ import annotations

import asyncio

from alpha.api.cache import AsyncTtlCache


def test_async_ttl_cache_reuses_value_and_supports_forced_refresh() -> None:
    """验证有效缓存只加载一次，手动刷新会替换缓存内容。"""

    async def scenario() -> None:
        calls = 0
        cache: AsyncTtlCache[int] = AsyncTtlCache(ttl_seconds=60)

        async def loader() -> int:
            nonlocal calls
            calls += 1
            return calls

        assert await cache.get(loader) == 1
        assert await cache.get(loader) == 1
        assert await cache.get(loader, force_refresh=True) == 2
        assert await cache.get(loader) == 2
        assert calls == 2

    asyncio.run(scenario())


def test_async_ttl_cache_coalesces_concurrent_misses() -> None:
    """验证并发普通读取只执行一次底层聚合。"""

    async def scenario() -> None:
        calls = 0
        cache: AsyncTtlCache[int] = AsyncTtlCache(ttl_seconds=60)

        async def loader() -> int:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            return calls

        results = await asyncio.gather(*(cache.get(loader) for _ in range(4)))

        assert results == [1, 1, 1, 1]
        assert calls == 1

    asyncio.run(scenario())
