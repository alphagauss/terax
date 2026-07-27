from __future__ import annotations

import sqlite3
from datetime import date, datetime
from typing import Sequence

from alpha.common.schema_market import (
    SecurityDailyInfoQuery,
    SecurityDailyInfoRecord,
    SecurityProfilePayload,
    SecurityProfileQuery,
    SecurityStatusEventPayload,
    SecurityStatusMetaPayload,
)
from alpha.storage.base import SQLiteStorageBase
from alpha.storage.repositories.sqlite_rows import (
    SQLiteRecord,
    fetchall_records,
    fetchone_record,
)
from alpha.storage.transforms import normalize_trade_date

_STATUS_TABLE_MAP = {
    "suspended": "security_suspended_day",
    "st": "security_st_day",
}

_SECURITY_STATUS_META_UPSERT_SQL = """
    INSERT INTO security_status_meta (
        vt_symbol, latest_checked_trade_date, latest_data_trade_date, is_terminal, updated_at
    )
    VALUES (
        :vt_symbol, :latest_checked_trade_date, :latest_data_trade_date, :is_terminal, :updated_at
    )
    ON CONFLICT(vt_symbol) DO UPDATE SET
        latest_checked_trade_date = CASE
            WHEN excluded.latest_checked_trade_date > security_status_meta.latest_checked_trade_date
            THEN excluded.latest_checked_trade_date
            ELSE security_status_meta.latest_checked_trade_date
        END,
        latest_data_trade_date = CASE
            WHEN excluded.latest_data_trade_date IS NULL THEN security_status_meta.latest_data_trade_date
            WHEN security_status_meta.latest_data_trade_date IS NULL THEN excluded.latest_data_trade_date
            WHEN excluded.latest_data_trade_date > security_status_meta.latest_data_trade_date
            THEN excluded.latest_data_trade_date
            ELSE security_status_meta.latest_data_trade_date
        END,
        is_terminal = CASE
            WHEN security_status_meta.is_terminal = 1 OR excluded.is_terminal = 1
            THEN 1
            ELSE 0
        END,
        updated_at = excluded.updated_at
    """


