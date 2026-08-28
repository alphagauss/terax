"""Alpha 市场元数据的交易所权威映射。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from zoneinfo import ZoneInfo

from alpha.common.schema_core import split_vt_symbol


@dataclass(frozen=True)
class MarketMetadata:
    """单个交易所影响图表展示的静态市场语义。"""

    timezone: ZoneInfo
    price_color_convention: Literal["up-red", "up-green"]
    volume_unit: str | None


_EXCHANGE_MARKET_METADATA = {
    "SSE": MarketMetadata(ZoneInfo("Asia/Shanghai"), "up-red", "share"),
    "SZSE": MarketMetadata(ZoneInfo("Asia/Shanghai"), "up-red", "share"),
    "BSE": MarketMetadata(ZoneInfo("Asia/Shanghai"), "up-red", "share"),
    "HKEX": MarketMetadata(ZoneInfo("Asia/Hong_Kong"), "up-red", "share"),
}


def get_market_metadata(vt_symbol: str) -> MarketMetadata:
    """按项目标准证券代码返回权威交易所展示语义。"""
    _, exchange = split_vt_symbol(vt_symbol)
    return _EXCHANGE_MARKET_METADATA[exchange]
