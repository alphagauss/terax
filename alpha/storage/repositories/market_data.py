from __future__ import annotations

import asyncio
import sqlite3
from collections import defaultdict
from collections.abc import Awaitable, Iterable, Sequence
from datetime import datetime
from typing import TypeVar

from alpha.common.schema_core import datetime_to_timestr
from alpha.common.schema_market import AdjustFactorPayload, BarDataPayload, BarDataQuery
from alpha.storage.base import SQLiteStorageBase
from alpha.storage.repositories.sqlite_rows import (
    SQLiteRecord,
    fetchall_records,
    fetchone_record,
)
from alpha.storage.transforms import (
    apply_adjustment,
    build_adjust_factor_meta_rows,
    build_sparse_adjust_factor_rows,
    collect_adjust_factor_first_trade_dates,
    extract_trade_date,
)

T = TypeVar("T")


class MarketDataRepository:
    """管理行情与复权因子读写。"""

    _BAR_KEY_FIELDS: tuple[str, ...] = ("vt_symbol", "datetime")
    _BAR_REQUIRED_PRICE_FIELDS: tuple[str, ...] = ("volume", "open", "high", "low", "close")
    _BAR_OPTIONAL_PRICE_FIELDS: tuple[str, ...] = ("turnover", "open_interest")
    _BAR_LIMIT_FIELDS: tuple[str, ...] = ("upper_limit", "lower_limit")
    _MAX_CONCURRENT_SQLITE_TASKS = 16
    _SQLITE_IN_CHUNK_SIZE = 900

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage
        self._overview_update_lock = asyncio.Lock()

    async def _gather_limited(self, awaitables: Iterable[Awaitable[T]]) -> list[T]:
        """按固定并发上限执行 SQLite 分片任务。"""
        semaphore = asyncio.Semaphore(self._MAX_CONCURRENT_SQLITE_TASKS)

        async def run(awaitable: Awaitable[T]) -> T:
            async with semaphore:
                return await awaitable

        return await asyncio.gather(*(run(awaitable) for awaitable in awaitables))

    async def save_bar_data(
        self,
        bars: list[BarDataPayload],
        *,
        adjust: str,
        update_overview: bool = True,
    ) -> bool:
        """保存已标准化的原始 K 线数据。
        本方法只负责将上游脚本已治理完成的原始行情写入 SQLite 分片库，
        并按需刷新 ``bar_overview``。数据库层不再负责字段清洗、格式推断、
        缺失值补全或 ``BarData`` 对象兼容，新增数据源时应先在上游适配层完成治理。

        Args:
            bars: 已标准化的 K 线字典列表。每条记录都必须包含
                ``vt_symbol``、``datetime`` 两个入库主键字段，并必须包含
                ``interval`` 用于定位分片与判定字段语义。
                同一次调用中的记录必须使用一致的字段集合与写入模式，
                仓储层会按首条记录确定本批 SQL 结构，后续记录若字段不一致
                将直接报错，调用方应先按来源与字段形态完成分批。
                若记录包含 ``volume``、``open``、``high``、``low``、``close``，
                则视为主行情写入，仓储层会插入新行或更新已有行；此时
                ``turnover``、``open_interest`` 为可选字段，未提供时不显式入库，
                由 SQLite 列默认值或历史值接管。
                若日线记录仅包含 ``upper_limit``、``lower_limit``，则视为
                限价补写，仓储层只更新这两个字段，不触碰其他列。
                非日线记录即使携带 ``upper_limit``、``lower_limit``，
                也不会显式写入数据库。
                其中 ``vt_symbol`` 必须是项目内部标准格式，如 ``000001.SZSE``；
                ``datetime`` 必须是 ``YYYY-MM-DD HH:MM:SS``；
                ``interval`` 必须使用项目内部约定值，如 ``1m``、``1h``、``d``、``w``。
            adjust: 本批数据的价格口径，调用时必须显式传入 ``"non"``。
                当前数据库仅允许不复权原始行情入库，不接受前复权或后复权数据。
            update_overview: 是否在写入后刷新本批涉及标的的 ``bar_overview``。

        Returns:
            写入成功返回 ``True``，空列表返回 ``False``。
        """
        if adjust != "non":
            raise ValueError("save_bar_data 当前仅支持 adjust='non' 的原始行情入库")
        if not bars:
            return False

        partitioned_bars = self._group_bars_by_partition(bars)
        touched_symbols_by_interval: dict[str, set[str]] = defaultdict(set)

        async def write_partition(file_name: str, rows: list[BarDataPayload]) -> None:
            sql, normalized_rows = self._prepare_bar_write_statement(rows)

            def operation(conn: sqlite3.Connection) -> None:
                cur = conn.cursor()
                try:
                    # 单批次字段一致时复用同一条 SQL，避免重复判定写入模式与字段集合。
                    cur.executemany(sql, normalized_rows)
                finally:
                    cur.close()

            await self.storage.write_partition(file_name, operation)

        await self._gather_limited(
            write_partition(file_name, rows) for file_name, rows in partitioned_bars.items()
        )

        if update_overview:
            for rows in partitioned_bars.values():
                for row in rows:
                    touched_symbols_by_interval[str(row["interval"])].add(str(row["vt_symbol"]))
            await self._update_bar_overview(touched_symbols_by_interval)
        return True

    def _prepare_bar_write_statement(
        self,
        rows: list[BarDataPayload],
    ) -> tuple[str, list[SQLiteRecord]]:
        """按首条记录确定批量写入 SQL，并校验后续记录字段一致性。

        Args:
            rows: 同一分片内待写入的 K 线记录。

        Returns:
            返回 ``(SQL, 标准化参数列表)``。

        Raises:
            ValueError: 当同批记录的字段集合或写入模式不一致时抛出。
        """
        first_mode, first_columns, first_row = self._build_bar_write_payload(rows[0])
        normalized_rows: list[SQLiteRecord] = [first_row]

        for row in rows[1:]:
            current_mode, current_columns, normalized_row = self._build_bar_write_payload(row)
            if current_mode != first_mode or current_columns != first_columns:
                raise ValueError(
                    "save_bar_data 要求同一批记录字段一致，请按字段形态拆分后再调用"
                )
            normalized_rows.append(normalized_row)

        return self._build_bar_write_sql(first_mode, first_columns), normalized_rows

    def _build_bar_write_payload(
        self,
        row: BarDataPayload,
    ) -> tuple[str, tuple[str, ...], SQLiteRecord]:
        """根据单条记录生成写入模式、字段集合与参数。

        Args:
            row: 单条标准化 K 线记录。

        Returns:
            返回 ``(写入模式, 字段集合, 参数字典)``。

        Raises:
            ValueError: 当记录既不是完整主行情，也不是可执行的日线限价补写时抛出。
        """
        # 先校验分片上下文和主键字段，后续所有写入模式都依赖这组字段定位记录。
        if "interval" not in row:
            raise ValueError("save_bar_data 缺少分片字段: interval")
        for field in self._BAR_KEY_FIELDS:
            if field not in row:
                raise ValueError(f"save_bar_data 缺少主键字段: {field}")

        interval = str(row["interval"])
        has_price_payload = any(field in row for field in self._BAR_REQUIRED_PRICE_FIELDS)
        has_limit_payload = interval == "d" and any(field in row for field in self._BAR_LIMIT_FIELDS)

        # 主行情写入要求五个价格字段齐全，可选列只在本次显式提供时参与写入。
        if has_price_payload:
            missing_price_fields = [
                field for field in self._BAR_REQUIRED_PRICE_FIELDS if field not in row
            ]
            if missing_price_fields:
                raise ValueError(
                    f"save_bar_data 主行情记录缺少必填字段: {', '.join(missing_price_fields)}"
                )

            columns = list(self._BAR_KEY_FIELDS)
            columns.extend(self._BAR_REQUIRED_PRICE_FIELDS)
            columns.extend(
                field for field in self._BAR_OPTIONAL_PRICE_FIELDS if field in row
            )
            if interval == "d":
                columns.extend(field for field in self._BAR_LIMIT_FIELDS if field in row)

            return (
                "upsert",
                tuple(columns),
                {column: row[column] for column in columns},
            )

        # 日线限价独立补写只更新涨跌停字段，避免覆盖既有行情列。
        if has_limit_payload:
            columns = [*self._BAR_KEY_FIELDS]
            columns.extend(field for field in self._BAR_LIMIT_FIELDS if field in row)
            return (
                "update",
                tuple(columns),
                {column: row[column] for column in columns},
            )

        raise ValueError("save_bar_data 记录未包含可写入的行情字段或日线限价字段")

    def _build_bar_write_sql(
        self,
        write_mode: str,
        columns: tuple[str, ...],
    ) -> str:
        """根据写入模式和字段集合构造 SQL。

        Args:
            write_mode: 写入模式。
                ``upsert`` 表示“存在则更新，不存在则插入”，用于主行情写入；
                ``update`` 表示“仅更新已有记录，不负责插入”，用于日线涨跌停价补写。
            columns: 本组记录实际参与写入的字段集合。

        Returns:
            可直接传给 ``executemany`` 的 SQL 字符串。

        Raises:
            ValueError: 当写入模式不受支持时抛出。
        """
        if write_mode == "upsert":
            non_key_columns = [
                column for column in columns if column not in self._BAR_KEY_FIELDS
            ]
            update_assignments = ",\n                        ".join(
                f"{column} = excluded.{column}" for column in non_key_columns
            )
            return f"""
                    INSERT INTO bardata (
                        {", ".join(columns)}
                    )
                    VALUES (
                        {", ".join(f":{column}" for column in columns)}
                    )
                    ON CONFLICT(vt_symbol, datetime) DO UPDATE SET
                        {update_assignments}
                    """

        if write_mode == "update":
            update_columns = [
                column for column in columns if column not in self._BAR_KEY_FIELDS
            ]
            return f"""
                    UPDATE bardata
                    SET {", ".join(f"{column} = :{column}" for column in update_columns)}
                    WHERE vt_symbol = :vt_symbol
                      AND datetime = :datetime
                    """

        raise ValueError(f"不支持的 K 线写入模式: {write_mode}")

    async def save_adjust_factors(self, factors: list[AdjustFactorPayload]) -> bool:
        """保存累计复权因子。"""
        if not factors:
            return False

        meta_rows = build_adjust_factor_meta_rows(
            factors,
            last_sync_at=datetime_to_timestr(datetime.now()),
        )
        first_trade_date_by_symbol = collect_adjust_factor_first_trade_dates(factors)
        latest_factor_by_symbol = await self._load_latest_factor_by_symbol(first_trade_date_by_symbol)
        sparse_factors = build_sparse_adjust_factor_rows(factors, latest_factor_by_symbol)

        def operation(conn: sqlite3.Connection) -> bool:
            cur = conn.cursor()
            try:
                if sparse_factors:
                    cur.executemany(
                        """
                        INSERT OR REPLACE INTO adjust_factor (
                            vt_symbol, trade_date, adj_factor
                        )
                        VALUES (
                            :vt_symbol, :trade_date, :adj_factor
                        )
                        """,
                        sparse_factors,
                    )
                cur.executemany(
                    """
                    INSERT INTO adjust_factor_meta (
                        vt_symbol, latest_trade_date, last_sync_at
                    )
                    VALUES (
                        :vt_symbol, :latest_trade_date, :last_sync_at
                    )
                    ON CONFLICT(vt_symbol) DO UPDATE SET
                        latest_trade_date = CASE
                            WHEN excluded.latest_trade_date > adjust_factor_meta.latest_trade_date
                            THEN excluded.latest_trade_date
                            ELSE adjust_factor_meta.latest_trade_date
                        END,
                        last_sync_at = excluded.last_sync_at
                    """,
                    meta_rows,
                )
                return True
            finally:
                cur.close()

        return await self.storage.write_main(operation)

    async def load_adjust_factor_meta(self, vt_symbol: str) -> SQLiteRecord | None:
        """加载复权因子元信息。"""

        def operation(conn: sqlite3.Connection) -> SQLiteRecord | None:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, latest_trade_date, last_sync_at
                    FROM adjust_factor_meta
                    WHERE vt_symbol = ?
                    """,
                    (vt_symbol,),
                )
                return fetchone_record(cur)
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def load_bar_data(self, query: BarDataQuery) -> list[dict]:
        """按条件加载单个标的 K 线数据。"""
        overview = await self._load_bar_overview_row(query.vt_symbol, query.interval)
        if overview is None:
            return []

        query_start = datetime_to_timestr(query.start)
        query_end = datetime_to_timestr(query.end)
        overview_start = overview["start"]
        overview_end = overview["end"]
        if query_end < overview_start or query_start > overview_end:
            return []

        actual_start = max(query_start, overview_start)
        actual_end = min(query_end, overview_end)
        file_names = self.storage.iter_partition_names(
            query.interval,
            datetime.fromisoformat(actual_start),
            datetime.fromisoformat(actual_end),
        )

        partition_rows = await self._gather_limited(
            self._load_bars_from_partition(
                file_name=file_name,
                query=query,
                actual_start=actual_start,
                actual_end=actual_end,
            )
            for file_name in file_names
            if self.storage.data_dir.joinpath(file_name).exists()
        )

        bars: list[SQLiteRecord] = []
        for rows in partition_rows:
            bars.extend(rows)

        if query.adjust == "non":
            return apply_adjustment(bars, [], "non")
        if not bars:
            return []

        factor_rows = await self._load_factor_rows(
            query.vt_symbol,
            extract_trade_date(bars[0]["datetime"]),
            extract_trade_date(bars[-1]["datetime"]),
        )
        return apply_adjustment(bars, factor_rows, query.adjust)

    async def load_bars_data(self, queries: list[BarDataQuery]) -> list[dict]:
        """批量加载多个查询条件的 K 线数据。"""
        results = await self._gather_limited(self.load_bar_data(query) for query in queries)
        merged: list[dict] = []
        for rows in results:
            merged.extend(rows)
        return merged

    async def get_bar_overview(self) -> list[SQLiteRecord]:
        """获取全局 K 线概览。"""

        def operation(conn: sqlite3.Connection) -> list[SQLiteRecord]:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, interval, start, end, count, updated_at
                    FROM bar_overview
                    ORDER BY vt_symbol, interval
                    """
                )
                return fetchall_records(cur)
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def rebuild_bar_overview(self) -> None:
        """从所有分片文件重建 K 线概览。"""
        aggregated_rows: dict[tuple[str, str], SQLiteRecord] = {}

        partition_files = self.storage.list_partition_files()
        partition_results = await self._gather_limited(
            self._scan_partition_overview(file_path.name) for file_path in partition_files
        )
        for file_path, rows in zip(partition_files, partition_results):
            interval = self._extract_interval_from_partition_name(file_path.name)
            for row in rows:
                vt_symbol = row["vt_symbol"]
                key = (vt_symbol, interval)
                row_start = row["start"]
                row_end = row["end"]
                row_count = row["count"]

                existing = aggregated_rows.get(key)
                if existing is None:
                    aggregated_rows[key] = {
                        "vt_symbol": key[0],
                        "interval": key[1],
                        "start": row_start,
                        "end": row_end,
                        "count": row_count,
                        "updated_at": datetime_to_timestr(datetime.now()),
                    }
                    continue

                existing["start"] = min(existing["start"], row_start)
                existing["end"] = max(existing["end"], row_end)
                existing["count"] = existing["count"] + row_count
                existing["updated_at"] = datetime_to_timestr(datetime.now())

        def operation(conn: sqlite3.Connection) -> None:
            cur = conn.cursor()
            try:
                cur.execute("DELETE FROM bar_overview")
                if aggregated_rows:
                    cur.executemany(
                        """
                        INSERT INTO bar_overview (
                            vt_symbol, interval, start, end, count, updated_at
                        )
                        VALUES (
                            :vt_symbol, :interval, :start, :end, :count, :updated_at
                        )
                        """,
                        list(aggregated_rows.values()),
                    )
            finally:
                cur.close()

        await self.storage.write_main(operation)

    async def _load_latest_factor_by_symbol(
        self,
        first_trade_date_by_symbol: dict[str, str],
    ) -> dict[str, float]:
        """加载每个证券在写入起点之前或当日的最近复权因子。"""
        if not first_trade_date_by_symbol:
            return {}

        values_sql = ", ".join("(?, ?)" for _ in first_trade_date_by_symbol)
        params: list[str] = []
        for vt_symbol, trade_date in first_trade_date_by_symbol.items():
            params.extend([vt_symbol, trade_date])

        def operation(conn: sqlite3.Connection) -> list[tuple[str, float]]:
            cur = conn.cursor()
            try:
                cur.execute(
                    f"""
                    WITH targets(vt_symbol, first_trade_date) AS (
                        VALUES {values_sql}
                    ),
                    latest AS (
                        SELECT
                            a.vt_symbol,
                            MAX(a.trade_date) AS trade_date
                        FROM adjust_factor AS a
                        INNER JOIN targets AS t
                            ON t.vt_symbol = a.vt_symbol
                        WHERE a.trade_date <= t.first_trade_date
                        GROUP BY a.vt_symbol
                    )
                    SELECT a.vt_symbol, a.adj_factor
                    FROM adjust_factor AS a
                    INNER JOIN latest
                        ON latest.vt_symbol = a.vt_symbol
                       AND latest.trade_date = a.trade_date
                    """,
                    params,
                )
                return cur.fetchall()
            finally:
                cur.close()

        rows = await self.storage.read_main(operation)
        return {vt_symbol: float(adj_factor) for vt_symbol, adj_factor in rows}

    async def _load_factor_rows(
        self,
        vt_symbol: str,
        start_date: str,
        end_date: str,
    ) -> list[SQLiteRecord]:
        """按交易日区间加载复权因子。"""
        if not start_date or not end_date:
            return []

        def operation(conn: sqlite3.Connection) -> tuple[SQLiteRecord | None, list[SQLiteRecord]]:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT trade_date, adj_factor
                    FROM adjust_factor
                    WHERE vt_symbol = ? AND trade_date < ?
                    ORDER BY trade_date DESC
                    LIMIT 1
                    """,
                    (vt_symbol, start_date),
                )
                previous_row = fetchone_record(cur)
                cur.execute(
                    """
                    SELECT trade_date, adj_factor
                    FROM adjust_factor
                    WHERE vt_symbol = ? AND trade_date BETWEEN ? AND ?
                    ORDER BY trade_date
                    """,
                    (vt_symbol, start_date, end_date),
                )
                return previous_row, fetchall_records(cur)
            finally:
                cur.close()

        previous_row, rows = await self.storage.read_main(operation)
        if previous_row is not None:
            return [previous_row, *rows]
        return rows

    def _group_bars_by_partition(
        self,
        bars: list[BarDataPayload],
    ) -> dict[str, list[BarDataPayload]]:
        """按分片文件对 K 线数据分组。"""
        partitioned_bars: dict[str, list[BarDataPayload]] = defaultdict(list)
        for bar in bars:
            interval = str(bar["interval"])
            datetime_text = str(bar["datetime"])
            if interval == "tick":
                file_name = self.storage.get_partition_name(
                    interval,
                    datetime.fromisoformat(datetime_text),
                )
            elif interval in {"d", "w"}:
                file_name = f"{interval}_{datetime_text[:4]}.db"
            else:
                file_name = f"{interval}_{datetime_text[:4]}_{datetime_text[5:7]}.db"
            partitioned_bars[file_name].append(bar)
        return dict(partitioned_bars)

    async def _load_bar_overview_row(
        self,
        vt_symbol: str,
        interval: str,
    ) -> SQLiteRecord | None:
        """加载单个标的的全局概览。"""

        def operation(conn: sqlite3.Connection) -> SQLiteRecord | None:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, interval, start, end, count, updated_at
                    FROM bar_overview
                    WHERE vt_symbol = ? AND interval = ?
                    """,
                    (vt_symbol, interval),
                )
                return fetchone_record(cur)
            finally:
                cur.close()

        return await self.storage.read_main(operation)

    async def _update_bar_overview(
        self,
        touched_symbols_by_interval: dict[str, set[str]],
    ) -> None:
        """刷新本次写入涉及标的的全局概览。"""
        if not touched_symbols_by_interval:
            return

        async with self._overview_update_lock:
            overview_groups = await self._gather_limited(
                self._calculate_full_bar_overviews(interval, vt_symbols)
                for interval, vt_symbols in touched_symbols_by_interval.items()
            )
            overview_rows = [overview for rows in overview_groups for overview in rows]

            if not overview_rows:
                return

            def operation(conn: sqlite3.Connection) -> None:
                cur = conn.cursor()
                try:
                    cur.executemany(
                        """
                        INSERT OR REPLACE INTO bar_overview (
                            vt_symbol, interval, start, end, count, updated_at
                        )
                        VALUES (
                            :vt_symbol, :interval, :start, :end, :count, :updated_at
                        )
                        """,
                        overview_rows,
                    )
                finally:
                    cur.close()

            await self.storage.write_main(operation)

    async def _calculate_full_bar_overviews(
        self,
        interval: str,
        vt_symbols: set[str],
    ) -> list[SQLiteRecord]:
        """扫描全部相关分片并重建一组标的周期概览。

        并发写不同分片时，局部区间合并容易被后写入任务覆盖，因此这里仍以
        “全分片最终视图”为准；但同一周期内多个标的会合并查询，避免重复扫描。
        """
        normalized_symbols = tuple(sorted(vt_symbols))
        if not normalized_symbols:
            return []

        file_names = self._list_partition_names_by_interval(interval)
        partition_rows = await self._gather_limited(
            self._load_overviews_from_partition(file_name, normalized_symbols)
            for file_name in file_names
        )
        updated_at = datetime_to_timestr(datetime.now())
        aggregated_rows: dict[str, SQLiteRecord] = {}

        for rows in partition_rows:
            for row in rows:
                vt_symbol = row["vt_symbol"]
                row_start = row["start"]
                row_end = row["end"]
                row_count = row["count"]
                existing = aggregated_rows.get(vt_symbol)
                if existing is None:
                    aggregated_rows[vt_symbol] = {
                        "vt_symbol": vt_symbol,
                        "interval": interval,
                        "start": row_start,
                        "end": row_end,
                        "count": row_count,
                        "updated_at": updated_at,
                    }
                    continue

                existing["start"] = min(existing["start"], row_start)
                existing["end"] = max(existing["end"], row_end)
                existing["count"] = existing["count"] + row_count

        return list(aggregated_rows.values())

    async def _load_bars_from_partition(
        self,
        *,
        file_name: str,
        query: BarDataQuery,
        actual_start: str,
        actual_end: str,
    ) -> list[SQLiteRecord]:
        """加载单个分片文件中的行情行。"""

        def operation(conn: sqlite3.Connection) -> list[SQLiteRecord]:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT vt_symbol, datetime, volume, open, high, low, close,
                           turnover, open_interest,
                           upper_limit, lower_limit
                    FROM bardata
                    WHERE vt_symbol = ?
                      AND datetime BETWEEN ? AND ?
                    ORDER BY datetime
                    """,
                    (
                        query.vt_symbol,
                        actual_start,
                        actual_end,
                    ),
                )
                return fetchall_records(cur, {"interval": query.interval})
            finally:
                cur.close()

        return await self.storage.read_partition(file_name, operation)

    def _list_partition_names_by_interval(self, interval: str) -> list[str]:
        """按周期列出需要扫描的分片文件名。"""
        if interval == "tick":
            return [
                file_path.name
                for file_path in self.storage.list_partition_files()
                if file_path.name.startswith("tick_")
            ]
        return [
            file_path.name
            for file_path in self.storage.list_partition_files()
            if file_path.name.startswith(f"{interval}_")
        ]

    async def _load_overviews_from_partition(
        self,
        file_name: str,
        vt_symbols: Sequence[str],
    ) -> list[SQLiteRecord]:
        """从单个分片文件加载一组标的的概览聚合行。"""
        if not vt_symbols:
            return []

        def operation(conn: sqlite3.Connection) -> list[SQLiteRecord]:
            cur = conn.cursor()
            try:
                rows: list[SQLiteRecord] = []
                for start_index in range(0, len(vt_symbols), self._SQLITE_IN_CHUNK_SIZE):
                    chunk = vt_symbols[start_index : start_index + self._SQLITE_IN_CHUNK_SIZE]
                    placeholders = ", ".join("?" for _ in chunk)
                    cur.execute(
                        f"""
                        SELECT
                            vt_symbol,
                            MIN(datetime) AS start,
                            MAX(datetime) AS end,
                            COUNT(*) AS count
                        FROM bardata
                        WHERE vt_symbol IN ({placeholders})
                        GROUP BY vt_symbol
                        """,
                        chunk,
                    )
                    rows.extend(fetchall_records(cur))
                return rows
            finally:
                cur.close()

        return await self.storage.read_partition(file_name, operation)

    async def _scan_partition_overview(self, file_name: str) -> list[SQLiteRecord]:
        """扫描单个分片文件中的全部概览聚合行。"""

        def operation(conn: sqlite3.Connection) -> list[SQLiteRecord]:
            cur = conn.cursor()
            try:
                cur.execute(
                    """
                    SELECT
                        vt_symbol,
                        MIN(datetime) AS start,
                        MAX(datetime) AS end,
                        COUNT(*) AS count
                    FROM bardata
                    GROUP BY vt_symbol
                    """
                )
                return fetchall_records(cur)
            finally:
                cur.close()

        return await self.storage.read_partition(file_name, operation)

    def _extract_interval_from_partition_name(self, file_name: str) -> str:
        """从分片数据库文件名还原 K 线周期。

        Args:
            file_name: 分片数据库文件名。当前约定中 ``tick`` 为日分片，
                日线和周线为年分片，分钟等其他频度为月分片。

        Returns:
            文件名对应的 K 线周期。
        """

        if file_name.startswith("tick_"):
            return "tick"
        return file_name.split("_", maxsplit=1)[0]
