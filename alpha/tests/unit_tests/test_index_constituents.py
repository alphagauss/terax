import asyncio
import inspect
import sqlite3
from pathlib import Path

import pytest

from alpha.common.schema import IndexConstituentQuery
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
    monkeypatch.setattr(
        "alpha.storage.database.get_runtime_subdir",
        lambda _: data_dir,
    )
    return _SyncDatabaseHarness(DataBase())


def _load_index_constituents(
    db: _SyncDatabaseHarness,
    index_code: str,
    trade_date: str,
) -> list[str]:
    """使用统一查询对象加载指数成分股。"""
    return db.load_index_constituents(
        IndexConstituentQuery(index_code=index_code, trade_date=trade_date)
    )


def _count_memberships(db_path: Path, index_code: str) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COUNT(*)
            FROM index_constituent_membership
            WHERE index_code = ?
            """,
            (index_code,),
        )
        row = cur.fetchone()
        return int(row[0]) if row is not None else 0
    finally:
        conn.close()


def _load_memberships(db_path: Path, index_code: str) -> list[tuple[str, str, str | None]]:
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT vt_symbol, start_date, end_date
            FROM index_constituent_membership
            WHERE index_code = ?
            ORDER BY vt_symbol, start_date
            """,
            (index_code,),
        )
        return [
            (str(vt_symbol), str(start_date), None if end_date is None else str(end_date))
            for vt_symbol, start_date, end_date in cur.fetchall()
        ]
    finally:
        conn.close()


def _load_column_names(db_path: Path, table_name: str) -> list[str]:
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(f"PRAGMA table_info({table_name})")
        return [str(row[1]) for row in cur.fetchall()]
    finally:
        conn.close()


def test_save_and_load_index_constituents_basic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"

    assert db.save_index_constituents("SHSE.000001", "2026-03-31", ["SHSE.600519", "SHSE.601398"]) is True

    loaded = _load_index_constituents(db, "SHSE.000001", "2026-03-31")

    assert loaded == ["SHSE.600519", "SHSE.601398"]
    column_names = _load_column_names(db_path, "index_constituent_membership")
    assert "vt_symbol" in column_names
    assert "symbol" not in column_names


def test_save_same_constituents_on_later_date_keeps_single_open_interval(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"

    db.save_index_constituents("SHSE.000001", "2026-03-31", ["SHSE.600519", "SHSE.601398"])
    db.save_index_constituents("SHSE.000001", "2026-04-01", ["SHSE.601398", "SHSE.600519"])

    assert _load_index_constituents(db, "SHSE.000001", "2026-04-01") == ["SHSE.600519", "SHSE.601398"]
    assert _count_memberships(db_path, "SHSE.000001") == 2
    assert _load_memberships(db_path, "SHSE.000001") == [
        ("SHSE.600519", "2026-03-31", None),
        ("SHSE.601398", "2026-03-31", None),
    ]


def test_save_changed_constituents_splits_membership_intervals(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"

    db.save_index_constituents("SHSE.000001", "2026-03-31", ["SHSE.600519", "SHSE.601398"])
    db.save_index_constituents("SHSE.000001", "2026-04-08", ["SHSE.600519", "SHSE.601288"])

    assert _load_index_constituents(db, "SHSE.000001", "2026-04-07") == ["SHSE.600519", "SHSE.601398"]
    assert _load_index_constituents(db, "SHSE.000001", "2026-04-08") == ["SHSE.600519", "SHSE.601288"]
    assert _load_memberships(db_path, "SHSE.000001") == [
        ("SHSE.600519", "2026-03-31", None),
        ("SHSE.601288", "2026-04-08", None),
        ("SHSE.601398", "2026-03-31", "2026-04-08"),
    ]


def test_save_out_of_order_trade_dates_preserves_timeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"

    db.save_index_constituents("SHSE.000300", "2026-03-20", ["SHSE.600519", "SHSE.601398"])
    db.save_index_constituents("SHSE.000300", "2026-04-01", ["SHSE.600519", "SHSE.601288"])
    db.save_index_constituents("SHSE.000300", "2026-03-25", ["SHSE.601398", "SHSE.601288"])

    assert _load_index_constituents(db, "SHSE.000300", "2026-03-24") == ["SHSE.600519", "SHSE.601398"]
    assert _load_index_constituents(db, "SHSE.000300", "2026-03-25") == ["SHSE.601288", "SHSE.601398"]
    assert _load_index_constituents(db, "SHSE.000300", "2026-04-01") == ["SHSE.600519", "SHSE.601288"]
    assert _load_memberships(db_path, "SHSE.000300") == [
        ("SHSE.600519", "2026-03-20", "2026-03-25"),
        ("SHSE.600519", "2026-04-01", None),
        ("SHSE.601288", "2026-03-25", None),
        ("SHSE.601398", "2026-03-20", "2026-04-01"),
    ]


def test_save_empty_constituents_closes_all_open_memberships(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)
    db_path = tmp_path / ".data" / "sqlite_db" / "main.db"

    db.save_index_constituents("SHSE.000905", "2026-03-31", ["SHSE.600519"])
    db.save_index_constituents("SHSE.000905", "2026-04-10", [])

    assert _load_index_constituents(db, "SHSE.000905", "2026-04-09") == ["SHSE.600519"]
    assert _load_index_constituents(db, "SHSE.000905", "2026-04-10") == []
    assert _load_memberships(db_path, "SHSE.000905") == [
        ("SHSE.600519", "2026-03-31", "2026-04-10"),
    ]


def test_save_same_constituents_advances_index_constituent_meta(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_index_constituents("SHSE.000001", "2026-03-31", ["SHSE.600519", "SHSE.601398"]) is True
    assert db.save_index_constituents("SHSE.000001", "2026-04-01", ["SHSE.601398", "SHSE.600519"]) is True

    meta = db.load_index_constituent_meta("SHSE.000001")

    assert meta is not None
    assert meta["index_code"] == "SHSE.000001"
    assert meta["latest_trade_date"] == "2026-04-01"
    assert isinstance(meta["last_sync_at"], str)


def test_save_out_of_order_trade_dates_does_not_roll_back_index_constituent_meta(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _make_db(tmp_path, monkeypatch)

    assert db.save_index_constituents("SHSE.000300", "2026-04-08", ["SHSE.600519", "SHSE.601398"]) is True
    assert db.save_index_constituents("SHSE.000300", "2026-03-31", ["SHSE.600519", "SHSE.601288"]) is True

    meta = db.load_index_constituent_meta("SHSE.000300")

    assert meta is not None
    assert meta["latest_trade_date"] == "2026-04-08"
