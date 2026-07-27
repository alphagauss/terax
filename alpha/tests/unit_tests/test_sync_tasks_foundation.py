from __future__ import annotations

from datetime import date, datetime

import pandas as pd

from alpha.sync_tasks.calendar import get_latest_target_trade_date
from alpha.sync_tasks.universe import convert_gm_symbol_to_vt_symbol, load_symbol_universe_from_csv, map_gm_exchange_to_db_exchange


def test_map_gm_exchange_to_db_exchange() -> None:
    assert map_gm_exchange_to_db_exchange("SHSE") == "SSE"
    assert map_gm_exchange_to_db_exchange("SZSE") == "SZSE"
    assert map_gm_exchange_to_db_exchange("BJSE") == "BSE"


def test_get_latest_target_trade_date_before_and_after_cutoff() -> None:
    trade_dates = [date(2026, 4, 7), date(2026, 4, 8), date(2026, 4, 9)]
    assert get_latest_target_trade_date(trade_dates, datetime(2026, 4, 9, 19, 30, 0)) == date(2026, 4, 8)
    assert get_latest_target_trade_date(trade_dates, datetime(2026, 4, 9, 20, 30, 0)) == date(2026, 4, 9)


def test_load_symbol_universe_preserves_leading_zeros_in_sec_id(monkeypatch) -> None:
    from alpha.sync_tasks import universe

    monkeypatch.setattr(
        universe.csvdb,
        "get_a_share_infos",
        lambda: {
            "gm_a_share_stock_infos": pd.DataFrame(
                [{"symbol": "SZSE.000001", "exchange": "SZSE", "sec_id": 1, "listed_date": "1991-04-03", "delisted_date": None}]
            ),
            "gm_a_share_etf_infos": pd.DataFrame(columns=["symbol", "exchange", "sec_id", "listed_date", "delisted_date"]),
            "gm_a_share_idx_infos": pd.DataFrame(columns=["symbol", "exchange", "sec_id", "listed_date", "delisted_date"]),
        },
    )

    universe_rows = load_symbol_universe_from_csv()
    assert len(universe_rows) == 1
    assert universe_rows[0].sec_id == "000001"
    assert universe_rows[0].vt_symbol == "000001.SZSE"


def test_load_symbol_universe_supports_standardized_csv_columns(monkeypatch) -> None:
    from alpha.sync_tasks import universe

    monkeypatch.setattr(
        universe.csvdb,
        "get_a_share_infos",
        lambda: {
            "gm_a_share_stock_infos": pd.DataFrame(
                [
                    {
                        "gm_symbol": "SHSE.600000",
                        "vt_symbol": "600000.SSE",
                        "asset_type": "stock",
                        "listed_date": "1999-11-10",
                        "delisted_date": None,
                    }
                ]
            ),
            "gm_a_share_etf_infos": pd.DataFrame(columns=["gm_symbol", "vt_symbol", "listed_date", "delisted_date"]),
            "gm_a_share_idx_infos": pd.DataFrame(columns=["gm_symbol", "vt_symbol", "listed_date", "delisted_date"]),
        },
    )

    universe_rows = load_symbol_universe_from_csv()
    assert len(universe_rows) == 1
    assert universe_rows[0].gm_symbol == "SHSE.600000"
    assert universe_rows[0].gm_exchange == "SHSE"
    assert universe_rows[0].sec_id == "600000"
    assert universe_rows[0].vt_symbol == "600000.SSE"


def test_convert_gm_symbol_to_vt_symbol() -> None:
    assert convert_gm_symbol_to_vt_symbol("SHSE.600000") == "600000.SSE"
