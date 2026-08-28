"""测试轻量东方财富实时 K 线源。

锁定交易所、周期、复权参数以及盘中时间的交易所偏移归一化，不访问外部网络。
"""

from __future__ import annotations

import asyncio

import httpx

from alpha.realtime.eastmoney import EastmoneyRealtimeBarSource
from alpha.realtime.model import MarketDataKey


def test_eastmoney_realtime_source_uses_complete_market_key() -> None:
    """完整数据键分别决定 secid、klt 和 fqt，响应保持升序。"""

    async def scenario() -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "data": {
                        "klines": [
                            "2026-08-28 14:00,11.60,11.64,11.68,11.58,100,1164",
                            "2026-08-28 15:00,11.64,11.65,11.66,11.63,120,1398",
                        ]
                    }
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        source = EastmoneyRealtimeBarSource(client=client)
        try:
            bars = await source.fetch(MarketDataKey("000001.SZSE", "1h", "backward"))
        finally:
            await source.close()

        assert len(bars) == 2
        assert bars[-1].time == "2026-08-28T15:00:00+08:00"
        assert bars[-1].close == 11.65
        params = requests[0].url.params
        assert params["secid"] == "0.000001"
        assert params["klt"] == "60"
        assert params["fqt"] == "2"
        assert params["lmt"] == "2"

    asyncio.run(scenario())
