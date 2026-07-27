from __future__ import annotations

import sqlite3
from datetime import date, datetime

from alpha.common.schema_market import ShareCapitalPayload
from alpha.storage.base import SQLiteStorageBase
from alpha.storage.transforms import (
    ShareCapitalState,
    build_share_capital_meta_rows,
    build_sparse_share_capital_rows,
    collect_share_capital_first_trade_dates,
    normalize_trade_date,
)


class EquityRepository:
    """管理股本等权益类数据。"""

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage

    async def save_share_capital_data(self, rows: list[ShareCapitalPayload]) -> bool:
        """保存股本变化点数据，并推进同步边界。"""
        if not rows:
            return False

        earliest_trade_dates = collect_share_capital_first_trade_dates(rows)
        previous_state_map = await self._load_previous_share_capital_states(earliest_trade_dates)
        sparse_rows = build_sparse_share_capital_rows(rows, previous_state_map)
        meta_rows = build_share_capital_meta_rows(
            rows,
            last_sync_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )

        def operation(conn: sqlite3.Connection) -> bool:
            cur = conn.cursor()
            try:
                if sparse_rows:
                    cur.executemany(
                        """
                        INSERT OR REPLACE INTO share_capital (
                            vt_symbol, trade_date, total_share, float_share, free_share, updated_at
                        )
                        VALUES (
                            :vt_symbol, :trade_date, :total_share, :float_share, :free_share, :updated_at
                        )
                        """,
                        sparse_rows,
                    )
                cur.executemany(
                    """
                    INSERT INTO share_capital_meta (
                        vt_symbol, latest_trade_date, last_sync_at
                    )
                    VALUES (
                        :vt_symbol, :latest_trade_date, :last_sync_at
                    )
                    ON CONFLICT(vt_symbol) DO UPDATE SET
                        latest_trade_date = CASE
                            WHEN excluded.latest_trade_date > share_capital_meta.latest_trade_date
                            THEN excluded.latest_trade_date
                            ELSE share_capital_meta.latest_trade_date
                        END,
                        last_sync_at = excluded.last_sync_at
                    """,
                    meta_rows,
                )
                return True
            finally:
                cur.close()

        return await self.storage.write_main(operation)

    async def load_share_capital_meta(self, vt_symbol: str) -> dict[str, object] | None:
        """加载股本同步边界元信息。"""

        def operation(conn: sqlite3.Connection) -> tuple[object, ...] | None:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, latest_trade_date, last_sync_at
                    FROM share_capital_meta
                    WHERE vt_symbol = ?
                    """,
                    (vt_symbol,),
                )
                return cur.fetchone()
            finally:
                cur.close()

        row = await self.storage.read_main(operation)
        if row is None:
            return None

        return {
            "vt_symbol": str(row[0]),
            "latest_trade_date": str(row[1]),
            "last_sync_at": str(row[2]),
        }

    async def load_share_capital_changes(
        self,
        vt_symbol: str,
        start: str | date | datetime,
        end: str | date | datetime,
    ) -> list[dict[str, object]]:
        """加载指定区间内的股本变化记录。"""
        start_date, end_date = self._normalize_date_range(start, end)

        def operation(conn: sqlite3.Connection) -> list[tuple[object, ...]]:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, trade_date, total_share, float_share, free_share, updated_at
                    FROM share_capital
                    WHERE vt_symbol = ? AND trade_date BETWEEN ? AND ?
                    ORDER BY trade_date
                    """,
                    (vt_symbol, start_date, end_date),
                )
                return cur.fetchall()
            finally:
                cur.close()

        rows = await self.storage.read_main(operation)
        return [
            {
                "vt_symbol": str(row[0]),
                "trade_date": str(row[1]),
                "total_share": row[2],
                "float_share": row[3],
                "free_share": row[4],
                "updated_at": str(row[5]),
            }
            for row in rows
        ]

    async def clear_share_capital_data(self) -> None:
        """清空股本变化表及元信息。"""

        def operation(conn: sqlite3.Connection) -> None:
            cur = conn.cursor()
            try:
                cur.execute("DELETE FROM share_capital")
                cur.execute("DELETE FROM share_capital_meta")
            finally:
                cur.close()

        await self.storage.write_main(operation)

    async def _load_previous_share_capital_states(
        self,
        earliest_trade_dates: dict[str, str],
    ) -> dict[str, ShareCapitalState | None]:
        """查询每个标的在本批最早变更点之前最近一次已存储状态。"""
        if not earliest_trade_dates:
            return {}

        values_sql = ", ".join("(?, ?)" for _ in earliest_trade_dates)
        params: list[str] = []
        for vt_symbol, trade_date in earliest_trade_dates.items():
            params.extend([vt_symbol, trade_date])

        def operation(conn: sqlite3.Connection) -> list[tuple[object, ...]]:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"""
                    WITH targets(vt_symbol, first_trade_date) AS (
                        VALUES {values_sql}
                    ),
                    latest AS (
                        SELECT
                            s.vt_symbol,
                            MAX(s.trade_date) AS trade_date
                        FROM share_capital AS s
                        INNER JOIN targets AS t
                            ON t.vt_symbol = s.vt_symbol
                        WHERE s.trade_date < t.first_trade_date
                        GROUP BY s.vt_symbol
                    )
                    SELECT s.vt_symbol, s.total_share, s.float_share, s.free_share
                    FROM share_capital AS s
                    INNER JOIN latest
                        ON latest.vt_symbol = s.vt_symbol
                       AND latest.trade_date = s.trade_date
                    """,
                    params,
                )
                return cur.fetchall()
            finally:
                cur.close()

        raw_rows = await self.storage.read_main(operation)
        previous_states: dict[str, ShareCapitalState | None] = {
            vt_symbol: None for vt_symbol in earliest_trade_dates
        }
        for row in raw_rows:
            previous_states[str(row[0])] = (
                None if row[1] is None else float(row[1]),
                None if row[2] is None else float(row[2]),
                None if row[3] is None else float(row[3]),
            )
        return previous_states

    def _normalize_date_range(
        self,
        start: str | date | datetime,
        end: str | date | datetime,
    ) -> tuple[str, str]:
        """标准化日期范围。"""
        return normalize_trade_date(start), normalize_trade_date(end)
