import asyncio
import inspect
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

from alpha.common.schema import (
    AdjustFactorPayload,
    BarDataQuery,
    SecurityDailyInfoQuery,
    SecurityProfilePayload,
    SecurityProfileQuery,
    ShareCapitalPayload,
    datetime_to_timestr,
)
from alpha.storage.database import DataBase


class _SyncDatabaseHarness:
    """将异步数据库门面包装为测试可直接调用的同步对象。"""

    def __init__(self, db: DataBase) -> None:
        self._db = db

    def __getattr__(self, name: str) -> object:
        attr = getattr(self._db, name)
        if inspect.iscoroutinefunction(attr):
            return lambda *args, **kwargs: asyncio.run(attr(*args, **kwargs))
        return attr


def _make_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _SyncDatabaseHarness:
    data_dir = tmp_path / ".data" / "sqlite_db"
    monkeypatch.setattr("alpha.storage.database.get_runtime_subdir", lambda _: data_dir)
    return _SyncDatabaseHarness(DataBase())


def _mock_trade_date_csv(
    monkeypatch: pytest.MonkeyPatch,
    trade_dates: list[str],
) -> None:
    """为数据库门面打桩交易日历 CSV。"""
    monkeypatch.setattr(
        "alpha.storage.csvdb.get_trade_date",
        lambda: pd.DataFrame({"trade_date": trade_dates}),
    )


def _read_main_db(
    tmp_path: Path,
    sql: str,
    params: tuple[object, ...] = (),
) -> list[tuple[object, ...]]:
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        conn.close()


def _execute_main_db(
    tmp_path: Path,
    sql: str,
    params: tuple[object, ...] = (),
) -> None:
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _read_partition_db(
    tmp_path: Path,
    file_name: str,
    sql: str,
    params: tuple[object, ...] = (),
) -> list[tuple[object, ...]]:
    """读取测试分片库内容。"""
    db_path = tmp_path / ".data" / "sqlite_db" / file_name
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        conn.close()


def _make_bars(
    vt_symbol: str,
    interval: str,
    start_dt: datetime,
    count: int,
    step: timedelta | None = None,
) -> list[dict[str, object]]:
    delta = step or timedelta(days=1)
    bars = []
    for i in range(count):
        dt = start_dt + delta * i
        bars.append(
            {
                "vt_symbol": vt_symbol,
                "datetime": datetime_to_timestr(dt),
                "interval": interval,
                "volume": 100 + i,
                "open": 10 + i,
                "high": 11 + i,
                "low": 9 + i,
                "close": 10.5 + i,
            }
        )
    return bars


def _make_factors(
    vt_symbol: str,
    start_date: date,
    factors: list[float],
) -> list[AdjustFactorPayload]:
    return [
        {
            "vt_symbol": vt_symbol,
            "trade_date": (start_date + timedelta(days=index)).isoformat(),
            "adj_factor": value,
        }
        for index, value in enumerate(factors)
    ]


def test_save_and_load_bar_data_non_adjusted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2021, 1, 1)
    bars = _make_bars("AAPL.SSE", "d", start, 2)

    assert db.save_bar_data(bars, adjust="non") is True

    query = BarDataQuery(
        vt_symbol="AAPL.SSE",
        interval="d",
        adjust="non",
        start=start,
        end=start + timedelta(days=1),
    )
    loaded = db.load_bar_data(query)

    assert len(loaded) == 2
    assert loaded[0]["vt_symbol"] == "AAPL.SSE"
    assert loaded[0]["interval"] == "d"
    assert loaded[0]["adjust"] == "non"
    assert loaded[0]["close"] == pytest.approx(10.5)
    assert loaded[0]["upper_limit"] == pytest.approx(0)
    assert loaded[0]["lower_limit"] == pytest.approx(0)


