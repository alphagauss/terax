from __future__ import annotations

from datetime import date

from alpha.sync_tasks.planners import (
    build_bar_sync_plans,
    build_full_security_sync_plans,
    build_incremental_trade_dates,
    build_index_constituent_sync_plans,
    chunk_bar_sync_plans,
    chunk_year_plans,
    split_bar_sync_plans_by_year,
)
from conftest import sample_security


def test_build_bar_sync_plans_uses_overlap_window() -> None:
    trade_dates = [
        date(2005, 1, 4),
        date(2026, 2, 2),
        date(2026, 2, 3),
        date(2026, 2, 4),
        date(2026, 2, 5),
        date(2026, 2, 6),
        date(2026, 3, 2),
        date(2026, 3, 3),
        date(2026, 3, 4),
        date(2026, 3, 5),
        date(2026, 3, 6),
        date(2026, 4, 8),
        date(2026, 4, 9),
    ]
    security = sample_security()
    overview_map = {
        "600000.SSE": {
            "vt_symbol": "600000.SSE",
            "interval": "d",
            "start": "2005-01-04 00:00:00",
            "end": "2026-03-06 00:00:00",
            "count": 1,
            "updated_at": "2026-03-18 17:47:31",
        }
    }

    plans = build_bar_sync_plans([security], overview_map, trade_dates, date(2026, 4, 9), overlap_validation_days=30)
    assert len(plans) == 1
    assert plans[0].start_date == date(2026, 2, 4)
    assert plans[0].end_date == date(2026, 4, 9)
    assert plans[0].overlap_start == date(2026, 2, 4)


def test_build_full_security_sync_plans_respects_incremental_and_full_modes() -> None:
    trade_dates = [date(2005, 1, 4), date(2005, 1, 5), date(2005, 1, 6)]
    security = sample_security()

    full_plans = build_full_security_sync_plans(
        [security],
        {"600000.SSE": {"latest_checked_trade_date": "2005-01-04", "is_terminal": False}},
        trade_dates,
        date(2005, 1, 6),
    )
    assert full_plans[0].start_date == date(2005, 1, 5)

    force_full_plans = build_full_security_sync_plans(
        [security],
        {"600000.SSE": {"latest_checked_trade_date": "2005-01-04", "is_terminal": False}},
        trade_dates,
        date(2005, 1, 6),
        plan_mode="full",
    )
    assert force_full_plans[0].start_date == date(2005, 1, 4)


def test_build_incremental_trade_dates_uses_earliest_pending_meta() -> None:
    trade_dates = [date(2005, 1, 4), date(2005, 1, 5), date(2005, 1, 6)]
    security = sample_security()

    pending_dates, skipped = build_incremental_trade_dates(
        [security],
        {"600000.SSE": {"latest_checked_trade_date": "2005-01-05", "is_terminal": False}},
        trade_dates,
        date(2005, 1, 6),
    )
    assert pending_dates == [date(2005, 1, 6)]
    assert skipped == set()


def test_index_bar_and_year_plan_chunkers_keep_expected_windows() -> None:
    trade_dates = [date(2005, 1, 4), date(2005, 1, 5), date(2005, 1, 6)]
    security = sample_security()

    index_plans = build_index_constituent_sync_plans([security], {}, trade_dates, date(2005, 1, 6))
    assert len(index_plans) == 1
    assert index_plans[0].start_date == date(2005, 1, 4)
    assert index_plans[0].end_date == date(2005, 1, 6)

    bar_plans = build_bar_sync_plans([security], {}, trade_dates, date(2005, 1, 6), overlap_validation_days=0)
    batches = chunk_bar_sync_plans(bar_plans, max_rows_per_request=10)
    year_plans = split_bar_sync_plans_by_year(bar_plans, trade_dates)
    year_batches = chunk_year_plans(year_plans, max_rows_per_request=10)
    assert bar_plans[0].start_date == date(2005, 1, 4)
    assert bar_plans[0].end_date == date(2005, 1, 6)
    assert bar_plans[0].expected_rows == 3
    assert len(batches) == 1
    assert len(year_plans) == 1
    assert list(year_batches) == [2005]


def test_build_index_constituent_sync_plans_skips_delisted_indices_before_target_date() -> None:
    trade_dates = [date(2005, 1, 4), date(2025, 1, 2), date(2025, 1, 3)]
    delisted_index = sample_security(asset_type="index", gm_symbol="SHSE.000001", vt_symbol="000001.SSE")
    delisted_index.delisted_date = date(2025, 1, 2)

    plans = build_index_constituent_sync_plans([delisted_index], {}, trade_dates, date(2025, 1, 3))

    assert plans == []
