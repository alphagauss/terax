from __future__ import annotations

import asyncio
from datetime import date

import pandas as pd

from alpha.sync_tasks import gm_async
from alpha.sync_tasks.gm_async import GmAsyncProvider
from alpha.sync_tasks.planners import build_bar_sync_plans, split_bar_sync_plans_by_year
from alpha.sync_tasks.validators import validate_overlap_rows
from alpha.sync_tasks.writers import flush_security_sync_buffers, flush_year_buffer
from conftest import FakeBarDb, FakeSecurityDb, sample_security


def test_flush_security_sync_buffers_persists_rows_and_clears_buffers() -> None:
    fake_db = FakeSecurityDb()
    rows = [{"vt_symbol": "600000.SSE", "asset_type": "stock"}]
    result = asyncio.run(
        flush_security_sync_buffers(
            fake_db,
            profile_rows=rows,
            suspended_events=[],
            st_events=[],
            adjust_factor_rows=[],
            limit_bar_rows=[],
            status_meta_map={"600000.SSE": "2025-01-02"},
        )
    )
    assert result["profiles"] == 1
    assert rows == []


def test_flush_year_buffer_writes_rows_and_clears_buffer() -> None:
    fake_bar_db = FakeBarDb()
    year_rows = [{"vt_symbol": "600000.SSE", "datetime": "2025-01-02 00:00:00"}]

    assert asyncio.run(flush_year_buffer(fake_bar_db, year_rows)) == 1
    assert fake_bar_db.saved_rows
    assert year_rows == []


def test_validate_overlap_rows_detects_differences() -> None:
    fake_db = FakeBarDb()
    fake_db.overlap_rows["600000.SSE"] = [
        {
            "vt_symbol": "600000.SSE",
            "datetime": "2025-01-02 00:00:00",
            "open": 10.0,
            "high": 10.0,
            "low": 10.0,
            "close": 10.0,
            "volume": 100.0,
            "turnover": 1000.0,
        }
    ]
    plan = split_bar_sync_plans_by_year(
        build_bar_sync_plans(
            [sample_security()],
            {
                "600000.SSE": {
                    "vt_symbol": "600000.SSE",
                    "interval": "d",
                    "start": "2025-01-02 00:00:00",
                    "end": "2025-01-02 00:00:00",
                    "count": 1,
                    "updated_at": "2025-01-02 00:00:00",
                }
            },
            [date(2005, 1, 4), date(2025, 1, 2), date(2025, 1, 3)],
            date(2025, 1, 3),
            overlap_validation_days=1,
        ),
        [date(2005, 1, 4), date(2025, 1, 2), date(2025, 1, 3)],
    )[0]
    issues = asyncio.run(
        validate_overlap_rows(
            fake_db,
            plan,
            [
                {
                    "vt_symbol": "600000.SSE",
                    "datetime": "2025-01-02 00:00:00",
                    "open": 11.0,
                    "high": 10.0,
                    "low": 10.0,
                    "close": 10.0,
                    "volume": 100.0,
                    "turnover": 1000.0,
                }
            ],
        )
    )
    assert len(issues) == 1