def test_bardata_partition_schema_should_not_persist_interval(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证 K 线分片表不再冗余保存周期字段。"""
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2021, 1, 1)

    assert db.save_bar_data(_make_bars("AAPL.SSE", "d", start, 1), adjust="non") is True

    columns = _read_partition_db(tmp_path, "d_2021.db", "PRAGMA table_info(bardata)")
    column_names = [str(row[1]) for row in columns]
    assert "interval" not in column_names
    assert _read_partition_db(
        tmp_path,
        "d_2021.db",
        """
        SELECT vt_symbol, datetime
        FROM bardata
        WHERE vt_symbol = ?
        """,
        ("AAPL.SSE",),
    ) == [("AAPL.SSE", datetime_to_timestr(start))]


def test_save_bar_data_persists_limit_prices_and_uses_sqlite_defaults(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 8, 1)
    bars_with_limits = [
        {
            "vt_symbol": "LIMIT.SSE",
            "datetime": datetime_to_timestr(start),
            "interval": "d",
            "volume": 100,
            "open": 10,
            "high": 11,
            "low": 9,
            "close": 10.5,
            "turnover": 1000,
            "open_interest": 0,
            "upper_limit": 11.55,
            "lower_limit": 9.45,
        }
    ]
    bars_without_limits = [
        {
            "vt_symbol": "LIMIT.SSE",
            "datetime": datetime_to_timestr(start + timedelta(days=1)),
            "interval": "d",
            "volume": 101,
            "open": 10.5,
            "high": 11.5,
            "low": 9.5,
            "close": 11,
        }
    ]

    assert db.save_bar_data(bars_with_limits, adjust="non") is True
    assert db.save_bar_data(bars_without_limits, adjust="non") is True

    loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="LIMIT.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start + timedelta(days=1),
        )
    )

    assert loaded[0]["upper_limit"] == pytest.approx(11.55)
    assert loaded[0]["lower_limit"] == pytest.approx(9.45)
    assert loaded[1]["upper_limit"] == pytest.approx(0)
    assert loaded[1]["lower_limit"] == pytest.approx(0)
    assert loaded[1]["turnover"] == pytest.approx(0)
    assert loaded[1]["open_interest"] == pytest.approx(0)


def test_save_daily_bar_data_allows_partial_optional_columns(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 8, 1)
    price_bars = [
        {
            "vt_symbol": "PARTIAL.SSE",
            "datetime": datetime_to_timestr(start),
            "interval": "d",
            "volume": 100,
            "open": 10,
            "high": 11,
            "low": 9,
            "close": 10.5,
            "turnover": 1000,
        },
        {
            "vt_symbol": "PARTIAL.SSE",
            "datetime": datetime_to_timestr(start + timedelta(days=1)),
            "interval": "d",
            "volume": 101,
            "open": 10.5,
            "high": 11.5,
            "low": 9.5,
            "close": 11,
            "turnover": 0,
        },
    ]
    limit_bars = [
        {
            "vt_symbol": "PARTIAL.SSE",
            "datetime": datetime_to_timestr(start + timedelta(days=1)),
            "interval": "d",
            "upper_limit": 12.1,
            "lower_limit": 9.9,
        }
    ]

    assert db.save_bar_data(price_bars, adjust="non") is True
    assert db.save_bar_data(limit_bars, adjust="non") is True

    loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="PARTIAL.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start + timedelta(days=1),
        )
    )

    assert loaded[0]["turnover"] == pytest.approx(1000)
    assert loaded[0]["open_interest"] == pytest.approx(0)
    assert loaded[0]["upper_limit"] == pytest.approx(0)
    assert loaded[0]["lower_limit"] == pytest.approx(0)
    assert loaded[1]["turnover"] == pytest.approx(0)
    assert loaded[1]["open_interest"] == pytest.approx(0)
    assert loaded[1]["upper_limit"] == pytest.approx(12.1)
    assert loaded[1]["lower_limit"] == pytest.approx(9.9)


def test_save_bar_data_requires_consistent_fields_within_batch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 8, 1)
    inconsistent_bars = [
        {
            "vt_symbol": "CONSIST.SSE",
            "datetime": datetime_to_timestr(start),
            "interval": "d",
            "volume": 100,
            "open": 10,
            "high": 11,
            "low": 9,
            "close": 10.5,
            "turnover": 1000,
        },
        {
            "vt_symbol": "CONSIST.SSE",
            "datetime": datetime_to_timestr(start + timedelta(days=1)),
            "interval": "d",
            "volume": 101,
            "open": 10.5,
            "high": 11.5,
            "low": 9.5,
            "close": 11,
        },
    ]

    with pytest.raises(ValueError, match="字段一致"):
        db.save_bar_data(inconsistent_bars, adjust="non")


def test_save_non_daily_bar_data_does_not_explicitly_write_limit_prices(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 8, 1, 9, 30)
    bars = [
        {
            "vt_symbol": "MIN.SSE",
            "datetime": datetime_to_timestr(start),
            "interval": "1m",
            "volume": 100,
            "open": 10,
            "high": 10.2,
            "low": 9.9,
            "close": 10.1,
            "turnover": 1000,
            "open_interest": 0,
            "upper_limit": 11.0,
            "lower_limit": 9.0,
        }
    ]

    assert db.save_bar_data(bars, adjust="non") is True

    loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="MIN.SSE",
            interval="1m",
            adjust="non",
            start=start,
            end=start,
        )
    )

    assert loaded[0]["upper_limit"] == pytest.approx(0)
    assert loaded[0]["lower_limit"] == pytest.approx(0)


def test_save_daily_limit_prices_updates_existing_row_without_resetting_other_fields(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 8, 1)
    base_bar = {
        "vt_symbol": "PATCH.SSE",
        "datetime": datetime_to_timestr(start),
        "interval": "d",
        "volume": 100,
        "open": 10,
        "high": 11,
        "low": 9,
        "close": 10.5,
        "turnover": 1000,
        "open_interest": 5,
    }
    limit_bar = {
        "vt_symbol": "PATCH.SSE",
        "datetime": datetime_to_timestr(start),
        "interval": "d",
        "upper_limit": 11.55,
        "lower_limit": 9.45,
    }

    assert db.save_bar_data([base_bar], adjust="non") is True
    assert db.save_bar_data([limit_bar], adjust="non") is True

    loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="PATCH.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start,
        )
    )

    assert len(loaded) == 1
    assert loaded[0]["volume"] == pytest.approx(100)
    assert loaded[0]["close"] == pytest.approx(10.5)
    assert loaded[0]["turnover"] == pytest.approx(1000)
    assert loaded[0]["open_interest"] == pytest.approx(5)
    assert loaded[0]["upper_limit"] == pytest.approx(11.55)
    assert loaded[0]["lower_limit"] == pytest.approx(9.45)


def test_get_bar_overview_counts_raw_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2022, 1, 1)
    bars = _make_bars("AAPL.SSE", "d", start, 3)

    db.save_bar_data(bars, adjust="non")
    overview = db.get_bar_overview()

    assert len(overview) == 1
    row = overview[0]
    assert row["vt_symbol"] == "AAPL.SSE"
    assert row["interval"] == "d"
    assert row["count"] == 3
    assert row["start"] == str(bars[0]["datetime"])
    assert row["end"] == str(bars[-1]["datetime"])


def test_load_bar_data_pre_adjusted_view(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 1, 1)
    bars = [
        {"vt_symbol": "XYZ.SSE", "datetime": datetime_to_timestr(start), "interval": "d", "volume": 1, "open": 10, "high": 10, "low": 10, "close": 10, "turnover": 0, "open_interest": 0, "upper_limit": 11, "lower_limit": 9},
        {"vt_symbol": "XYZ.SSE", "datetime": datetime_to_timestr(start + timedelta(days=1)), "interval": "d", "volume": 1, "open": 20, "high": 20, "low": 20, "close": 20, "turnover": 0, "open_interest": 0, "upper_limit": 22, "lower_limit": 18},
        {"vt_symbol": "XYZ.SSE", "datetime": datetime_to_timestr(start + timedelta(days=2)), "interval": "d", "volume": 1, "open": 30, "high": 30, "low": 30, "close": 30, "turnover": 0, "open_interest": 0, "upper_limit": 33, "lower_limit": 27},
    ]
    factors = _make_factors("XYZ.SSE", start.date(), [1.0, 1.2, 1.5])

    assert db.save_bar_data(bars, adjust="non") is True
    assert db.save_adjust_factors(factors) is True

    query = BarDataQuery(
        vt_symbol="XYZ.SSE",
        interval="d",
        adjust="pre",
        start=start,
        end=start + timedelta(days=2),
    )
    loaded = db.load_bar_data(query)

    assert [row["adjust"] for row in loaded] == ["pre", "pre", "pre"]
    assert loaded[0]["close"] == pytest.approx(10 * 1.0 / 1.5)
    assert loaded[1]["close"] == pytest.approx(20 * 1.2 / 1.5)
    assert loaded[2]["close"] == pytest.approx(30.0)
    assert loaded[0]["upper_limit"] == pytest.approx(11 * 1.0 / 1.5)
    assert loaded[1]["lower_limit"] == pytest.approx(18 * 1.2 / 1.5)
    assert loaded[2]["upper_limit"] == pytest.approx(33.0)


def test_load_bar_data_post_adjusted_view(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 1, 1)
    bars = [
        {"vt_symbol": "XYZ.SSE", "datetime": datetime_to_timestr(start), "interval": "d", "volume": 1, "open": 10, "high": 10, "low": 10, "close": 10, "turnover": 0, "open_interest": 0, "upper_limit": 11, "lower_limit": 9},
        {"vt_symbol": "XYZ.SSE", "datetime": datetime_to_timestr(start + timedelta(days=1)), "interval": "d", "volume": 1, "open": 20, "high": 20, "low": 20, "close": 20, "turnover": 0, "open_interest": 0, "upper_limit": 22, "lower_limit": 18},
        {"vt_symbol": "XYZ.SSE", "datetime": datetime_to_timestr(start + timedelta(days=2)), "interval": "d", "volume": 1, "open": 30, "high": 30, "low": 30, "close": 30, "turnover": 0, "open_interest": 0, "upper_limit": 33, "lower_limit": 27},
    ]
    factors = _make_factors("XYZ.SSE", start.date(), [1.0, 1.2, 1.5])

    db.save_bar_data(bars, adjust="non")
    db.save_adjust_factors(factors)

    query = BarDataQuery(
        vt_symbol="XYZ.SSE",
        interval="d",
        adjust="post",
        start=start,
        end=start + timedelta(days=2),
    )
    loaded = db.load_bar_data(query)

    assert [row["adjust"] for row in loaded] == ["post", "post", "post"]
    assert loaded[0]["close"] == pytest.approx(10.0)
    assert loaded[1]["close"] == pytest.approx(20 * 1.2)
    assert loaded[2]["close"] == pytest.approx(30 * 1.5)
    assert loaded[0]["lower_limit"] == pytest.approx(9.0)
    assert loaded[1]["upper_limit"] == pytest.approx(22 * 1.2)
    assert loaded[2]["lower_limit"] == pytest.approx(27 * 1.5)


def test_save_adjust_factors_updates_meta(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    factors = _make_factors("XYZ.SSE", date(2024, 1, 1), [1.0, 1.2, 1.5])

    assert db.save_adjust_factors(factors) is True

    meta = db.load_adjust_factor_meta("XYZ.SSE")
    assert meta is not None
    assert meta["vt_symbol"] == "XYZ.SSE"
    assert meta["latest_trade_date"] == "2024-01-03"
    assert isinstance(meta["last_sync_at"], str)


def test_save_adjust_factors_only_keeps_change_points(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)

    initial_factors = _make_factors("XYZ.SSE", date(2024, 1, 1), [1.0, 1.0, 1.2, 1.2])
    incremental_factors = _make_factors("XYZ.SSE", date(2024, 1, 5), [1.2, 1.2, 1.5])

    assert db.save_adjust_factors(initial_factors) is True
    assert db.save_adjust_factors(incremental_factors) is True

    rows = _read_main_db(
        tmp_path,
        """
        SELECT trade_date, adj_factor
        FROM adjust_factor
        WHERE vt_symbol = ?
        ORDER BY trade_date
        """,
        ("XYZ.SSE",),
    )

    assert rows == [
        ("2024-01-01", 1.0),
        ("2024-01-03", 1.2),
        ("2024-01-07", 1.5),
    ]

    meta = db.load_adjust_factor_meta("XYZ.SSE")
    assert meta is not None
    assert meta["latest_trade_date"] == "2024-01-07"


def test_load_bar_data_without_factor_falls_back_to_raw(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 5, 1)
    bars = _make_bars("AAA.SSE", "d", start, 2)

    db.save_bar_data(bars, adjust="non")

    query = BarDataQuery(
        vt_symbol="AAA.SSE",
        interval="d",
        adjust="pre",
        start=start,
        end=start + timedelta(days=1),
    )
    loaded = db.load_bar_data(query)

    assert loaded[0]["close"] == pytest.approx(10.5)
    assert loaded[1]["close"] == pytest.approx(11.5)


def test_load_bars_data_multiple_queries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2023, 1, 1)

    db.save_bar_data(_make_bars("AAA.SSE", "d", start, 1), adjust="non")
    db.save_bar_data(_make_bars("BBB.SSE", "d", start, 1), adjust="non")

    queries = [
        BarDataQuery(
            vt_symbol="AAA.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start,
        ),
        BarDataQuery(
            vt_symbol="BBB.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start,
        ),
        BarDataQuery(
            vt_symbol="CCC.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start,
        ),
    ]

    loaded = db.load_bars_data(queries)
    vt_symbols = {row["vt_symbol"] for row in loaded}
    assert vt_symbols == {"AAA.SSE", "BBB.SSE"}


def test_load_bar_data_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    query = BarDataQuery(
        vt_symbol="AAA.SSE",
        interval="d",
        adjust="non",
        start=datetime(2020, 1, 1),
        end=datetime(2020, 1, 2),
    )

    assert db.load_bar_data(query) == []


def test_save_bar_data_empty_returns_false(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    assert db.save_bar_data([], adjust="non") is False


def test_save_adjust_factors_empty_returns_false(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    assert db.save_adjust_factors([]) is False


def test_save_bar_data_rejects_adjusted_input(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    bars = _make_bars("QQQ.SSE", "d", datetime(2021, 6, 1), 1)
    with pytest.raises(ValueError):
        db.save_bar_data(bars, adjust="pre")


def test_save_bar_data_twice_same_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2021, 6, 1)

    bars_a = _make_bars("QQQ.SSE", "d", start, 2)
    bars_b = _make_bars("QQQ.SSE", "d", start + timedelta(days=2), 2)

    assert db.save_bar_data(bars_a, adjust="non") is True
    assert db.save_bar_data(bars_b, adjust="non") is True

    query = BarDataQuery(
        vt_symbol="QQQ.SSE",
        interval="d",
        adjust="non",
        start=start,
        end=start + timedelta(days=3),
    )
    loaded = db.load_bar_data(query)
    assert len(loaded) == 4


def test_save_bar_data_single_batch_multiple_symbols(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 7, 1)
    bars = _make_bars("AAA.SSE", "d", start, 2) + _make_bars("BBB.SZSE", "d", start, 2)

    assert db.save_bar_data(bars, adjust="non") is True

    aaa_loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="AAA.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start + timedelta(days=1),
        )
    )
    bbb_loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="BBB.SZSE",
            interval="d",
            adjust="non",
            start=start,
            end=start + timedelta(days=1),
        )
    )

    assert len(aaa_loaded) == 2
    assert len(bbb_loaded) == 2


def test_load_bar_data_across_year_partitions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2023, 12, 31)
    bars = _make_bars("YEAR.SSE", "d", start, 3)

    assert db.save_bar_data(bars, adjust="non") is True

    loaded = db.load_bar_data(
        BarDataQuery(
            vt_symbol="YEAR.SSE",
            interval="d",
            adjust="non",
            start=start,
            end=start + timedelta(days=2),
        )
    )

    assert len(loaded) == 3
    assert (tmp_path / ".data" / "sqlite_db" / "d_2023.db").exists()
    assert (tmp_path / ".data" / "sqlite_db" / "d_2024.db").exists()


def test_async_database_supports_concurrent_cross_partition_reads_and_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_dir = tmp_path / ".data" / "sqlite_db"
    monkeypatch.setattr("alpha.storage.database.get_runtime_subdir", lambda _: data_dir)
    db = DataBase()

    async def scenario() -> tuple[list[dict], list[dict]]:
        start_2024 = datetime(2024, 12, 31)
        start_2025 = datetime(2025, 12, 31)
        await asyncio.gather(
            db.save_bar_data(_make_bars("ASYNC.SSE", "d", start_2024, 2), adjust="non"),
            db.save_bar_data(_make_bars("ASYNC.SSE", "d", start_2025, 2), adjust="non"),
        )
        first_query = BarDataQuery(
            vt_symbol="ASYNC.SSE",
            interval="d",
            adjust="non",
            start=start_2024,
            end=start_2024 + timedelta(days=1),
        )
        second_query = BarDataQuery(
            vt_symbol="ASYNC.SSE",
            interval="d",
            adjust="non",
            start=start_2025,
            end=start_2025 + timedelta(days=1),
        )
        loaded_first, loaded_second = await asyncio.gather(
            db.load_bar_data(first_query),
            db.load_bar_data(second_query),
        )
        await db.close()
        return loaded_first, loaded_second

    loaded_first, loaded_second = asyncio.run(scenario())

    assert [row["datetime"] for row in loaded_first] == [
        "2024-12-31 00:00:00",
        "2025-01-01 00:00:00",
    ]
    assert [row["datetime"] for row in loaded_second] == [
        "2025-12-31 00:00:00",
        "2026-01-01 00:00:00",
    ]


def test_database_close_removes_empty_wal_and_shm_sidecars(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证关闭数据库门面后会清理空 WAL/SHM 辅助文件。"""
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 1, 1)

    assert db.save_bar_data(_make_bars("SIDECAR.SSE", "d", start, 1), adjust="non") is True

    sqlite_dir = tmp_path / ".data" / "sqlite_db"
    sidecar_paths = [
        sqlite_dir / "main.db-wal",
        sqlite_dir / "main.db-shm",
        sqlite_dir / "d_2024.db-wal",
        sqlite_dir / "d_2024.db-shm",
    ]

    for sidecar_path in sidecar_paths:
        if sidecar_path.suffix == ".db-wal":
            sidecar_path.write_bytes(b"")
        else:
            sidecar_path.write_bytes(b"\x00" * 32768)

    db.close()

    for sidecar_path in sidecar_paths:
        assert not sidecar_path.exists()


