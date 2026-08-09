"""Alpha 数据目录的联合查询与全局概览聚合。

本模块只读取主库中的证券资料和 K 线概览，不访问行情分片。证券目录使用
两类数据的代码并集，确保资料缺失或行情缺失的记录仍可被数据管理页发现。
"""

from __future__ import annotations

import sqlite3

from alpha.common.schema_market import SecurityCatalogQuery
from alpha.storage.base import SQLiteStorageBase
from alpha.storage.repositories.sqlite_rows import (
    SQLiteRecord,
    fetchall_records,
    fetchone_record,
)

_CATALOG_CTE = """
WITH catalog_symbols AS (
    SELECT vt_symbol FROM security_profile
    UNION
    SELECT vt_symbol FROM bar_overview
),
catalog AS (
    SELECT
        symbols.vt_symbol,
        CASE
            WHEN instr(symbols.vt_symbol, '.') > 0
            THEN substr(symbols.vt_symbol, 1, instr(symbols.vt_symbol, '.') - 1)
            ELSE symbols.vt_symbol
        END AS symbol,
        CASE
            WHEN instr(symbols.vt_symbol, '.') > 0
            THEN substr(symbols.vt_symbol, instr(symbols.vt_symbol, '.') + 1)
            ELSE ''
        END AS exchange,
        profile.asset_type,
        profile.board,
        profile.sec_name,
        profile.sec_abbr,
        profile.price_tick,
        profile.trade_n,
        profile.listed_date,
        profile.delisted_date,
        CASE WHEN profile.vt_symbol IS NULL THEN 0 ELSE 1 END AS has_profile,
        CASE WHEN COUNT(overview.vt_symbol) = 0 THEN 0 ELSE 1 END AS has_bars,
        COALESCE(SUM(overview.count), 0) AS total_bar_count,
        MIN(overview.start) AS data_start,
        MAX(overview.end) AS data_end,
        MAX(overview.updated_at) AS latest_updated_at
    FROM catalog_symbols AS symbols
    LEFT JOIN security_profile AS profile ON profile.vt_symbol = symbols.vt_symbol
    LEFT JOIN bar_overview AS overview ON overview.vt_symbol = symbols.vt_symbol
    GROUP BY symbols.vt_symbol
),
catalog_view AS (
    SELECT
        *,
        COALESCE(NULLIF(TRIM(sec_abbr), ''), NULLIF(TRIM(sec_name), ''), symbol) AS name,
        CASE
            WHEN has_profile = 1 AND has_bars = 1 THEN 'complete'
            WHEN has_profile = 1 THEN 'profile_only'
            ELSE 'bars_only'
        END AS data_state,
        CASE
            WHEN delisted_date IS NOT NULL AND TRIM(delisted_date) <> '' THEN 'delisted'
            ELSE 'active'
        END AS status
    FROM catalog
)
"""