def test_gm_async_provider_calls_underlying_module(monkeypatch) -> None:
    calls: dict[str, object] = {}

    class FakeGmModule:
        ADJUST_NONE = "none"

        async def history(self, **kwargs):
            calls["history"] = kwargs
            return pd.DataFrame(
                [
                    {
                        "symbol": "SHSE.600000",
                        "eob": "2025-01-02 15:00:00",
                        "open": 10.0,
                        "high": 11.0,
                        "low": 9.5,
                        "close": 10.5,
                        "volume": 1000,
                        "amount": 2000,
                    }
                ]
            )

        async def get_history_symbol(self, **kwargs):
            calls["history_symbol"] = kwargs
            return pd.DataFrame(
                [
                    {
                        "symbol": "SHSE.600000",
                        "sec_type1": 1010,
                        "trade_date": "2025-01-02",
                        "price_tick": 0.01,
                        "trade_n": 1,
                        "listed_date": "2000-01-01",
                        "delisted_date": None,
                        "is_suspended": 0,
                        "is_st": 0,
                        "adj_factor": 1.1,
                        "upper_limit": 11.0,
                        "lower_limit": 9.0,
                    }
                ]
            )

        async def get_symbols(self, **kwargs):
            calls["symbols"] = kwargs
            return pd.DataFrame(
                [
                    {
                        "symbol": "SHSE.600000",
                        "board": 10100101,
                        "sec_name": "浦发银行",
                        "sec_abbr": "PFYH",
                        "price_tick": 0.01,
                        "trade_n": 1,
                        "listed_date": "2000-01-01",
                        "delisted_date": None,
                        "is_suspended": 0,
                        "is_st": 0,
                        "adj_factor": 1.2,
                        "upper_limit": 11.0,
                        "lower_limit": 9.0,
                    }
                ]
            )

        async def stk_get_index_constituents(self, **kwargs):
            calls["index_constituents"] = kwargs
            return pd.DataFrame([{"symbol": "SHSE.600000"}])

        async def get_trading_dates_by_year(self, exchange, start_year, end_year):
            calls["trading_dates"] = (exchange, start_year, end_year)
            return []

        async def get_symbol_infos(self, **kwargs):
            calls["symbol_infos"] = kwargs
            return pd.DataFrame(
                [
                    {
                        "symbol": "SHSE.600000",
                        "board": 10100101,
                        "sec_name": "浦发银行",
                        "sec_abbr": "PFYH",
                        "price_tick": 0.01,
                        "trade_n": 1,
                        "listed_date": "2000-01-01",
                        "delisted_date": None,
                    }
                ]
            )

    provider = GmAsyncProvider()
    monkeypatch.setattr(gm_async, "_get_gm", lambda: FakeGmModule())

    history_df = asyncio.run(provider.fetch_history(["SHSE.600000"], date(2025, 1, 2), date(2025, 1, 2), "symbol"))
    history_symbol_df = asyncio.run(provider.fetch_history_symbol("SHSE.600000", date(2025, 1, 2), date(2025, 1, 2)))
    snapshot_df = asyncio.run(provider.fetch_symbols_snapshot("stock", date(2025, 1, 2)))
    asyncio.run(provider.fetch_index_constituents("SHSE.000001", date(2025, 1, 2)))
    symbol_infos_df = asyncio.run(provider.fetch_symbol_infos("stock"))

    assert calls["history"]["symbol"] == "SHSE.600000"
    assert history_df.to_dict(orient="records") == [
        {
            "vt_symbol": "600000.SSE",
            "symbol": "600000",
            "exchange": "SSE",
            "datetime": "2025-01-02 00:00:00",
            "interval": "d",
            "adjust": "non",
            "volume": 1000.0,
            "open": 10.0,
            "high": 11.0,
            "low": 9.5,
            "close": 10.5,
            "turnover": 2000.0,
            "open_interest": 0.0,
        }
    ]
    assert calls["history_symbol"]["symbol"] == "SHSE.600000"
    assert history_symbol_df.to_dict(orient="records") == [
        {
            "gm_symbol": "SHSE.600000",
            "vt_symbol": "600000.SSE",
            "asset_type": "stock",
            "trade_date": "2025-01-02",
            "board": None,
            "sec_name": None,
            "sec_abbr": None,
            "price_tick": 0.01,
            "trade_n": 1.0,
            "listed_date": "2000-01-01",
            "delisted_date": None,
            "is_suspended": False,
            "is_st": False,
            "adj_factor": 1.1,
            "upper_limit": 11.0,
            "lower_limit": 9.0,
        }
    ]
    assert calls["symbols"]["sec_type1"] == 1010
    assert snapshot_df.to_dict(orient="records") == [
        {
            "gm_symbol": "SHSE.600000",
            "vt_symbol": "600000.SSE",
            "asset_type": "stock",
            "trade_date": "2025-01-02",
            "board": 10100101,
            "sec_name": "浦发银行",
            "sec_abbr": "PFYH",
            "price_tick": 0.01,
            "trade_n": 1.0,
            "listed_date": "2000-01-01",
            "delisted_date": None,
            "is_suspended": False,
            "is_st": False,
            "adj_factor": 1.2,
            "upper_limit": 11.0,
            "lower_limit": 9.0,
        }
    ]
    assert calls["index_constituents"]["index"] == "SHSE.000001"
    assert symbol_infos_df.to_dict(orient="records") == [
        {
            "gm_symbol": "SHSE.600000",
            "vt_symbol": "600000.SSE",
            "asset_type": "stock",
            "trade_date": None,
            "board": 10100101,
            "sec_name": "浦发银行",
            "sec_abbr": "PFYH",
            "price_tick": 0.01,
            "trade_n": 1.0,
            "listed_date": "2000-01-01",
            "delisted_date": None,
            "is_suspended": None,
            "is_st": None,
            "adj_factor": None,
            "upper_limit": None,
            "lower_limit": None,
        }
    ]