def test_rebuild_bar_overview_from_partitions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    start = datetime(2024, 1, 30)
    bars = _make_bars("MTH.SSE", "1m", start, 3, step=timedelta(days=1))

    assert db.save_bar_data(bars, adjust="non") is True

    _execute_main_db(
        tmp_path,
        "DELETE FROM bar_overview",
    )

    assert db.get_bar_overview() == []

    db.rebuild_bar_overview()
    overview = db.get_bar_overview()

    assert len(overview) == 1
    assert overview[0]["vt_symbol"] == "MTH.SSE"
    assert overview[0]["interval"] == "1m"
    assert overview[0]["count"] == 3


def test_save_and_load_security_profiles_query_single_symbol(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_profiles(
        [
            {
                "vt_symbol": "000001.SZSE",
                "asset_type": "stock",
                "board": 10100101,
                "sec_name": "平安银行",
                "sec_abbr": "PAYH",
                "price_tick": 0.01,
                "trade_n": 1,
                "listed_date": "1991-04-03",
                "delisted_date": None,
            }
        ]
    ) is True

    profiles = db.load_security_profiles(SecurityProfileQuery(vt_symbols=["000001.SZSE"]))

    assert len(profiles) == 1
    profile = profiles[0]
    assert profile is not None
    assert profile["vt_symbol"] == "000001.SZSE"
    assert profile["asset_type"] == "stock"
    assert profile["board"] == 10100101
    assert profile["sec_name"] == "平安银行"
    assert profile["sec_abbr"] == "PAYH"
    assert profile["price_tick"] == pytest.approx(0.01)
    assert profile["trade_n"] == 1
    assert profile["listed_date"] == "1991-04-03"
    assert profile["delisted_date"] is None


def test_save_security_profiles_replaces_latest_value(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_profiles(
        [
            {
                "vt_symbol": "510300.SSE",
                "asset_type": "etf",
                "board": 10200101,
                "sec_name": "沪深300ETF",
                "sec_abbr": "HS300ETF",
                "price_tick": 0.001,
                "trade_n": 0,
                "listed_date": "2012-05-28",
            }
        ]
    ) is True
    assert db.save_security_profiles(
        [
            {
                "vt_symbol": "510300.SSE",
                "asset_type": "etf",
                "price_tick": 0.01,
                "trade_n": 1,
                "listed_date": "2012-05-28",
            }
        ]
    ) is True

    profiles = db.load_security_profiles(SecurityProfileQuery(vt_symbols=["510300.SSE"]))

    assert len(profiles) == 1
    profile = profiles[0]
    assert profile is not None
    assert profile["board"] == 10200101
    assert profile["sec_name"] == "沪深300ETF"
    assert profile["sec_abbr"] == "HS300ETF"
    assert profile["price_tick"] == pytest.approx(0.01)
    assert profile["trade_n"] == 1


def test_load_security_profiles_filters_by_asset_type(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_profiles(
        [
            {"vt_symbol": "000001.SZSE", "asset_type": "stock", "board": 10100101, "sec_name": "平安银行"},
            {"vt_symbol": "510300.SSE", "asset_type": "etf", "board": 10200101, "sec_name": "沪深300ETF"},
            {"vt_symbol": "000300.SSE", "asset_type": "index", "sec_name": "沪深300"},
        ]
    ) is True

    profiles = db.load_security_profiles(SecurityProfileQuery(asset_type="etf"))

    assert len(profiles) == 1
    assert profiles[0]["vt_symbol"] == "510300.SSE"
    assert profiles[0]["asset_type"] == "etf"
    assert profiles[0]["board"] == 10200101
    assert profiles[0]["sec_name"] == "沪深300ETF"


def test_load_security_profiles_query_batches_requested_profiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证可按证券代码批量加载静态资料并忽略不存在的证券。"""
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_profiles(
        [
            {"vt_symbol": "000001.SZSE", "asset_type": "stock", "board": 10100101, "sec_name": "平安银行"},
            {"vt_symbol": "510300.SSE", "asset_type": "etf", "board": 10200101, "sec_name": "沪深300ETF"},
        ]
    ) is True

    profiles = db.load_security_profiles(
        SecurityProfileQuery(vt_symbols=["510300.SSE", "000001.SZSE", "000001.SZSE", "999999.SSE"])
    )
    profile_map = {str(row["vt_symbol"]): row for row in profiles}

    assert set(profile_map) == {"000001.SZSE", "510300.SSE"}
    assert profile_map["510300.SSE"]["asset_type"] == "etf"
    assert profile_map["510300.SSE"]["sec_name"] == "沪深300ETF"


def test_load_security_profiles_query_combines_symbols_and_asset_type(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_profiles(
        [
            {"vt_symbol": "000001.SZSE", "asset_type": "stock", "sec_name": "平安银行"},
            {"vt_symbol": "510300.SSE", "asset_type": "etf", "sec_name": "沪深300ETF"},
            {"vt_symbol": "159919.SZSE", "asset_type": "etf", "sec_name": "沪深300ETF"},
        ]
    ) is True

    profiles = db.load_security_profiles(
        SecurityProfileQuery(
            vt_symbols=["000001.SZSE", "510300.SSE", "999999.SSE"],
            asset_type="etf",
        )
    )

    assert [row["vt_symbol"] for row in profiles] == ["510300.SSE"]


def test_load_security_profiles_query_empty_symbols_returns_empty(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_profiles(
        [{"vt_symbol": "000001.SZSE", "asset_type": "stock", "sec_name": "平安银行"}]
    ) is True

    profiles = db.load_security_profiles(SecurityProfileQuery(vt_symbols=[]))

    assert profiles == []


def test_load_security_daily_info_expands_requested_trade_dates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证逐日证券状态查询会按请求证券和交易日补齐无事件日期。"""
    db = _make_db(tmp_path, monkeypatch)
    _mock_trade_date_csv(
        monkeypatch,
        [
            "2025-01-01",
            "2025-01-02",
            "2025-01-03",
            "2025-01-05",
            "2025-01-08",
            "2025-01-10",
            "2025-02-01",
        ],
    )

    assert db.save_suspended_day_events(
        [
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-03"},
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-03"},
            {"vt_symbol": "600001.SSE", "trade_date": "2025-01-05"},
            {"vt_symbol": "600001.SSE", "trade_date": "2025-02-01"},
        ]
    ) is True
    assert db.save_st_day_events(
        [
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-03"},
            {"vt_symbol": "600001.SSE", "trade_date": "2025-01-08"},
        ]
    ) is True

    rows = db.load_security_daily_info(
        SecurityDailyInfoQuery(
            vt_symbols=["600001.SSE", "000001.SZSE", "600001.SSE", "999999.SSE"],
            start="2025-01-02",
            end="2025-01-10",
        )
    )
    row_map = {(row["vt_symbol"], row["trade_date"]): row for row in rows}

    assert len(rows) == 15
    assert list(dict.fromkeys(row["vt_symbol"] for row in rows)) == [
        "600001.SSE",
        "000001.SZSE",
        "999999.SSE",
    ]
    assert [row["trade_date"] for row in rows[:5]] == [
        "2025-01-02",
        "2025-01-03",
        "2025-01-05",
        "2025-01-08",
        "2025-01-10",
    ]
    assert row_map[("000001.SZSE", "2025-01-03")]["is_suspended"] is True
    assert row_map[("000001.SZSE", "2025-01-03")]["is_st"] is True
    assert row_map[("600001.SSE", "2025-01-05")]["is_suspended"] is True
    assert row_map[("600001.SSE", "2025-01-08")]["is_st"] is True
    assert row_map[("999999.SSE", "2025-01-03")]["is_suspended"] is False
    assert row_map[("999999.SSE", "2025-01-03")]["is_st"] is False
    assert ("600001.SSE", "2025-01-01") not in row_map
    assert ("600001.SSE", "2025-02-01") not in row_map


def test_save_security_status_meta_only_moves_forward(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    db.save_security_status_meta("000001.SZSE", "2025-03-10", latest_data_trade_date="2025-03-10")
    db.save_security_status_meta("000001.SZSE", "2025-03-05", latest_data_trade_date="2025-03-05")
    db.save_security_status_meta("000001.SZSE", "2025-03-20", latest_data_trade_date="2025-03-18", is_terminal=True)

    meta = db.load_security_status_meta("000001.SZSE")

    assert meta is not None
    assert meta["vt_symbol"] == "000001.SZSE"
    assert meta["latest_checked_trade_date"] == "2025-03-20"
    assert meta["latest_data_trade_date"] == "2025-03-18"
    assert meta["is_terminal"] is True
    assert isinstance(meta["updated_at"], str)


def test_save_security_status_metas_batches_and_deduplicates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_security_status_metas(
        [
            {
                "vt_symbol": "000001.SZSE",
                "latest_checked_trade_date": "2025-03-10",
                "latest_data_trade_date": "2025-03-10",
                "is_terminal": False,
            },
            {
                "vt_symbol": "000001.SZSE",
                "latest_checked_trade_date": "2025-03-05",
                "latest_data_trade_date": "2025-03-05",
                "is_terminal": False,
            },
            {
                "vt_symbol": "510300.SSE",
                "latest_checked_trade_date": "2025-03-08",
                "latest_data_trade_date": None,
                "is_terminal": True,
            },
        ]
    ) is True

    metas = db.load_security_status_metas()

    assert metas["000001.SZSE"]["latest_checked_trade_date"] == "2025-03-10"
    assert metas["000001.SZSE"]["latest_data_trade_date"] == "2025-03-10"
    assert metas["510300.SSE"]["latest_checked_trade_date"] == "2025-03-08"
    assert metas["510300.SSE"]["latest_data_trade_date"] is None
    assert metas["510300.SSE"]["is_terminal"] is True


def test_save_status_event_batches_insert_unique_rows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    _mock_trade_date_csv(
        monkeypatch,
        ["2025-01-02", "2025-01-03", "2025-01-05"],
    )

    assert db.save_suspended_day_events(
        [
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-02"},
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-02"},
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-03"},
        ]
    ) is True
    assert db.save_st_day_events(
        [
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-03"},
            {"vt_symbol": "000001.SZSE", "trade_date": "2025-01-05"},
        ]
    ) is True

    rows = db.load_security_daily_info(
        SecurityDailyInfoQuery(
            vt_symbols=["000001.SZSE"],
            start="2025-01-01",
            end="2025-01-31",
        )
    )
    row_map = {row["trade_date"]: row for row in rows}

    assert row_map["2025-01-02"]["is_suspended"] is True
    assert row_map["2025-01-02"]["is_st"] is False
    assert row_map["2025-01-03"]["is_suspended"] is True
    assert row_map["2025-01-03"]["is_st"] is True
    assert row_map["2025-01-05"]["is_suspended"] is False
    assert row_map["2025-01-05"]["is_st"] is True


def test_save_and_load_share_capital_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _make_db(tmp_path, monkeypatch)
    rows = [
        {
            "vt_symbol": "000001.SZSE",
            "trade_date": "2025-01-02",
            "total_share": 1000.0,
            "float_share": 600.0,
            "free_share": 500.0,
            "updated_at": "2025-01-02 15:00:00",
        },
        {
            "vt_symbol": "000001.SZSE",
            "trade_date": "2025-02-01",
            "total_share": 1200.0,
            "float_share": 800.0,
            "free_share": 700.0,
            "updated_at": "2025-02-01 15:00:00",
        },
    ]

    assert db.save_share_capital_data(rows) is True
    loaded = db.load_share_capital_changes("000001.SZSE", "2025-01-01", "2025-12-31")

    assert len(loaded) == 2
    assert loaded[0]["total_share"] == pytest.approx(1000)
    assert loaded[1]["free_share"] == pytest.approx(700)

    meta = db.load_share_capital_meta("000001.SZSE")
    assert meta is not None
    assert meta["vt_symbol"] == "000001.SZSE"
    assert meta["latest_trade_date"] == "2025-02-01"
    assert isinstance(meta["last_sync_at"], str)


def test_save_share_capital_data_only_persists_change_points(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_share_capital_data(
        [
            {
                "vt_symbol": "000001.SZSE",
                "trade_date": "2025-01-01",
                "total_share": 1000.0,
                "float_share": 500.0,
                "free_share": 400.0,
                "updated_at": "2025-01-01 15:00:00",
            },
            {
                "vt_symbol": "000001.SZSE",
                "trade_date": "2025-01-02",
                "total_share": 1000.0,
                "float_share": 500.0,
                "free_share": 400.0,
                "updated_at": "2025-01-02 15:00:00",
            },
            {
                "vt_symbol": "000001.SZSE",
                "trade_date": "2025-01-03",
                "total_share": 1200.0,
                "float_share": 700.0,
                "free_share": 600.0,
                "updated_at": "2025-01-03 15:00:00",
            },
        ]
    ) is True

    loaded = db.load_share_capital_changes("000001.SZSE", "2025-01-01", "2025-01-31")

    assert [row["trade_date"] for row in loaded] == ["2025-01-01", "2025-01-03"]
    assert loaded[0]["total_share"] == pytest.approx(1000)
    assert loaded[1]["total_share"] == pytest.approx(1200)


def test_save_share_capital_data_advances_meta_without_new_change_points(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_share_capital_data(
        [
            {
                "vt_symbol": "000001.SZSE",
                "trade_date": "2025-01-01",
                "total_share": 1000.0,
                "float_share": 500.0,
                "free_share": 400.0,
                "updated_at": "2025-01-01 15:00:00",
            }
        ]
    ) is True
    assert db.save_share_capital_data(
        [
            {
                "vt_symbol": "000001.SZSE",
                "trade_date": "2025-01-02",
                "total_share": 1000.0,
                "float_share": 500.0,
                "free_share": 400.0,
                "updated_at": "2025-01-02 15:00:00",
            }
        ]
    ) is True

    loaded = db.load_share_capital_changes("000001.SZSE", "2025-01-01", "2025-01-31")
    meta = db.load_share_capital_meta("000001.SZSE")

    assert [row["trade_date"] for row in loaded] == ["2025-01-01"]
    assert meta is not None
    assert meta["latest_trade_date"] == "2025-01-02"
