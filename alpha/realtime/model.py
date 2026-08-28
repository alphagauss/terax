"""公共实时行情的领域键和 K 线模型。

模型不依赖 FastAPI 或具体行情源，供订阅服务、HTTP 快照和协议路由共用。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from alpha.common.schema_core import split_vt_symbol

MarketInterval = Literal["1m", "1h", "d", "w"]
MarketAdjust = Literal["none", "forward", "backward"]


@dataclass(frozen=True, slots=True)
class MarketDataKey:
    """唯一标识一条实时行情订阅。"""

    vt_symbol: str
    interval: MarketInterval
    adjust: MarketAdjust

    def __post_init__(self) -> None:
        """在领域边界校验证券、周期和复权语义。"""

        split_vt_symbol(self.vt_symbol)
        if self.interval not in {"1m", "1h", "d", "w"}:
            raise ValueError(f"不支持的实时行情周期: {self.interval}")
        if self.adjust not in {"none", "forward", "backward"}:
            raise ValueError(f"不支持的实时行情复权方式: {self.adjust}")

    def wire(self) -> dict[str, str]:
        """返回公共 WebSocket 协议使用的数据键。"""

        return {
            "vt_symbol": self.vt_symbol,
            "interval": self.interval,
            "adjust": self.adjust,
        }


@dataclass(frozen=True, slots=True)
class RealtimeBar:
    """行情源返回的完整单根 K 线，数量字段使用累计语义。"""

    time: str
    open: float
    high: float
    low: float
    close: float
    volume: float | None
    amount: float | None
    open_interest: float | None = None

    def __post_init__(self) -> None:
        """拒绝无法安全进入公共行情协议的数值。"""

        prices = (self.open, self.high, self.low, self.close)
        if not self.time or not all(math.isfinite(value) for value in prices):
            raise ValueError("实时 K 线包含非法时间或价格")
        if self.high < max(prices) or self.low > min(prices):
            raise ValueError("实时 K 线 OHLC 关系非法")
        for value in (self.volume, self.amount, self.open_interest):
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError("实时 K 线数量字段非法")

    def wire(self) -> dict[str, float | str | None]:
        """返回与 `/bars` 单行一致的公共字段。"""

        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "amount": self.amount,
            "open_interest": self.open_interest,
        }