class SecurityRepository:
    """管理证券静态资料与状态事件。"""

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage

    async def save_security_profiles(self, rows: list[SecurityProfilePayload]) -> bool:
        """保存证券静态资料。"""
        if not rows:
            return False

        deduped_rows: dict[str, SQLiteRecord] = {}
        for row in rows:
            deduped_rows[str(row["vt_symbol"])] = {
                "vt_symbol": row["vt_symbol"],
                "asset_type": row["asset_type"],
                "board": row.get("board"),
                "sec_name": row.get("sec_name"),
                "sec_abbr": row.get("sec_abbr"),
                "price_tick": row.get("price_tick"),
                "trade_n": row.get("trade_n"),
                "listed_date": row.get("listed_date"),
                "delisted_date": row.get("delisted_date"),
            }

        def operation(conn: sqlite3.Connection) -> bool:
            cur = conn.cursor()
            try:
                cur.executemany(
                    """
                    INSERT INTO security_profile (
                        vt_symbol, asset_type, board, sec_name, sec_abbr, price_tick, trade_n, listed_date, delisted_date
                    )
                    VALUES (
                        :vt_symbol, :asset_type, :board, :sec_name, :sec_abbr, :price_tick, :trade_n, :listed_date, :delisted_date
                    )
                    ON CONFLICT(vt_symbol) DO UPDATE SET
                        asset_type = excluded.asset_type,
                        board = COALESCE(excluded.board, security_profile.board),
                        sec_name = COALESCE(excluded.sec_name, security_profile.sec_name),
                        sec_abbr = COALESCE(excluded.sec_abbr, security_profile.sec_abbr),
                        price_tick = COALESCE(excluded.price_tick, security_profile.price_tick),
                        trade_n = COALESCE(excluded.trade_n, security_profile.trade_n),
                        listed_date = COALESCE(excluded.listed_date, security_profile.listed_date),
                        delisted_date = COALESCE(excluded.delisted_date, security_profile.delisted_date)
                    """,
                    list(deduped_rows.values()),
                )
                return True
            finally:
                cur.close()

        return await self.storage.write_main(operation)

    async def load_security_profiles(self, query: SecurityProfileQuery) -> list[SQLiteRecord]:
        """按统一查询条件加载证券静态资料。

        Args:
            query: 证券基本信息查询条件。``vt_symbols=None`` 表示不过滤证券代码，
                ``vt_symbols=[]`` 表示返回空结果；``asset_type`` 会与证券代码过滤
                条件共同生效。

        Returns:
            匹配条件的证券基本信息列表，按 ``vt_symbol`` 升序返回。
        """
        normalized_symbols: tuple[str, ...] | None = None
        if query.vt_symbols is not None:
            normalized_symbols = tuple(
                dict.fromkeys(vt_symbol.strip() for vt_symbol in query.vt_symbols if vt_symbol.strip())
            )
            if not normalized_symbols:
                return []

        asset_type = None if query.asset_type is None else query.asset_type.strip()
        conditions: list[str] = []
        params: list[str] = []
        if normalized_symbols is not None:
            placeholders = ", ".join("?" for _ in normalized_symbols)
            conditions.append(f"vt_symbol IN ({placeholders})")
            params.extend(normalized_symbols)
        if asset_type:
            conditions.append("asset_type = ?")
            params.append(asset_type)

        where_sql = "" if not conditions else f"WHERE {' AND '.join(conditions)}"

        def operation(conn: sqlite3.Connection) -> list[SQLiteRecord]:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"""
                    SELECT vt_symbol, asset_type, board, sec_name, sec_abbr, price_tick, trade_n, listed_date, delisted_date
                    FROM security_profile
                    {where_sql}
                    ORDER BY vt_symbol
                    """,
                    params,
                )
                return fetchall_records(cur)
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def load_security_daily_info(
        self,
        query: SecurityDailyInfoQuery,
        trade_dates: Sequence[str | date | datetime],
    ) -> list[SecurityDailyInfoRecord]:
        """按证券和交易日加载逐日状态信息。

        Args:
            query: 证券逐日状态查询条件。
            trade_dates: 由数据库门面基于 ``trade_date.csv`` 截取出的交易日序列，
                仓储层会再次按 ``[start, end]`` 过滤并补齐无事件日期。

        Returns:
            每个请求证券、每个请求交易日对应一行的状态记录，包含
            ``is_suspended`` 与 ``is_st`` 布尔字段。
        """
        normalized_symbols = tuple(
            dict.fromkeys(vt_symbol.strip() for vt_symbol in query.vt_symbols if vt_symbol.strip())
        )
        if not normalized_symbols:
            return []

        start_date = normalize_trade_date(query.start)
        end_date = normalize_trade_date(query.end)
        trade_dates = sorted(
            {
                normalized_date
                for item in trade_dates
                if start_date <= (normalized_date := normalize_trade_date(item)) <= end_date
            }
        )
        if not trade_dates:
            return []

        suspended_keys = await self._load_status_event_keys(
            "suspended",
            normalized_symbols,
            trade_dates[0],
            trade_dates[-1],
        )
        st_keys = await self._load_status_event_keys(
            "st",
            normalized_symbols,
            trade_dates[0],
            trade_dates[-1],
        )

        rows: list[SecurityDailyInfoRecord] = []
        for vt_symbol in normalized_symbols:
            for trade_date in trade_dates:
                key = (vt_symbol, trade_date)
                rows.append(
                    {
                        "vt_symbol": vt_symbol,
                        "trade_date": trade_date,
                        "is_suspended": key in suspended_keys,
                        "is_st": key in st_keys,
                    }
                )
        return rows

    async def save_suspended_day_events(self, rows: list[SecurityStatusEventPayload]) -> bool:
        """批量保存停牌交易日事件。"""
        return await self._save_status_event_rows("suspended", rows)

    async def save_st_day_events(self, rows: list[SecurityStatusEventPayload]) -> bool:
        """批量保存 ST 交易日事件。"""
        return await self._save_status_event_rows("st", rows)

    async def save_security_status_meta(
        self,
        vt_symbol: str,
        latest_checked_trade_date: str | date | datetime,
        latest_data_trade_date: str | date | datetime | None = None,
        is_terminal: bool = False,
    ) -> None:
        """更新单个证券状态同步游标。"""
        row: SecurityStatusMetaPayload = {
            "vt_symbol": vt_symbol,
            "latest_checked_trade_date": normalize_trade_date(latest_checked_trade_date),
            "latest_data_trade_date": (
                None if latest_data_trade_date is None else normalize_trade_date(latest_data_trade_date)
            ),
            "is_terminal": is_terminal,
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        await self._save_security_status_meta_rows([row])

    async def save_security_status_metas(self, rows: list[SecurityStatusMetaPayload]) -> bool:
        """批量更新证券状态同步游标。"""
        if not rows:
            return False

        deduped_rows = self._dedupe_security_status_meta_rows(rows)
        return await self._save_security_status_meta_rows(deduped_rows)

    async def _save_security_status_meta_rows(self, rows: list[SecurityStatusMetaPayload]) -> bool:
        """批量写入已归一化的证券状态同步游标。"""
        if not rows:
            return False

        def operation(conn: sqlite3.Connection) -> bool:
            cur = conn.cursor()
            try:
                cur.executemany(_SECURITY_STATUS_META_UPSERT_SQL, rows)
                return True
            finally:
                cur.close()

        return await self.storage.write_main(operation)

    def _dedupe_security_status_meta_rows(
        self,
        rows: list[SecurityStatusMetaPayload],
    ) -> list[SecurityStatusMetaPayload]:
        """按证券代码归并同批游标，仅保留可推进状态。"""
        deduped_rows: dict[str, SecurityStatusMetaPayload] = {}
        for row in rows:
            normalized_row = self._normalize_security_status_meta_row(row)
            vt_symbol = str(normalized_row["vt_symbol"])
            current_row = deduped_rows.get(vt_symbol)
            if current_row is None:
                deduped_rows[vt_symbol] = normalized_row
                continue

            current_checked_trade_date = str(current_row["latest_checked_trade_date"])
            next_checked_trade_date = str(normalized_row["latest_checked_trade_date"])
            merged_row = current_row.copy()
            if next_checked_trade_date > current_checked_trade_date:
                merged_row["latest_checked_trade_date"] = normalized_row["latest_checked_trade_date"]
                merged_row["updated_at"] = normalized_row["updated_at"]

            current_data_trade_date = current_row.get("latest_data_trade_date")
            next_data_trade_date = normalized_row.get("latest_data_trade_date")
            if current_data_trade_date is None or (
                next_data_trade_date is not None and str(next_data_trade_date) > str(current_data_trade_date)
            ):
                merged_row["latest_data_trade_date"] = next_data_trade_date

            merged_row["is_terminal"] = bool(current_row.get("is_terminal", False)) or bool(
                normalized_row.get("is_terminal", False)
            )
            deduped_rows[vt_symbol] = merged_row

        return list(deduped_rows.values())

    def _normalize_security_status_meta_row(
        self,
        row: SecurityStatusMetaPayload,
    ) -> SecurityStatusMetaPayload:
        """标准化证券状态同步游标写入行。"""
        return {
            "vt_symbol": str(row["vt_symbol"]),
            "latest_checked_trade_date": normalize_trade_date(str(row["latest_checked_trade_date"])),
            "latest_data_trade_date": (
                None
                if row.get("latest_data_trade_date") is None
                else normalize_trade_date(str(row["latest_data_trade_date"]))
            ),
            "is_terminal": bool(row.get("is_terminal", False)),
            "updated_at": str(row.get("updated_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        }

    async def load_security_status_meta(self, vt_symbol: str) -> SQLiteRecord | None:
        """加载单个证券状态同步游标。"""

        def operation(conn: sqlite3.Connection) -> SQLiteRecord | None:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, latest_checked_trade_date, latest_data_trade_date, is_terminal, updated_at
                    FROM security_status_meta
                    WHERE vt_symbol = ?
                    """,
                    (vt_symbol,),
                )
                return fetchone_record(cur)
            finally:
                cur.close()

        row = await self.storage.read_main(operation)
        if row is None:
            return None

        return self._build_security_status_meta_result(row)

    async def load_security_status_metas(self) -> dict[str, SQLiteRecord]:
        """加载全部证券状态同步游标。"""

        def operation(conn: sqlite3.Connection) -> list[SQLiteRecord]:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, latest_checked_trade_date, latest_data_trade_date, is_terminal, updated_at
                    FROM security_status_meta
                    ORDER BY vt_symbol
                    """
                )
                return fetchall_records(cur)
            finally:
                cur.close()

        rows = await self.storage.read_main(operation)
        return {
            row["vt_symbol"]: self._build_security_status_meta_result(row)
            for row in rows
        }

    async def _save_status_event_rows(
        self,
        status_type: str,
        rows: list[SecurityStatusEventPayload],
    ) -> bool:
        """批量保存状态事件行。"""
        if not rows:
            return False

        table_name = self._get_status_table_name(status_type)
        deduped_rows: dict[tuple[str, str], SecurityStatusEventPayload] = {}
        for row in rows:
            vt_symbol = str(row["vt_symbol"]).strip()
            if not vt_symbol:
                continue
            trade_date = normalize_trade_date(row["trade_date"])
            deduped_rows[(vt_symbol, trade_date)] = {
                "vt_symbol": vt_symbol,
                "trade_date": trade_date,
            }
        if not deduped_rows:
            return False

        def operation(conn: sqlite3.Connection) -> bool:
            cur = conn.cursor()
            try:
                cur.executemany(
                    f"""
                    INSERT OR IGNORE INTO {table_name} (
                        vt_symbol, trade_date
                    )
                    VALUES (
                        :vt_symbol, :trade_date
                    )
                    """,
                    list(deduped_rows.values()),
                )
                return True
            finally:
                cur.close()

        return await self.storage.write_main(operation)

    async def _load_status_event_keys(
        self,
        status_type: str,
        vt_symbols: Sequence[str],
        start: str,
        end: str,
    ) -> set[tuple[str, str]]:
        """批量加载状态事件主键集合。

        Args:
            status_type: 状态事件类型，支持 ``suspended`` 与 ``st``。
            vt_symbols: 已去重的项目内部标准证券代码序列。
            start: 查询开始交易日。
            end: 查询结束交易日。

        Returns:
            ``{(vt_symbol, trade_date)}`` 形式的事件集合。
        """
        table_name = self._get_status_table_name(status_type)
        placeholders = ", ".join("?" for _ in vt_symbols)

        def operation(conn: sqlite3.Connection) -> list[tuple[str, str]]:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"""
                    SELECT vt_symbol, trade_date
                    FROM {table_name}
                    WHERE vt_symbol IN ({placeholders})
                      AND trade_date BETWEEN ? AND ?
                    ORDER BY vt_symbol, trade_date
                    """,
                    (*vt_symbols, start, end),
                )
                return cur.fetchall()
            finally:
                cur.close()

        rows = await self.storage.read_main(operation)
        return {(vt_symbol, trade_date) for vt_symbol, trade_date in rows}

    def _build_security_status_meta_result(self, row: SQLiteRecord) -> SQLiteRecord:
        """保留证券状态游标字段，仅将终态标记恢复为布尔值。"""
        return {
            **row,
            "is_terminal": bool(row["is_terminal"]),
        }

    def _get_status_table_name(self, status_type: str) -> str:
        """获取状态事件表名，并限制在白名单范围内。"""
        try:
            return _STATUS_TABLE_MAP[status_type]
        except KeyError as exc:
            raise ValueError(f"不支持的状态事件类型: {status_type}") from exc
