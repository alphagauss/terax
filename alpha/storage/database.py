"""Alpha SQLite 数据库门面及领域仓储聚合。"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

from alpha.common.schema_market import (
    AdjustFactorPayload,
    BarDataPayload,
    BarDataQuery,
    IndexConstituentQuery,
    SecurityDailyInfoQuery,
    SecurityDailyInfoRecord,
    SecurityProfilePayload,
    SecurityProfileQuery,
    SecurityStatusEventPayload,
    SecurityStatusMetaPayload,
    ShareCapitalPayload,
)
from alpha.storage.base import SQLiteStorageBase
from alpha.storage.repositories.equity import EquityRepository
from alpha.storage.repositories.index_constituent import IndexConstituentRepository
from alpha.storage.repositories.market_data import MarketDataRepository
from alpha.storage.repositories.security import SecurityRepository
from alpha.storage.transforms import normalize_trade_date
from alpha.utils import log_execution_time
class DataBase:
    """SQLite 数据库对外门面。"""

    def __init__(self, data_dir: Path) -> None:
        """使用调用方明确提供的目录初始化数据库。"""

        self._storage = SQLiteStorageBase(data_dir)
        self._equity = EquityRepository(self._storage)
        self._security = SecurityRepository(self._storage)
        self._index_constituent = IndexConstituentRepository(self._storage)
        self._market_data = MarketDataRepository(self._storage)

    @property
    def data_dir(self) -> Path:
        """返回数据库目录。"""
        return self._storage.data_dir

    async def close(self) -> None:
        """关闭底层存储对象。"""
        self._storage.close()

    @property
    def bulk_import_mode(self) -> bool:
        """返回当前批量导入模式。"""
        return self._storage.bulk_import_mode

    def set_bulk_import_mode(self, enabled: bool) -> None:
        """切换批量导入模式。"""
        self._storage.set_bulk_import_mode(enabled)

    @log_execution_time()
    async def save_bar_data(
        self,
        bars: list[BarDataPayload],
        *,
        adjust: str,
        update_overview: bool = True,
    ) -> bool:
        """保存原始 K 线数据。"""
        return await self._market_data.save_bar_data(
            bars,
            adjust=adjust,
            update_overview=update_overview,
        )

    @log_execution_time()
    async def load_bar_data(self, query: BarDataQuery) -> list[dict]:
        """按条件加载单个标的 K 线数据。"""
        return await self._market_data.load_bar_data(query)

    @log_execution_time()
    async def load_bars_data(self, queries: list[BarDataQuery]) -> list[dict]:
        """批量加载多个查询条件的 K 线数据。"""
        return await self._market_data.load_bars_data(queries)

    @log_execution_time()
    async def get_bar_overview(self) -> list[dict[str, object]]:
        """获取全局 K 线概览。"""
        return await self._market_data.get_bar_overview()

    @log_execution_time()
    async def rebuild_bar_overview(self) -> None:
        """重建全局 K 线概览。"""
        await self._market_data.rebuild_bar_overview()

    @log_execution_time()
    async def save_adjust_factors(self, factors: list[AdjustFactorPayload]) -> bool:
        """保存累计复权因子。"""
        return await self._market_data.save_adjust_factors(factors)

    @log_execution_time()
    async def load_adjust_factor_meta(self, vt_symbol: str) -> dict[str, object] | None:
        """加载复权因子元信息。"""
        return await self._market_data.load_adjust_factor_meta(vt_symbol)

    @log_execution_time()
    async def save_share_capital_data(self, rows: list[ShareCapitalPayload]) -> bool:
        """保存股本变化数据。"""
        return await self._equity.save_share_capital_data(rows)

    @log_execution_time()
    async def load_share_capital_changes(
        self,
        vt_symbol: str,
        start: str | date | datetime,
        end: str | date | datetime,
    ) -> list[dict[str, object]]:
        """加载股本变化记录。"""
        return await self._equity.load_share_capital_changes(vt_symbol, start, end)

    @log_execution_time()
    async def load_share_capital_meta(self, vt_symbol: str) -> dict[str, object] | None:
        """加载股本同步元信息。"""
        return await self._equity.load_share_capital_meta(vt_symbol)

    @log_execution_time()
    async def clear_share_capital_data(self) -> None:
        """清空股本变化表。"""
        await self._equity.clear_share_capital_data()

    @log_execution_time()
    async def save_security_profiles(self, rows: list[SecurityProfilePayload]) -> bool:
        """保存证券静态资料。"""
        return await self._security.save_security_profiles(rows)

    @log_execution_time()
    async def load_security_profiles(self, query: SecurityProfileQuery) -> list[dict[str, object]]:
        """按统一查询条件加载证券静态资料。"""
        return await self._security.load_security_profiles(query)

    @log_execution_time()
    async def load_security_daily_info(
        self,
        query: SecurityDailyInfoQuery,
    ) -> list[SecurityDailyInfoRecord]:
        """按证券和交易日加载逐日状态信息。"""
        trade_dates = self._load_trade_dates_between(query.start, query.end)
        return await self._security.load_security_daily_info(query, trade_dates)

    @log_execution_time()
    async def save_security_status_meta(
        self,
        vt_symbol: str,
        latest_checked_trade_date: str | date | datetime,
        latest_data_trade_date: str | date | datetime | None = None,
        is_terminal: bool = False,
    ) -> None:
        """保存证券状态同步游标。"""
        await self._security.save_security_status_meta(
            vt_symbol,
            latest_checked_trade_date,
            latest_data_trade_date=latest_data_trade_date,
            is_terminal=is_terminal,
        )

    @log_execution_time()
    async def load_security_status_meta(self, vt_symbol: str) -> dict[str, object] | None:
        """加载证券状态同步游标。"""
        return await self._security.load_security_status_meta(vt_symbol)

    @log_execution_time()
    async def load_security_status_metas(self) -> dict[str, dict[str, object]]:
        """加载全部证券状态同步游标。"""
        return await self._security.load_security_status_metas()

    @log_execution_time()
    async def save_suspended_day_events(self, rows: list[SecurityStatusEventPayload]) -> bool:
        """批量保存停牌交易日事件。"""
        return await self._security.save_suspended_day_events(rows)

    @log_execution_time()
    async def save_st_day_events(self, rows: list[SecurityStatusEventPayload]) -> bool:
        """批量保存 ST 交易日事件。"""
        return await self._security.save_st_day_events(rows)

    @log_execution_time()
    async def save_security_status_metas(self, rows: list[SecurityStatusMetaPayload]) -> bool:
        """批量保存证券状态同步游标。"""
        return await self._security.save_security_status_metas(rows)

    @log_execution_time()
    async def save_index_constituents(
        self,
        index_code: str,
        trade_date: str | date | datetime,
        vt_symbols: list[str],
    ) -> bool:
        """保存指数成分股快照。"""
        return await self._index_constituent.save_index_constituents(
            index_code,
            trade_date,
            vt_symbols,
        )

    @log_execution_time()
    async def load_index_constituents(
        self,
        query: IndexConstituentQuery,
    ) -> list[str]:
        """加载指数成分股列表。"""
        return await self._index_constituent.load_index_constituents(query.index_code, query.trade_date)

    @log_execution_time()
    async def load_index_constituent_meta(self, index_code: str) -> dict[str, object] | None:
        """加载指数成分股同步边界。"""
        return await self._index_constituent.load_index_constituent_meta(index_code)

    def _load_trade_dates_between(
        self,
        start: str | date | datetime,
        end: str | date | datetime,
    ) -> list[str]:
        """从 CSV 交易日历中截取闭区间交易日列表。

        Args:
            start: 查询开始交易日。
            end: 查询结束交易日。

        Returns:
            落在 ``[start, end]`` 闭区间内的升序交易日字符串列表。

        Raises:
            ValueError: 当 ``trade_date.csv`` 缺少 ``trade_date`` 列时抛出。
        """
        from alpha.storage import csvdb

        start_date = normalize_trade_date(start)
        end_date = normalize_trade_date(end)
        trade_date_df = csvdb.get_trade_date()
        if "trade_date" not in trade_date_df.columns:
            raise ValueError("trade_date.csv 缺少 trade_date 列")

        scoped_trade_dates: set[str] = set()

        # 逐项标准化交易日历，只保留查询区间内的有效交易日。
        for raw_trade_date in trade_date_df["trade_date"].tolist():
            if raw_trade_date is None:
                continue

            text = str(raw_trade_date).strip()
            if text == "" or text.lower() in {"nan", "nat"}:
                continue

            normalized_trade_date = normalize_trade_date(text)
            if start_date <= normalized_trade_date <= end_date:
                scoped_trade_dates.add(normalized_trade_date)

        return sorted(scoped_trade_dates)