class DataCatalogRepository:
    """联合查询证券静态资料、行情覆盖和数据概览。"""

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage

    async def query_securities(self, query: SecurityCatalogQuery) -> dict[str, object]:
        """按关键词和 Facet 条件查询证券目录分页。"""
        where_sql, params = self._build_filters(query)

        def operation(conn: sqlite3.Connection) -> dict[str, object]:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"{_CATALOG_CTE} SELECT COUNT(*) AS total FROM catalog_view {where_sql}",
                    params,
                )
                total_row = fetchone_record(cur)
                total = 0 if total_row is None else int(total_row["total"])

                cur.execute(
                    f"""
                    {_CATALOG_CTE}
                    SELECT vt_symbol, symbol, exchange, name, asset_type, board,
                           listed_date, delisted_date, status, data_state,
                           total_bar_count, data_start, data_end, latest_updated_at
                    FROM catalog_view
                    {where_sql}
                    ORDER BY vt_symbol
                    LIMIT ? OFFSET ?
                    """,
                    [*params, query.limit, query.offset],
                )
                items = fetchall_records(cur)
                self._attach_coverage(cur, items)
                return {
                    "items": items,
                    "total": total,
                    "limit": query.limit,
                    "offset": query.offset,
                }
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def get_security(self, vt_symbol: str) -> dict[str, object] | None:
        """读取单个证券的完整资料和行情覆盖摘要。"""

        def operation(conn: sqlite3.Connection) -> dict[str, object] | None:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"""
                    {_CATALOG_CTE}
                    SELECT vt_symbol, symbol, exchange, name, asset_type, board,
                           sec_name, sec_abbr, price_tick, trade_n, listed_date,
                           delisted_date, status, data_state, total_bar_count,
                           data_start, data_end, latest_updated_at
                    FROM catalog_view
                    WHERE vt_symbol = ?
                    """,
                    (vt_symbol,),
                )
                item = fetchone_record(cur)
                if item is None:
                    return None
                self._attach_coverage(cur, [item])
                return item
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def get_overview(self) -> dict[str, object]:
        """聚合 union 证券目录的全局摘要和 Facets。"""

        def operation(conn: sqlite3.Connection) -> dict[str, object]:
            cur = conn.cursor()
            try:
                cur.execute(f"""
                    {_CATALOG_CTE}
                    SELECT
                        COUNT(*) AS security_count,
                        COALESCE(SUM(has_profile), 0) AS profile_count,
                        COALESCE(SUM(has_bars), 0) AS bar_security_count,
                        COALESCE(SUM(total_bar_count), 0) AS total_bar_count,
                        MIN(data_start) AS data_start,
                        MAX(data_end) AS data_end,
                        MAX(latest_updated_at) AS latest_updated_at
                    FROM catalog_view
                    """)
                summary = fetchone_record(cur) or {}

                cur.execute(f"""
                    {_CATALOG_CTE}
                    SELECT 'exchange' AS facet, COALESCE(NULLIF(exchange, ''), 'unknown') AS value,
                           COUNT(*) AS security_count, NULL AS row_count
                    FROM catalog_view GROUP BY COALESCE(NULLIF(exchange, ''), 'unknown')
                    UNION ALL
                    SELECT 'asset_type', COALESCE(NULLIF(asset_type, ''), 'unknown'),
                           COUNT(*), NULL
                    FROM catalog_view GROUP BY COALESCE(NULLIF(asset_type, ''), 'unknown')
                    UNION ALL
                    SELECT 'data_state', data_state, COUNT(*), NULL
                    FROM catalog_view GROUP BY data_state
                    UNION ALL
                    SELECT 'interval', interval, COUNT(*), COALESCE(SUM(count), 0)
                    FROM bar_overview GROUP BY interval
                    ORDER BY facet, value
                    """)
                facet_rows = fetchall_records(cur)
            finally:
                cur.close()

            facets: dict[str, list[SQLiteRecord]] = {
                "exchanges": [],
                "asset_types": [],
                "data_states": [],
                "intervals": [],
            }
            facet_keys = {
                "exchange": "exchanges",
                "asset_type": "asset_types",
                "data_state": "data_states",
                "interval": "intervals",
            }
            for row in facet_rows:
                key = facet_keys[str(row.pop("facet"))]
                if key == "intervals":
                    facets[key].append(row)
                else:
                    row.pop("row_count", None)
                    row["count"] = row.pop("security_count")
                    facets[key].append(row)
            return {"summary": summary, "facets": facets}

        return await self.storage.read_main(operation)

    def _build_filters(self, query: SecurityCatalogQuery) -> tuple[str, list[str]]:
        """构造参数化目录过滤条件，避免用户输入进入 SQL 结构。"""
        conditions: list[str] = []
        params: list[str] = []
        keyword = (query.keyword or "").strip().lower()
        if keyword:
            conditions.append(
                "(instr(lower(vt_symbol), ?) > 0 OR instr(lower(symbol), ?) > 0 "
                "OR instr(lower(COALESCE(sec_name, '')), ?) > 0 "
                "OR instr(lower(COALESCE(sec_abbr, '')), ?) > 0)"
            )
            params.extend([keyword] * 4)
        if exchange := (query.exchange or "").strip():
            conditions.append("lower(COALESCE(NULLIF(exchange, ''), 'unknown')) = ?")
            params.append(exchange.lower())
        if asset_type := (query.asset_type or "").strip():
            conditions.append("COALESCE(NULLIF(asset_type, ''), 'unknown') = ?")
            params.append(asset_type)
        if query.data_state:
            conditions.append("data_state = ?")
            params.append(query.data_state)
        if interval := (query.interval or "").strip():
            conditions.append(
                "EXISTS (SELECT 1 FROM bar_overview AS selected_overview "
                "WHERE selected_overview.vt_symbol = catalog_view.vt_symbol "
                "AND selected_overview.interval = ?)"
            )
            params.append(interval)
        return ("" if not conditions else f"WHERE {' AND '.join(conditions)}", params)

    def _attach_coverage(
        self,
        cur: sqlite3.Cursor,
        items: list[SQLiteRecord],
    ) -> None:
        """批量附加当前页证券的分周期行情覆盖，避免逐条查询。"""
        if not items:
            return
        symbols = [str(item["vt_symbol"]) for item in items]
        placeholders = ", ".join("?" for _ in symbols)
        cur.execute(
            f"""
            SELECT vt_symbol, interval, start, end, count AS rows, updated_at
            FROM bar_overview
            WHERE vt_symbol IN ({placeholders})
            ORDER BY vt_symbol, interval
            """,
            symbols,
        )
        coverage_by_symbol: dict[str, dict[str, SQLiteRecord]] = {
            symbol: {} for symbol in symbols
        }
        for row in fetchall_records(cur):
            vt_symbol = str(row.pop("vt_symbol"))
            interval = str(row.pop("interval"))
            coverage_by_symbol[vt_symbol][interval] = row
        for item in items:
            coverage = coverage_by_symbol[str(item["vt_symbol"])]
            item["coverage"] = coverage
            item["intervals"] = list(coverage)
