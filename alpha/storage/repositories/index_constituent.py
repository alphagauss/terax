from __future__ import annotations

import sqlite3
from datetime import date, datetime

from alpha.storage.base import SQLiteStorageBase
from alpha.storage.repositories.sqlite_rows import SQLiteRecord, fetchone_record
from alpha.storage.transforms import normalize_trade_date

_SQLITE_IN_CHUNK_SIZE = 900


class IndexConstituentRepository:
    """管理指数成分股区间。"""

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage

    async def save_index_constituents(
        self,
        index_code: str,
        trade_date: str | date | datetime,
        vt_symbols: list[str],
    ) -> bool:
        """保存指定交易日的指数成分股全集。

        Args:
            index_code: 指数代码，沿用数据库内部 ``vt_symbol`` 语义，例如
                ``000300.SSE`` 或上游已标准化后的 ``SHSE.000300``。
            trade_date: 成分股定义生效交易日，统一标准化为 ``YYYY-MM-DD``。
            vt_symbols: 当日完整成分股 ``vt_symbol`` 列表。列表元素应与数据库内部约定一致，
                当前仓储直接按调用方传入字符串保存，例如 ``600519.SSE`` 或
                ``SHSE.600519``。

        Returns:
            保存成功时返回 ``True``。若传入集合与库内该日已生效集合一致，
            仅推进同步边界，不会重写区间。
        """
        normalized_index_code = index_code.strip()
        if not normalized_index_code:
            raise ValueError("index_code 不能为空")

        normalized_trade_date = normalize_trade_date(trade_date)
        normalized_vt_symbols = sorted(
            {vt_symbol.strip() for vt_symbol in vt_symbols if vt_symbol.strip()}
        )

        def operation(conn: sqlite3.Connection) -> bool:
            cur = conn.cursor()
            try:
                self._save_index_constituent_meta(
                    cur,
                    normalized_index_code,
                    normalized_trade_date,
                )
                previous_vt_symbols = self._load_effective_vt_symbols(
                    cur,
                    normalized_index_code,
                    normalized_trade_date,
                )
                if previous_vt_symbols == normalized_vt_symbols:
                    return True

                future_timeline = self._load_future_effective_sets(
                    cur,
                    normalized_index_code,
                    normalized_trade_date,
                )
                future_timeline[normalized_trade_date] = normalized_vt_symbols
                self._rewrite_membership_timeline_from_date(
                    cur,
                    normalized_index_code,
                    normalized_trade_date,
                    future_timeline,
                )
                return True
            finally:
                cur.close()

        return await self.storage.write_main(operation)

    async def load_index_constituent_meta(self, index_code: str) -> SQLiteRecord | None:
        """加载指数成分股同步边界。

        Args:
            index_code: 指数代码。

        Returns:
            若存在同步边界，返回包含 ``index_code``、``latest_trade_date``、
            ``last_sync_at`` 的字典；否则返回 ``None``。
        """
        normalized_index_code = index_code.strip()
        if not normalized_index_code:
            raise ValueError("index_code 不能为空")

        def operation(conn: sqlite3.Connection) -> SQLiteRecord | None:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT index_code, latest_trade_date, last_sync_at
                    FROM index_constituent_meta
                    WHERE index_code = ?
                    """,
                    (normalized_index_code,),
                )
                return fetchone_record(cur)
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def load_index_constituents(
        self,
        index_code: str,
        trade_date: str | date | datetime,
    ) -> list[str]:
        """按指数与交易日加载生效的成分股列表。

        Args:
            index_code: 指数代码。
            trade_date: 目标交易日，统一标准化为 ``YYYY-MM-DD``。

        Returns:
            目标交易日生效的成分股列表，按代码升序返回。若无有效区间，
            返回空列表。
        """
        normalized_index_code = index_code.strip()
        if not normalized_index_code:
            raise ValueError("index_code 不能为空")

        normalized_trade_date = normalize_trade_date(trade_date)

        def operation(conn: sqlite3.Connection) -> list[str]:
            cur = conn.cursor()
            try:
                return self._load_effective_vt_symbols(
                    cur,
                    normalized_index_code,
                    normalized_trade_date,
                )
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    def _load_effective_vt_symbols(
        self,
        cur: sqlite3.Cursor,
        index_code: str,
        trade_date: str,
    ) -> list[str]:
        """加载指定交易日生效的成分股列表。

        Args:
            cur: 当前事务游标。
            index_code: 指数代码。
            trade_date: 目标交易日。

        Returns:
            目标交易日生效的成分股列表。
        """
        cur.execute(
            """
            SELECT vt_symbol
            FROM index_constituent_membership
            WHERE index_code = ?
              AND start_date <= ?
              AND (end_date IS NULL OR end_date > ?)
            ORDER BY vt_symbol
            """,
            (index_code, trade_date, trade_date),
        )
        return [vt_symbol for (vt_symbol,) in cur.fetchall()]

    def _load_future_effective_sets(
        self,
        cur: sqlite3.Cursor,
        index_code: str,
        trade_date: str,
    ) -> dict[str, list[str]]:
        """加载指定日期及之后所有变更边界的有效集合。

        Args:
            cur: 当前事务游标。
            index_code: 指数代码。
            trade_date: 重写起点交易日。

        Returns:
            ``{交易日: 当日生效成分股列表}`` 映射。仅包含 ``trade_date``
            之后真实会改变有效集合的边界日期。
        """
        cur.execute(
            """
            SELECT DISTINCT boundary_date
            FROM (
                SELECT start_date AS boundary_date
                FROM index_constituent_membership
                WHERE index_code = ? AND start_date >= ?
                UNION
                SELECT end_date AS boundary_date
                FROM index_constituent_membership
                WHERE index_code = ? AND end_date IS NOT NULL AND end_date > ?
            )
            ORDER BY boundary_date
            """,
            (index_code, trade_date, index_code, trade_date),
        )
        boundary_dates = [boundary_date for (boundary_date,) in cur.fetchall()]
        if not boundary_dates:
            return {}

        last_boundary_date = boundary_dates[-1]
        cur.execute(
            """
            SELECT vt_symbol, start_date, end_date
            FROM index_constituent_membership
            WHERE index_code = ?
              AND start_date <= ?
              AND (end_date IS NULL OR end_date > ?)
            ORDER BY vt_symbol, start_date
            """,
            (index_code, last_boundary_date, trade_date),
        )
        membership_rows = [
            (
                vt_symbol,
                start_date,
                end_date,
            )
            for vt_symbol, start_date, end_date in cur.fetchall()
        ]

        future_sets: dict[str, list[str]] = {}
        for boundary_date in boundary_dates:
            future_sets[boundary_date] = sorted(
                vt_symbol
                for vt_symbol, start_date, end_date in membership_rows
                if start_date <= boundary_date and (end_date is None or end_date > boundary_date)
            )
        return future_sets

    def _rewrite_membership_timeline_from_date(
        self,
        cur: sqlite3.Cursor,
        index_code: str,
        trade_date: str,
        timeline_map: dict[str, list[str]],
    ) -> None:
        """从指定交易日起重建指数成分股区间。

        Args:
            cur: 当前事务游标。
            index_code: 指数代码。
            trade_date: 重写起点交易日。
            timeline_map: 交易日到“当日生效全集”的映射。该映射可以无序传入，
                方法内部会按交易日排序，并自动合并相邻重复集合。

        Returns:
            ``None``。
        """
        ordered_dates = sorted(timeline_map)
        if not ordered_dates:
            return

        self._truncate_memberships_from_date(cur, index_code, trade_date)

        deduped_dates: list[str] = []
        deduped_sets: list[set[str]] = []
        for current_date in ordered_dates:
            current_set = set(timeline_map[current_date])
            if deduped_sets and current_set == deduped_sets[-1]:
                continue
            deduped_dates.append(current_date)
            deduped_sets.append(current_set)

        membership_rows: list[tuple[str, str, str, str | None]] = []
        open_start_map: dict[str, str] = {
            vt_symbol: deduped_dates[0] for vt_symbol in deduped_sets[0]
        }
        for index in range(1, len(deduped_dates)):
            previous_set = deduped_sets[index - 1]
            current_set = deduped_sets[index]
            current_date = deduped_dates[index]

            removed_vt_symbols = sorted(previous_set - current_set)
            added_vt_symbols = sorted(current_set - previous_set)

            for vt_symbol in removed_vt_symbols:
                start_date = open_start_map.pop(vt_symbol)
                membership_rows.append((index_code, vt_symbol, start_date, current_date))
            for vt_symbol in added_vt_symbols:
                open_start_map[vt_symbol] = current_date

        for vt_symbol, start_date in sorted(open_start_map.items()):
            membership_rows.append((index_code, vt_symbol, start_date, None))

        self._insert_membership_rows(cur, membership_rows)
        affected_vt_symbols: set[str] = set()
        for vt_symbol_set in deduped_sets:
            affected_vt_symbols.update(vt_symbol_set)
        self._merge_adjacent_memberships(cur, index_code, affected_vt_symbols)

    def _truncate_memberships_from_date(
        self,
        cur: sqlite3.Cursor,
        index_code: str,
        trade_date: str,
    ) -> None:
        """截断指定交易日及之后的所有区间。

        Args:
            cur: 当前事务游标。
            index_code: 指数代码。
            trade_date: 重写起点交易日。

        Returns:
            ``None``。
        """
        cur.execute(
            """
            UPDATE index_constituent_membership
            SET end_date = ?, updated_at = datetime('now')
            WHERE index_code = ?
              AND start_date < ?
              AND (end_date IS NULL OR end_date > ?)
            """,
            (trade_date, index_code, trade_date, trade_date),
        )
        cur.execute(
            """
            DELETE FROM index_constituent_membership
            WHERE index_code = ? AND start_date >= ?
            """,
            (index_code, trade_date),
        )

    def _insert_membership_rows(
        self,
        cur: sqlite3.Cursor,
        rows: list[tuple[str, str, str, str | None]],
    ) -> None:
        """批量插入成员生效区间。

        Args:
            cur: 当前事务游标。
            rows: ``(index_code, vt_symbol, start_date, end_date)`` 形式的待插入行。
                ``end_date`` 为右开区间，``None`` 表示当前仍生效。

        Returns:
            ``None``。
        """
        if not rows:
            return

        cur.executemany(
            """
            INSERT INTO index_constituent_membership (
                index_code, vt_symbol, start_date, end_date, updated_at
            )
            VALUES (?, ?, ?, ?, datetime('now'))
            """,
            rows,
        )

    def _merge_adjacent_memberships(
        self,
        cur: sqlite3.Cursor,
        index_code: str,
        affected_vt_symbols: set[str],
    ) -> None:
        """合并同一成员首尾相接的相邻区间。

        Args:
            cur: 当前事务游标。
            index_code: 指数代码。
            affected_vt_symbols: 本次重写涉及的成分股 ``vt_symbol`` 集合。

        Returns:
            ``None``。
        """
        if not affected_vt_symbols:
            return

        rows: list[tuple[str, str, str | None]] = []
        sorted_vt_symbols = sorted(affected_vt_symbols)
        for start_index in range(0, len(sorted_vt_symbols), _SQLITE_IN_CHUNK_SIZE):
            chunk = sorted_vt_symbols[start_index : start_index + _SQLITE_IN_CHUNK_SIZE]
            placeholders = ", ".join("?" for _ in chunk)
            cur.execute(
                f"""
                SELECT vt_symbol, start_date, end_date
                FROM index_constituent_membership
                WHERE index_code = ? AND vt_symbol IN ({placeholders})
                ORDER BY vt_symbol, start_date
                """,
                (index_code, *chunk),
            )
            rows.extend(
                (
                    vt_symbol,
                    start_date,
                    end_date,
                )
                for vt_symbol, start_date, end_date in cur.fetchall()
            )
        def membership_sort_key(row: tuple[str, str, str | None]) -> tuple[str, str]:
            vt_symbol, start_date, _ = row
            return vt_symbol, start_date

        rows.sort(key=membership_sort_key)
        if len(rows) < 2:
            return

        previous_row = rows[0]
        for current_row in rows[1:]:
            previous_vt_symbol, previous_start, previous_end = previous_row
            current_vt_symbol, current_start, current_end = current_row
            if previous_vt_symbol == current_vt_symbol and previous_end == current_start:
                cur.execute(
                    """
                    UPDATE index_constituent_membership
                    SET end_date = ?, updated_at = datetime('now')
                    WHERE index_code = ? AND vt_symbol = ? AND start_date = ?
                    """,
                    (current_end, index_code, previous_vt_symbol, previous_start),
                )
                cur.execute(
                    """
                    DELETE FROM index_constituent_membership
                    WHERE index_code = ? AND vt_symbol = ? AND start_date = ?
                    """,
                    (index_code, current_vt_symbol, current_start),
                )
                previous_row = (previous_vt_symbol, previous_start, current_end)
                continue
            previous_row = current_row

    def _save_index_constituent_meta(
        self,
        cur: sqlite3.Cursor,
        index_code: str,
        latest_trade_date: str,
    ) -> None:
        """推进指数成分股同步边界。

        Args:
            cur: 当前事务游标。
            index_code: 指数代码。
            latest_trade_date: 最新已处理交易日。

        Returns:
            ``None``。
        """
        cur.execute(
            """
            INSERT INTO index_constituent_meta (
                index_code, latest_trade_date, last_sync_at
            )
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(index_code) DO UPDATE SET
                latest_trade_date = CASE
                    WHEN excluded.latest_trade_date > index_constituent_meta.latest_trade_date
                    THEN excluded.latest_trade_date
                    ELSE index_constituent_meta.latest_trade_date
                END,
                last_sync_at = excluded.last_sync_at
            """,
            (index_code, latest_trade_date),
        )
