from __future__ import annotations

import asyncio
import os
from datetime import date

import pandas as pd
import pytest

from alpha.sync_tasks.gm_async import GmAsyncProvider
from alpha.sync_tasks.models import SecurityInfo
from alpha.sync_tasks.tasks.security_sync import SecuritySyncTask


RUN_GM_LIVE_ENV = "RUN_GM_LIVE_INTEGRATION"
HISTORY_FIELDS = "symbol,eob,open,high,low,close,volume,amount"


class FakeSecurityDb:
    """用于 live smoke 的内存假数据库。"""

    def __init__(self, initial_meta_map: dict[str, str]) -> None:
        self.initial_meta_map = initial_meta_map
        self.saved_profiles: list[dict[str, object]] = []
        self.saved_suspended_events: list[dict[str, object]] = []
        self.saved_st_events: list[dict[str, object]] = []
        self.saved_adjust_factors: list[dict[str, object]] = []
        self.saved_limit_bar_rows: list[dict[str, object]] = []
        self.saved_status_meta_rows: list[dict[str, object]] = []

    async def load_security_status_metas(self) -> dict[str, dict[str, object]]:
        return {
            vt_symbol: {
                "vt_symbol": vt_symbol,
                "latest_checked_trade_date": latest_checked_trade_date,
                "latest_data_trade_date": latest_checked_trade_date,
                "is_terminal": False,
                "updated_at": "2026-04-21 00:00:00",
            }
            for vt_symbol, latest_checked_trade_date in self.initial_meta_map.items()
        }

    async def save_security_profiles(self, rows: list[dict[str, object]]) -> bool:
        self.saved_profiles.extend(rows)
        return True

    async def save_suspended_day_events(self, rows: list[dict[str, object]]) -> bool:
        self.saved_suspended_events.extend(rows)
        return True

    async def save_st_day_events(self, rows: list[dict[str, object]]) -> bool:
        self.saved_st_events.extend(rows)
        return True

    async def save_adjust_factors(self, rows: list[dict[str, object]]) -> bool:
        self.saved_adjust_factors.extend(rows)
        return True

    async def save_bar_data(self, rows: list[dict[str, object]], *, adjust: str, update_overview: bool) -> bool:
        self.saved_limit_bar_rows.extend(rows)
        return True

    async def save_security_status_metas(self, rows: list[dict[str, object]]) -> bool:
        self.saved_status_meta_rows.extend(rows)
        return True

    async def close(self) -> None:
        return None


def _build_sample_securities() -> list[SecurityInfo]:
    return [
        SecurityInfo("stock", "SZSE.000001", "SZSE", "000001", "SZSE", "000001.SZSE", date(1991, 4, 3), None),
        SecurityInfo("etf", "SHSE.510300", "SHSE", "510300", "SSE", "510300.SSE", date(2012, 5, 28), None),
        SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None),
    ]


@pytest.mark.skipif(
    os.environ.get(RUN_GM_LIVE_ENV) != "1",
    reason=f"live GM 集成测试默认跳过，运行前请设置 {RUN_GM_LIVE_ENV}=1",
)
def test_gm_provider_live_smoke() -> None:
    provider = GmAsyncProvider()
    history_df = asyncio.run(provider.fetch_history(["SHSE.000001"], date.today(), date.today(), HISTORY_FIELDS))
    symbol_df = asyncio.run(provider.fetch_history_symbol("SHSE.000001", date.today(), date.today()))
    assert isinstance(history_df, pd.DataFrame)
    assert isinstance(symbol_df, pd.DataFrame)


@pytest.mark.skipif(
    os.environ.get(RUN_GM_LIVE_ENV) != "1",
    reason=f"live GM 集成测试默认跳过，运行前请设置 {RUN_GM_LIVE_ENV}=1",
)
def test_security_sync_task_live_smoke() -> None:
    provider = GmAsyncProvider()
    securities = _build_sample_securities()
    raw_trade_dates = asyncio.run(provider.fetch_trading_dates("SHSE", date.today().year, date.today().year))
    trade_dates = sorted(pd.Timestamp(item).date() for item in raw_trade_dates)
    target_trade_date = trade_dates[-1]
    fake_db = FakeSecurityDb({item.vt_symbol: trade_dates[-2].isoformat() for item in securities})

    task = SecuritySyncTask(
        provider,
        db_factory=lambda: fake_db,
        trade_dates_loader=lambda: trade_dates,
        universe_loader=lambda: securities,
    )
    result = asyncio.run(task.run_by_date(target_trade_date=target_trade_date))
    assert result["mode"] == "by_date"
    assert result["processed_trade_date_count"] == 1
    assert fake_db.saved_status_meta_rows
