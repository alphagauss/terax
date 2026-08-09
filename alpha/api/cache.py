"""Alpha API 进程内的轻量异步 TTL 缓存。

缓存只减少重复的只读聚合，不参与业务状态持久化。调用方可以显式强制刷新，
所有重算通过同一异步锁串行，避免多个 Terax 窗口同时触发重复查询。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import Generic, TypeVar, cast

T = TypeVar("T")


class AsyncTtlCache(Generic[T]):
    """缓存单个异步计算结果，并允许调用方绕过有效期强制刷新。"""

    def __init__(self, ttl_seconds: float) -> None:
        """创建缓存，TTL 必须为正数。"""
        if ttl_seconds <= 0:
            raise ValueError("缓存 TTL 必须大于 0")
        self._ttl_seconds = ttl_seconds
        self._value: T | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def get(
        self,
        loader: Callable[[], Awaitable[T]],
        *,
        force_refresh: bool = False,
    ) -> T:
        """读取有效缓存，必要时串行执行加载函数并更新缓存。"""
        if not force_refresh and self._is_fresh():
            return cast(T, self._value)

        async with self._lock:
            if not force_refresh and self._is_fresh():
                return cast(T, self._value)
            value = await loader()
            self._value = value
            self._expires_at = monotonic() + self._ttl_seconds
            return value

    def clear(self) -> None:
        """立即清空缓存；后续普通读取会重新计算。"""
        self._value = None
        self._expires_at = 0.0

    def _is_fresh(self) -> bool:
        """判断缓存是否包含尚未过期的值。"""
        return self._value is not None and monotonic() < self._expires_at
