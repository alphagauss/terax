from __future__ import annotations

from functools import lru_cache
from datetime import date
from typing import TYPE_CHECKING

import pandas as pd

from alpha.storage import csvdb
from alpha.sync_tasks.base import BaseSyncProvider
from alpha.sync_tasks.constants import SECURITY_GROUP_CONFIGS
from alpha.sync_tasks.universe import map_gm_exchange_to_db_exchange

if TYPE_CHECKING:
    import alpha.market.eastmoney_gm as gm_module


SECURITY_STATE_COLUMNS = [
    "gm_symbol",
    "vt_symbol",
    "asset_type",
    "trade_date",
    "board",
    "sec_name",
    "sec_abbr",
    "price_tick",
    "trade_n",
    "listed_date",
    "delisted_date",
    "is_suspended",
    "is_st",
    "adj_factor",
    "upper_limit",
    "lower_limit",
]

SEC_TYPE1_ASSET_TYPE_MAP = {
    1010: "stock",
    1020: "etf",
    1060: "index",
}


@lru_cache(maxsize=1)
def _get_gm() -> gm_module:
    """按需导入 GM 模块，避免测试导入脚本时触发环境校验。"""
    import alpha.market.eastmoney_gm as gm

    return gm


class GmAsyncProvider(BaseSyncProvider):
    """GM 异步数据源适配器。"""

    def _get_security_config(self, asset_type: str) -> dict[str, int | str]:
        """根据资产类型获取 GM 证券分组配置。

        Args:
            asset_type: 项目内部资产类型，例如 ``stock``、``etf``、``index``。

        Returns:
            对应 ``SECURITY_GROUP_CONFIGS`` 中的配置字典。

        Raises:
            ValueError: 当资产类型未配置时抛出。
        """
        try:
            return next(item for item in SECURITY_GROUP_CONFIGS if item["asset_type"] == asset_type)
        except StopIteration as exc:
            raise ValueError(f"不支持的资产类型: {asset_type}") from exc

    def _normalize_history_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        """将 GM ``history`` 原始结果适配为项目内部统一日线结构。

        该方法只处理与 GM ``Bar`` 结构强相关、且不存在业务歧义的字段映射：

        - ``symbol`` 拆分并补充 ``vt_symbol``、``exchange``
        - ``amount`` 重命名为 ``turnover``，若缺失则退回 ``turnover`` 原列
        - ``eob`` 映射为数据库使用的 ``datetime`` 字符串
        - 固定补齐 ``interval="d"``、``adjust="non"``、``open_interest=0.0``

        Args:
            df: GM ``history`` 返回的原始 ``DataFrame``。预期至少包含
                ``symbol``、``open``、``high``、``low``、``close``、
                ``volume``，以及 ``eob`` 或 ``bob`` 中的任一时间列。

        Returns:
            可直接供日线写库链路消费的标准字段 ``DataFrame``。字段顺序固定为：
            ``vt_symbol``、``symbol``、``exchange``、``datetime``、
            ``interval``、``adjust``、``volume``、``open``、``high``、
            ``low``、``close``、``turnover``、``open_interest``。

        Raises:
            ValueError: 当 ``symbol`` 格式非法，或缺少 ``eob``/``bob`` 时间列时抛出。
        """
        if df.empty:
            return pd.DataFrame(
                columns=[
                    "vt_symbol",
                    "symbol",
                    "exchange",
                    "datetime",
                    "interval",
                    "adjust",
                    "volume",
                    "open",
                    "high",
                    "low",
                    "close",
                    "turnover",
                    "open_interest",
                ]
            )

        working = df.copy()
        symbol_parts = working["symbol"].astype(str).str.split(".", n=1, expand=True)
        if symbol_parts.shape[1] != 2:
            raise ValueError("GM history 返回的 symbol 字段格式不正确")

        datetime_source_column = "eob" if "eob" in working.columns else "bob" if "bob" in working.columns else None
        if datetime_source_column is None:
            raise ValueError("GM history 返回结果缺少 eob/bob 时间字段")

        datetime_series = pd.to_datetime(working[datetime_source_column], errors="coerce")
        if getattr(datetime_series.dt, "tz", None) is not None:
            datetime_series = datetime_series.dt.tz_localize(None)

        gm_exchanges = symbol_parts[0].astype(str)
        sec_ids = symbol_parts[1].astype(str)
        db_exchanges = gm_exchanges.map(map_gm_exchange_to_db_exchange)
        turnover_source = (
            working["amount"]
            if "amount" in working.columns
            else working["turnover"]
            if "turnover" in working.columns
            else pd.Series(0.0, index=working.index)
        )

        normalized = pd.DataFrame(
            {
                "vt_symbol": sec_ids + "." + db_exchanges,
                "symbol": sec_ids,
                "exchange": db_exchanges,
                "datetime": datetime_series.dt.normalize().dt.strftime("%Y-%m-%d %H:%M:%S"),
                "interval": "d",
                "adjust": "non",
                "volume": pd.to_numeric(working["volume"], errors="coerce").astype(float),
                "open": pd.to_numeric(working["open"], errors="coerce").astype(float),
                "high": pd.to_numeric(working["high"], errors="coerce").astype(float),
                "low": pd.to_numeric(working["low"], errors="coerce").astype(float),
                "close": pd.to_numeric(working["close"], errors="coerce").astype(float),
                "turnover": pd.to_numeric(turnover_source, errors="coerce").fillna(0.0).astype(float),
                "open_interest": 0.0,
            }
        )
        return normalized.sort_values(["vt_symbol", "datetime"], kind="stable").reset_index(drop=True)

    def _build_empty_security_state_dataframe(self) -> pd.DataFrame:
        """构造统一证券状态空表。"""
        return pd.DataFrame(columns=SECURITY_STATE_COLUMNS)

    def _normalize_optional_date_text(self, series: pd.Series) -> pd.Series:
        """将日期列标准化为 ``YYYY-MM-DD`` 字符串。

        GM 未退市证券常返回 ``2038-01-01`` 这类哨兵值，这里统一转为 ``None``。
        """
        parsed = pd.to_datetime(series, errors="coerce")
        normalized = parsed.dt.strftime("%Y-%m-%d").astype(object)
        year_series = parsed.dt.year
        return normalized.where(parsed.notna() & ((year_series < 2038) | year_series.isna()), None)

    def _get_optional_series(self, df: pd.DataFrame, column: str) -> pd.Series:
        """返回可选列，缺失时按当前索引补空列。"""
        if column not in df.columns:
            return pd.Series([None] * len(df), index=df.index, dtype=object)
        return df[column]

    def _normalize_security_state_dataframe(
        self,
        df: pd.DataFrame,
        *,
        asset_type: str | None = None,
        trade_date: date | None = None,
    ) -> pd.DataFrame:
        """将 GM 证券相关接口结果统一标准化为项目内部证券状态结构。

        Args:
            df: GM ``get_history_symbol`` / ``get_symbols`` / ``get_symbol_infos``
                返回的原始 ``DataFrame``。
            asset_type: 项目内部资产类型。
            trade_date: 若传入，则优先使用该交易日填充 ``trade_date``，适用于
                ``get_symbols`` 这类单日快照接口。

        Returns:
            标准化后的证券状态 ``DataFrame``。``gm_symbol`` 原样保留；对于无法
            映射到数据库代码的证券，``vt_symbol`` 置为 ``None``，不在 provider
            层静默丢弃。
        """
        if df.empty:
            return self._build_empty_security_state_dataframe()

        working = df.copy()
        if "symbol" not in working.columns:
            raise ValueError("GM 证券状态结果缺少 symbol 列")
        if asset_type is None:
            if "sec_type1" not in working.columns or working["sec_type1"].dropna().empty:
                raise ValueError("GM 证券状态结果缺少 sec_type1，无法推断 asset_type")
            sec_type1 = int(working["sec_type1"].dropna().iloc[0])
            try:
                asset_type = SEC_TYPE1_ASSET_TYPE_MAP[sec_type1]
            except KeyError as exc:
                raise ValueError(f"不支持的 sec_type1: {sec_type1}") from exc

        gm_symbols = working["symbol"].astype(str).str.strip() if "symbol" in working.columns else pd.Series([], dtype=str)
        vt_symbols: list[str | None] = []
        for gm_symbol in gm_symbols.tolist():
            if not gm_symbol or "." not in gm_symbol:
                vt_symbols.append(None)
                continue
            try:
                gm_exchange, sec_id = gm_symbol.split(".", 1)
                vt_symbols.append(f"{sec_id}.{map_gm_exchange_to_db_exchange(gm_exchange)}")
            except ValueError:
                vt_symbols.append(None)

        if trade_date is not None:
            trade_date_series = pd.Series([trade_date.isoformat()] * len(working), index=working.index, dtype=object)
        elif "trade_date" in working.columns:
            parsed_trade_dates = pd.to_datetime(working["trade_date"], errors="coerce")
            trade_date_series = parsed_trade_dates.dt.strftime("%Y-%m-%d").astype(object)
            trade_date_series = trade_date_series.where(parsed_trade_dates.notna(), None)
        else:
            trade_date_series = pd.Series([None] * len(working), index=working.index, dtype=object)

        normalized = pd.DataFrame(
            {
                "gm_symbol": gm_symbols,
                "vt_symbol": pd.Series(vt_symbols, index=working.index, dtype=object),
                "asset_type": str(asset_type),
                "trade_date": trade_date_series,
                "board": self._get_optional_series(working, "board"),
                "sec_name": self._get_optional_series(working, "sec_name"),
                "sec_abbr": self._get_optional_series(working, "sec_abbr"),
                "price_tick": self._get_optional_series(working, "price_tick"),
                "trade_n": self._get_optional_series(working, "trade_n"),
                "listed_date": self._normalize_optional_date_text(
                    working["listed_date"]
                    if "listed_date" in working.columns
                    else pd.Series([None] * len(working), index=working.index, dtype=object)
                ),
                "delisted_date": self._normalize_optional_date_text(
                    working["delisted_date"]
                    if "delisted_date" in working.columns
                    else pd.Series([None] * len(working), index=working.index, dtype=object)
                ),
                "is_suspended": self._get_optional_series(working, "is_suspended"),
                "is_st": self._get_optional_series(working, "is_st"),
                "adj_factor": self._get_optional_series(working, "adj_factor"),
                "upper_limit": self._get_optional_series(working, "upper_limit"),
                "lower_limit": self._get_optional_series(working, "lower_limit"),
            }
        )
        return normalized.loc[:, SECURITY_STATE_COLUMNS].reset_index(drop=True)

    async def fetch_history(self, symbols: list[str], start_date: date, end_date: date, fields: str) -> pd.DataFrame:
        """获取 GM 历史行情，并直接返回项目内部标准日线字段。

        Args:
            symbols: GM 证券代码列表，格式如 ``SHSE.600000``。
            start_date: 请求起始日期，闭区间。
            end_date: 请求结束日期，闭区间。
            fields: 透传给 GM ``history`` 的字段字符串。

        Returns:
            已完成字段适配的标准 ``DataFrame``，可直接供同步任务写库。
        """
        gm = _get_gm()
        result = await gm.history(
            symbol=",".join(symbols),
            frequency="1d",
            start_time=start_date.strftime("%Y-%m-%d"),
            end_time=end_date.strftime("%Y-%m-%d"),
            fields=fields,
            skip_suspended=False,
            adjust=gm.ADJUST_NONE,
            df=True,
        )
        raw_df = result if isinstance(result, pd.DataFrame) else pd.DataFrame(result)
        return self._normalize_history_dataframe(raw_df)

    async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
        """获取单证券历史扩展信息。

        Args:
            symbol: GM 证券代码。
            start_date: 请求起始日期，闭区间。
            end_date: 请求结束日期，闭区间。

        Returns:
            标准化后的证券状态 ``DataFrame``。返回字段与
            :meth:`fetch_symbols_snapshot` 保持一致，便于任务层复用。
        """
        result = await _get_gm().get_history_symbol(
            symbol=symbol,
            start_date=start_date.strftime("%Y-%m-%d"),
            end_date=end_date.strftime("%Y-%m-%d"),
            df=True,
        )
        raw_df = result if isinstance(result, pd.DataFrame) else pd.DataFrame(result)
        return self._normalize_security_state_dataframe(raw_df)

    async def fetch_symbols_snapshot(self, asset_type: str, trade_date: date) -> pd.DataFrame:
        """获取单日多证券快照，并直接完成 provider 内标准化。

        Args:
            asset_type: 项目内部资产类型。
            trade_date: 目标交易日。

        Returns:
            标准化后的证券状态 ``DataFrame``。``trade_date`` 统一使用请求入参。
        """
        config = self._get_security_config(asset_type)
        result = await _get_gm().get_symbols(
            sec_type1=config["sec_type1"],
            sec_type2=config["sec_type2"],
            skip_suspended=False,
            skip_st=False,
            trade_date=trade_date.strftime("%Y-%m-%d"),
            df=True,
        )
        raw_df = result if isinstance(result, pd.DataFrame) else pd.DataFrame(result)
        return self._normalize_security_state_dataframe(raw_df, asset_type=asset_type, trade_date=trade_date)


    async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
        """获取指数成分股原始结果。"""
        result = await _get_gm().stk_get_index_constituents(
            index=index_symbol,
            trade_date=trade_date.strftime("%Y-%m-%d"),
        )
        return result if isinstance(result, pd.DataFrame) else pd.DataFrame(result)


    async def fetch_symbol_infos(self, asset_type: str) -> pd.DataFrame:
        """获取证券静态信息，并返回与证券状态接口同构的标准字段。

        该接口用于低频离线初始化场景，例如刷新 CSV 证券池。状态列
        ``trade_date``、``is_suspended``、``is_st``、``adj_factor`` 在静态
        场景下通常为空。
        """
        config = self._get_security_config(asset_type)
        result = await _get_gm().get_symbol_infos(
            sec_type1=config["sec_type1"],
            sec_type2=config["sec_type2"],
            df=True,
        )
        raw_df = result if isinstance(result, pd.DataFrame) else pd.DataFrame(result)
        return self._normalize_security_state_dataframe(raw_df, asset_type=asset_type)


    async def fetch_trading_dates(self, exchange: str, start_year: int, end_year: int) -> pd.DataFrame | list:
        """获取交易日历原始结果。"""
        return await _get_gm().get_trading_dates_by_year(exchange, start_year, end_year)
    

    async def refresh_trade_dates_csv(self, exchange: str = "SHSE", start_year: int = 2005, end_year: int = 2026) -> None:
        df = await self.fetch_trading_dates(exchange, start_year, end_year)
        csvdb.save_trade_date(pd.DataFrame(df))
