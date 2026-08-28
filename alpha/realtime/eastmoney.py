"""东方财富公共接口的轻量实时 K 线源。

只按当前活跃的完整数据键读取最近两根 K 线，不加载 pandas，也不维护持久状态。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from alpha.common.market_metadata import get_market_metadata
from alpha.common.schema_core import split_vt_symbol
from alpha.realtime.model import MarketDataKey, RealtimeBar

_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
_INTERVAL_CODES = {"1m": "1", "1h": "60", "d": "101", "w": "102"}
_ADJUST_CODES = {"none": "0", "forward": "1", "backward": "2"}
_MARKET_CODES = {"SSE": "1", "SZSE": "0", "BSE": "0", "HKEX": "116"}


class EastmoneyRealtimeBarSource:
    """按需读取单数据键最近两根完整 K 线。"""

    def __init__(
        self,
        *,
        timeout_seconds: float = 10.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        """创建复用连接池的轻量 HTTP 客户端。"""

        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds,
            headers={
                "Accept": "application/json",
                "User-Agent": "Terax Alpha market-data/1",
            },
        )

    async def fetch(self, key: MarketDataKey) -> list[RealtimeBar]:
        """读取并严格归一化最近两根 K 线。"""

        symbol, exchange = split_vt_symbol(key.vt_symbol)
        market_code = _MARKET_CODES.get(exchange)
        if market_code is None:
            raise ValueError(f"实时行情源不支持交易所: {exchange}")
        response = await self._client.get(
            _KLINE_URL,
            params={
                "secid": f"{market_code}.{symbol}",
                "fields1": "f1,f2,f3,f4,f5,f6",
                "fields2": "f51,f52,f53,f54,f55,f56,f57",
                "klt": _INTERVAL_CODES[key.interval],
                "fqt": _ADJUST_CODES[key.adjust],
                "lmt": "2",
                "end": "20500000",
                "ut": "7eea3edcaed734bea9cbfc24409ed989",
            },
        )
        response.raise_for_status()
        payload: Any = response.json()
        lines = (
            ((payload.get("data") or {}).get("klines") or [])
            if isinstance(payload, dict)
            else []
        )
        if not isinstance(lines, list):
            raise ValueError("实时行情源返回了非法 K 线列表")
        return [self._parse_line(str(line), key) for line in lines[-2:]]

    async def close(self) -> None:
        """释放共享 HTTP 连接池。"""

        await self._client.aclose()

    @staticmethod
    def _parse_line(line: str, key: MarketDataKey) -> RealtimeBar:
        """把行情源逗号行转换为公共 K 线。"""

        fields = line.split(",")
        if len(fields) < 7:
            raise ValueError("实时行情源返回了不完整 K 线")
        raw_time, raw_open, raw_close, raw_high, raw_low, raw_volume, raw_amount = (
            fields[:7]
        )
        if key.interval in {"d", "w"}:
            wire_time = raw_time[:10]
        else:
            parsed = datetime.fromisoformat(raw_time)
            timezone = get_market_metadata(key.vt_symbol).timezone
            wire_time = parsed.replace(tzinfo=timezone).isoformat()
        return RealtimeBar(
            time=wire_time,
            open=float(raw_open),
            high=float(raw_high),
            low=float(raw_low),
            close=float(raw_close),
            volume=float(raw_volume),
            amount=float(raw_amount),
        )
