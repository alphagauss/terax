from __future__ import annotations

import asyncio
from datetime import date, datetime
from time import perf_counter
from typing import Callable, Literal

import pandas as pd
from tqdm import tqdm

from alpha.common.schema_market import SecurityStatusMetaPayload
from alpha.storage import csvdb
from alpha.storage.database import DataBase
from alpha.sync_tasks.base import BaseSyncProvider
from alpha.sync_tasks.calendar import align_to_prev_trade_date, get_latest_target_trade_date
from alpha.sync_tasks.constants import SECURITY_GROUP_CONFIGS, SECURITY_SYNC_FACTOR_FLUSH_ROWS
from alpha.sync_tasks.models import SecurityInfo, StageProfiler
from alpha.sync_tasks.planners import build_full_security_sync_plans, build_incremental_trade_dates
from alpha.sync_tasks.reporting import format_stage_timings
from alpha.sync_tasks.universe import load_symbol_universe_from_csv, load_trade_dates_from_csv
from alpha.sync_tasks.writers import flush_security_sync_buffers, load_security_status_meta_map


def _build_limit_bar_row(
    *,
    security: SecurityInfo,
    trade_date: str | None,
    row: dict[str, object],
) -> dict[str, object] | None:
    """从证券状态行构造日线涨跌停补写记录。

    约束说明：

    - 仅股票、ETF 参与补写；
    - ``upper_limit`` / ``lower_limit`` 为 0 时视为“不更新”，交由数据库默认值接管；
    - ``security_sync`` 只负责补写已有日线，不负责补建缺失 K 线。
    """
    if security.asset_type not in {"stock", "etf"} or trade_date is None:
        return None

    upper_limit = row.get("upper_limit")
    lower_limit = row.get("lower_limit")
    normalized: dict[str, float] = {}

    # 将有效非零涨跌停价整理为日线补写载荷，0 按调用方约定直接跳过。
    for field_name, field_value in (("upper_limit", upper_limit), ("lower_limit", lower_limit)):
        if field_value is None or pd.isna(field_value):
            continue
        resolved_value = float(field_value)
        if resolved_value == 0.0:
            continue
        normalized[field_name] = resolved_value

    if not normalized:
        return None

    return {
        "vt_symbol": security.vt_symbol,
        "datetime": f"{trade_date} 00:00:00",
        "interval": "d",
        **normalized,
    }


def _build_profile_row(
    *,
    security: SecurityInfo,
    row: dict[str, object],
) -> dict[str, object]:
    """从统一证券状态行构造证券资料记录。"""
    board = row.get("board")
    sec_name = row.get("sec_name")
    sec_abbr = row.get("sec_abbr")
    price_tick = row.get("price_tick")
    trade_n = row.get("trade_n")
    listed_date = row.get("listed_date")
    delisted_date = row.get("delisted_date")
    return {
        "vt_symbol": security.vt_symbol,
        "asset_type": security.asset_type,
        "board": None if board is None or pd.isna(board) else int(board),
        "sec_name": None if sec_name is None or pd.isna(sec_name) else str(sec_name),
        "sec_abbr": None if sec_abbr is None or pd.isna(sec_abbr) else str(sec_abbr),
        "price_tick": None if price_tick is None or pd.isna(price_tick) else float(price_tick),
        "trade_n": None if trade_n is None or pd.isna(trade_n) else int(trade_n),
        "listed_date": None if listed_date is None or pd.isna(listed_date) else str(listed_date),
        "delisted_date": None if delisted_date is None or pd.isna(delisted_date) else str(delisted_date),
    }


def _build_profile_payload(
    *,
    vt_symbol: str,
    asset_type: str,
    row: dict[str, object],
) -> dict[str, object]:
    """基于标准化行直接构造证券资料写库载荷。"""
    board = row.get("board")
    sec_name = row.get("sec_name")
    sec_abbr = row.get("sec_abbr")
    price_tick = row.get("price_tick")
    trade_n = row.get("trade_n")
    listed_date = row.get("listed_date")
    delisted_date = row.get("delisted_date")
    return {
        "vt_symbol": vt_symbol,
        "asset_type": asset_type,
        "board": None if board is None or pd.isna(board) else int(board),
        "sec_name": None if sec_name is None or pd.isna(sec_name) else str(sec_name),
        "sec_abbr": None if sec_abbr is None or pd.isna(sec_abbr) else str(sec_abbr),
        "price_tick": None if price_tick is None or pd.isna(price_tick) else float(price_tick),
        "trade_n": None if trade_n is None or pd.isna(trade_n) else int(trade_n),
        "listed_date": None if listed_date is None or pd.isna(listed_date) else str(listed_date),
        "delisted_date": None if delisted_date is None or pd.isna(delisted_date) else str(delisted_date),
    }


def _normalize_history_symbol_result(
    security: SecurityInfo,
    df,
) -> dict[str, object]:
    """将 provider 返回的单证券标准表装配为写库缓冲。"""
    if df.empty:
        return {
            "profile": None,
            "suspended_events": [],
            "st_events": [],
            "adjust_factors": [],
            "limit_bar_rows": [],
            "latest_data_trade_date": None,
            "fetched_rows": 0,
        }

    working = df.copy()
    valid_rows = working.loc[working["trade_date"].notna()].copy() if "trade_date" in working.columns else working.iloc[0:0].copy()
    suspended_events: list[dict[str, object]] = []
    st_events: list[dict[str, object]] = []
    adjust_factors: list[dict[str, object]] = []
    limit_bar_rows: list[dict[str, object]] = []
    latest_data_trade_date_text = None if valid_rows.empty else str(valid_rows["trade_date"].max())

    if not valid_rows.empty:
        if security.asset_type in {"stock", "etf"} and "is_suspended" in valid_rows.columns:
            suspended_events = [
                {"vt_symbol": security.vt_symbol, "trade_date": str(item)}
                for item in valid_rows.loc[valid_rows["is_suspended"] == True, "trade_date"].tolist()
            ]
        if security.asset_type == "stock" and "is_st" in valid_rows.columns:
            st_events = [
                {"vt_symbol": security.vt_symbol, "trade_date": str(item)}
                for item in valid_rows.loc[valid_rows["is_st"] == True, "trade_date"].tolist()
            ]
        if security.asset_type in {"stock", "etf"} and "adj_factor" in valid_rows.columns:
            factor_rows = valid_rows.loc[valid_rows["adj_factor"].notna(), ["trade_date", "adj_factor"]].copy()
            adjust_factors = [
                {"vt_symbol": security.vt_symbol, "trade_date": str(row["trade_date"]), "adj_factor": float(row["adj_factor"])}
                for row in factor_rows.to_dict(orient="records")
            ]
        for row in valid_rows.to_dict(orient="records"):
            limit_bar_row = _build_limit_bar_row(
                security=security,
                trade_date=str(row["trade_date"]),
                row=row,
            )
            if limit_bar_row is not None:
                limit_bar_rows.append(limit_bar_row)

    profile_source = working.iloc[-1].to_dict()
    return {
        "profile": _build_profile_row(security=security, row=profile_source),
        "suspended_events": suspended_events,
        "st_events": st_events,
        "adjust_factors": adjust_factors,
        "limit_bar_rows": limit_bar_rows,
        "latest_data_trade_date": latest_data_trade_date_text,
        "fetched_rows": len(working),
    }


def _normalize_symbols_snapshot_result(
    *,
    df,
    security_map: dict[str, SecurityInfo],
    asset_securities: list[SecurityInfo],
    trade_date: date,
    meta_map: dict[str, dict[str, object]],
    skipped_missing_meta_symbols: set[str],
) -> dict[str, object]:
    """将 provider 返回的多证券标准表装配为写库缓冲。"""
    trade_date_text = trade_date.isoformat()
    eligible_symbols = {
        item.vt_symbol
        for item in asset_securities
        if item.listed_date <= trade_date and item.vt_symbol not in skipped_missing_meta_symbols
    }
    pending_symbols = {
        vt_symbol
        for vt_symbol in eligible_symbols
        if not bool(meta_map.get(vt_symbol, {}).get("is_terminal", False))
        and str(meta_map.get(vt_symbol, {}).get("latest_checked_trade_date") or "") < trade_date_text
    }

    if df.empty:
        return {
            "profiles": [],
            "suspended_events": [],
            "st_events": [],
            "adjust_factors": [],
            "limit_bar_rows": [],
            "updated_symbols": set(),
            "checked_empty_symbols": pending_symbols,
            "fetched_rows": 0,
            "skipped_rows": 0,
        }

    working = df.copy()
    if "gm_symbol" not in working.columns:
        raise ValueError("证券快照标准表缺少 gm_symbol 列")

    working["security"] = working["gm_symbol"].map(security_map)
    working["vt_symbol_resolved"] = working["security"].map(lambda item: None if item is None else item.vt_symbol)
    latest_synced_trade_date = working["vt_symbol_resolved"].map(
        lambda vt_symbol: None if vt_symbol is None else meta_map.get(vt_symbol, {}).get("latest_checked_trade_date")
    ).astype("object")
    known_security_mask = working["security"].notna()
    skip_missing_meta_mask = working["vt_symbol_resolved"].isin(skipped_missing_meta_symbols)
    already_synced_mask = latest_synced_trade_date.notna() & (latest_synced_trade_date >= trade_date_text)
    skipped_mask = ~known_security_mask | skip_missing_meta_mask | already_synced_mask
    skipped_rows = int(skipped_mask.sum())
    valid_rows = working.loc[~skipped_mask].copy()

    profiles: list[dict[str, object]] = []
    suspended_events: list[dict[str, object]] = []
    st_events: list[dict[str, object]] = []
    adjust_factors: list[dict[str, object]] = []
    limit_bar_rows: list[dict[str, object]] = []

    for row in valid_rows.to_dict(orient="records"):
        security = row["security"]
        if security is None:
            continue
        profiles.append(_build_profile_row(security=security, row=row))
        if security.asset_type in {"stock", "etf"} and row.get("is_suspended") is True:
            suspended_events.append({"vt_symbol": security.vt_symbol, "trade_date": trade_date_text})
        if security.asset_type == "stock" and row.get("is_st") is True:
            st_events.append({"vt_symbol": security.vt_symbol, "trade_date": trade_date_text})
        if security.asset_type in {"stock", "etf"} and row.get("adj_factor") is not None and not pd.isna(row["adj_factor"]):
            adjust_factors.append(
                {"vt_symbol": security.vt_symbol, "trade_date": trade_date_text, "adj_factor": float(row["adj_factor"])}
            )
        limit_bar_row = _build_limit_bar_row(
            security=security,
            trade_date=trade_date_text,
            row=row,
        )
        if limit_bar_row is not None:
            limit_bar_rows.append(limit_bar_row)

    updated_symbols = {item.vt_symbol for item in valid_rows["security"].tolist() if item is not None}
    return {
        "profiles": profiles,
        "suspended_events": suspended_events,
        "st_events": st_events,
        "adjust_factors": adjust_factors,
        "limit_bar_rows": limit_bar_rows,
        "updated_symbols": updated_symbols,
        "checked_empty_symbols": pending_symbols - updated_symbols,
        "fetched_rows": len(df),
        "skipped_rows": skipped_rows,
    }


def _should_mark_terminal(
    security: SecurityInfo,
    checked_trade_date: date,
    trade_dates: list[date],
) -> bool:
    """判断证券在指定检查日后是否可标记为终态。

    目前仅对已知退市证券生效。当同步游标已经推进到退市交易日时，说明该证券
    后续无需继续做增量探测，可以标记为终态，避免长期拖住全局增量起点。
    """
    if security.delisted_date is None:
        return False
    delisted_trade_date = align_to_prev_trade_date(security.delisted_date, trade_dates)
    if delisted_trade_date is None:
        return False
    return checked_trade_date >= delisted_trade_date


def _build_status_meta_payload(
    *,
    security: SecurityInfo,
    checked_trade_date: date,
    trade_dates: list[date],
    latest_data_trade_date: str | None,
    current_meta: dict[str, object] | None,
) -> SecurityStatusMetaPayload:
    """构造证券状态同步游标写入载荷。

    设计目标：

    - 请求成功后，无论当日是否返回数据，都推进 ``latest_checked_trade_date``；
    - 若本次拿到有效数据，则更新 ``latest_data_trade_date``；
    - 若证券已推进至退市边界，则写入 ``is_terminal=True``，后续 planner 可直接跳过。
    """
    current_data_trade_date = None if current_meta is None else current_meta.get("latest_data_trade_date")
    resolved_latest_data_trade_date = (
        latest_data_trade_date
        if latest_data_trade_date is not None
        else None if current_data_trade_date is None else str(current_data_trade_date)
    )
    return {
        "vt_symbol": security.vt_symbol,
        "latest_checked_trade_date": checked_trade_date.isoformat(),
        "latest_data_trade_date": resolved_latest_data_trade_date,
        "is_terminal": (
            bool(current_meta.get("is_terminal", False)) if current_meta is not None else False
        )
        or _should_mark_terminal(security, checked_trade_date, trade_dates),
    }


def _resolve_asset_type_by_table_name(table_name: str) -> str:
    """根据 CSV 表名映射内部资产类型。"""
    return {
        "gm_a_share_stock_infos": "stock",
        "gm_a_share_etf_infos": "etf",
        "gm_a_share_idx_infos": "index",
    }[table_name]


class SecuritySyncTask:
    """证券基本信息同步任务。"""

    def __init__(
        self,
        provider: BaseSyncProvider,
        *,
        db_factory: Callable[[], DataBase] = DataBase,
        trade_dates_loader: Callable[[], list[date]] = load_trade_dates_from_csv,
        universe_loader: Callable[[], list[SecurityInfo]] = load_symbol_universe_from_csv,
        progress_factory=tqdm,
        max_fetch_concurrency: int = 5,
    ) -> None:
        self.provider = provider
        self.db_factory = db_factory
        self.trade_dates_loader = trade_dates_loader
        self.universe_loader = universe_loader
        self.progress_factory = progress_factory
        self.max_fetch_concurrency = max_fetch_concurrency

    async def run_by_symbol(
        self,
        flush_symbol_count: int = 100,
        target_trade_date: date | None = None,
        plan_mode: Literal["incremental", "full"] = "incremental",
        profile: bool = False,
    ) -> dict[str, object]:
        """执行逐证券证券资料同步。

        Args:
            flush_symbol_count: 累积到指定证券数后触发一次刷库。
            target_trade_date: 指定同步截止交易日；为空时自动推导最近目标交易日。
            plan_mode: 计划构建模式。
                - ``"incremental"``: 默认模式，读取元数据游标后续跑；
                - ``"full"``: 忽略元数据游标，从 ``2005/listed_date`` 起全量建计划。
            profile: 是否记录阶段耗时。

        Returns:
            dict[str, object]: 本次同步统计结果。
        """
        if flush_symbol_count <= 0:
            raise ValueError("flush_symbol_count 必须大于 0")
        if self.max_fetch_concurrency <= 0:
            raise ValueError("max_fetch_concurrency 必须大于 0")

        started_at = datetime.now()
        trade_dates = self.trade_dates_loader()
        latest_trade_date = target_trade_date or get_latest_target_trade_date(trade_dates, started_at)
        securities = self.universe_loader()
        db = self.db_factory()
        try:
            profiler = StageProfiler(enabled=profile)
            summary = await self._run_by_symbol(
                db,
                securities,
                trade_dates,
                latest_trade_date,
                flush_symbol_count,
                plan_mode,
                profiler,
            )

            finished_at = datetime.now()
            result = {
                "mode": "by_symbol",
                "plan_mode": plan_mode,
                "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
                "finished_at": finished_at.strftime("%Y-%m-%d %H:%M:%S"),
                "latest_trade_date": latest_trade_date.strftime("%Y-%m-%d"),
                **summary,
            }
            if profile:
                result["timings"] = profiler.export()
            print(
                f"证券信息同步完成：模式 {result['mode']}，计划模式 {result['plan_mode']}，资料 {result['saved_profile_rows']} 条，"
                f"停牌 {result['saved_suspended_events']} 条，ST {result['saved_st_events']} 条，"
                f"复权因子 {result['saved_adjust_factors']} 条，"
                f"meta {result['saved_status_metas']} 条，失败请求 {result['failed_request_count']} 次"
            )
            if profile:
                print(f"阶段耗时：{format_stage_timings(result['timings'])}")
            return result
        finally:
            await db.close()

    async def run_by_date(
        self,
        target_trade_date: date | None = None,
        profile: bool = False,
    ) -> dict[str, object]:
        """执行增量同步。"""
        if self.max_fetch_concurrency <= 0:
            raise ValueError("max_fetch_concurrency 必须大于 0")

        started_at = datetime.now()
        trade_dates = self.trade_dates_loader()
        latest_trade_date = target_trade_date or get_latest_target_trade_date(trade_dates, started_at)
        securities = self.universe_loader()
        db = self.db_factory()
        try:
            profiler = StageProfiler(enabled=profile)
            summary = await self._run_by_date(db, securities, trade_dates, latest_trade_date, profiler)

            finished_at = datetime.now()
            result = {
                "mode": "by_date",
                "plan_mode": "incremental",
                "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
                "finished_at": finished_at.strftime("%Y-%m-%d %H:%M:%S"),
                "latest_trade_date": latest_trade_date.strftime("%Y-%m-%d"),
                **summary,
            }
            if profile:
                result["timings"] = profiler.export()
            print(
                f"证券信息同步完成：模式 {result['mode']}，计划模式 {result['plan_mode']}，资料 {result['saved_profile_rows']} 条，"
                f"停牌 {result['saved_suspended_events']} 条，ST {result['saved_st_events']} 条，"
                f"复权因子 {result['saved_adjust_factors']} 条，"
                f"meta {result['saved_status_metas']} 条，失败请求 {result['failed_request_count']} 次"
            )
            if profile:
                print(f"阶段耗时：{format_stage_timings(result['timings'])}")
            return result
        finally:
            await db.close()

    async def run_refresh_symbol_infos_csv(self) -> dict[str, object]:
        """刷新证券静态资料 CSV，并同步更新 security_profile。"""
        started_at = datetime.now()
        db = self.db_factory()
        csv_row_count = 0
        saved_profile_rows = 0
        asset_summaries: list[dict[str, object]] = []

        try:
            for item in csvdb.symbol_info_map:
                table_name = str(item["name"])
                asset_type = _resolve_asset_type_by_table_name(table_name)
                df = await self.provider.fetch_symbol_infos(asset_type)
                csvdb.save_csv(df, table_name)
                csv_row_count += len(df)

                profile_rows = [
                    _build_profile_payload(
                        vt_symbol=str(row["vt_symbol"]),
                        asset_type=asset_type,
                        row=row,
                    )
                    for row in (df.to_dict(orient="records") if not df.empty and "vt_symbol" in df.columns else [])
                    if row.get("vt_symbol") is not None
                ]
                if profile_rows:
                    if not await db.save_security_profiles(profile_rows):
                        raise RuntimeError(f"保存 {asset_type} 证券静态资料失败")
                    saved_profile_rows += len(profile_rows)

                asset_summaries.append(
                    {
                        "asset_type": asset_type,
                        "csv_rows": len(df),
                        "saved_profile_rows": len(profile_rows),
                    }
                )
        finally:
            await db.close()

        finished_at = datetime.now()
        return {
            "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
            "finished_at": finished_at.strftime("%Y-%m-%d %H:%M:%S"),
            "csv_rows": csv_row_count,
            "saved_profile_rows": saved_profile_rows,
            "assets": asset_summaries,
        }

    async def run_refresh_symbols_snapshot_csv(self, target_trade_date: date | None = None) -> dict[str, object]:
        """刷新指定交易日的证券快照 CSV。"""
        started_at = datetime.now()
        trade_date = target_trade_date or date.today()
        csv_row_count = 0
        asset_summaries: list[dict[str, object]] = []

        for item in csvdb.symbol_info_map:
            table_name = str(item["name"])
            asset_type = _resolve_asset_type_by_table_name(table_name)
            df = await self.provider.fetch_symbols_snapshot(asset_type, trade_date)
            csvdb.save_csv(df, f"{table_name}_latest")
            csv_row_count += len(df)
            asset_summaries.append(
                {
                    "asset_type": asset_type,
                    "csv_rows": len(df),
                }
            )

        finished_at = datetime.now()
        return {
            "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
            "finished_at": finished_at.strftime("%Y-%m-%d %H:%M:%S"),
            "trade_date": trade_date.isoformat(),
            "csv_rows": csv_row_count,
            "assets": asset_summaries,
        }

    async def _fetch_history_symbol_plan(
        self,
        *,
        plan,
        semaphore: asyncio.Semaphore,
        profiler: StageProfiler | None,
    ) -> tuple[object, dict[str, object] | None, Exception | None]:
        """抓取并标准化单个证券计划。

        Args:
            plan: 单证券同步计划，来自 ``build_full_security_sync_plans``。
            semaphore: 控制 provider 请求并发数的信号量。
            profiler: 阶段耗时统计器。

        Returns:
            tuple[object, dict[str, object] | None, Exception | None]:
                返回原始计划对象、标准化结果与异常对象。即使抓取失败也会带回
                ``plan``，便于调用方保留完整失败上下文与进度展示。
        """
        try:
            async with semaphore:
                fetch_started_at = perf_counter()
                df = await self.provider.fetch_history_symbol(plan.security.gm_symbol, plan.start_date, plan.end_date)
                if profiler is not None:
                    profiler.add("security_full_fetch", fetch_started_at)

            normalize_started_at = perf_counter()
            normalized = _normalize_history_symbol_result(plan.security, df)
            if profiler is not None:
                profiler.add("security_full_normalize", normalize_started_at)
            return plan, normalized, None
        except Exception as exc:
            return plan, None, exc

    async def _run_by_symbol(
        self,
        db: DataBase,
        securities: list[SecurityInfo],
        trade_dates: list[date],
        latest_trade_date: date,
        flush_symbol_count: int,
        plan_mode: Literal["incremental", "full"],
        profiler: StageProfiler | None,
    ) -> dict[str, object]:
        meta_map = await load_security_status_meta_map(db)
        plans = build_full_security_sync_plans(
            securities,
            meta_map,
            trade_dates,
            latest_trade_date,
            plan_mode=plan_mode,
        )

        profile_rows: list[dict[str, object]] = []
        suspended_events: list[dict[str, object]] = []
        st_events: list[dict[str, object]] = []
        adjust_factor_rows: list[dict[str, object]] = []
        limit_bar_rows: list[dict[str, object]] = []
        status_meta_map: dict[str, SecurityStatusMetaPayload] = {}

        total_fetched_rows = 0
        total_profile_rows = 0
        total_suspended_events = 0
        total_st_events = 0
        total_adjust_factors = 0
        total_status_metas = 0
        failed_request_count = 0
        processed_symbol_count = 0
        semaphore = asyncio.Semaphore(self.max_fetch_concurrency)

        with self.progress_factory(total=len(plans), desc="证券信息全量同步", unit="symbol", dynamic_ncols=True) as pbar:
            symbol_tasks = [
                asyncio.create_task(
                    self._fetch_history_symbol_plan(
                        plan=plan,
                        semaphore=semaphore,
                        profiler=profiler,
                    )
                )
                for plan in plans
            ]

            for future in asyncio.as_completed(symbol_tasks):
                plan, normalized, error = await future
                try:
                    if error is not None:
                        raise error

                    if normalized is None:
                        raise RuntimeError("并发抓取结果缺少标准化载荷")

                    total_fetched_rows += int(normalized["fetched_rows"])

                    profile_row = normalized["profile"]
                    if profile_row is not None:
                        profile_rows.append(profile_row)
                    suspended_events.extend(normalized["suspended_events"])
                    st_events.extend(normalized["st_events"])
                    adjust_factor_rows.extend(normalized["adjust_factors"])
                    limit_bar_rows.extend(normalized["limit_bar_rows"])
                    status_meta_map[plan.security.vt_symbol] = _build_status_meta_payload(
                        security=plan.security,
                        checked_trade_date=plan.end_date,
                        trade_dates=trade_dates,
                        latest_data_trade_date=normalized["latest_data_trade_date"],
                        current_meta=meta_map.get(plan.security.vt_symbol),
                    )
                    processed_symbol_count += 1

                    # 仅在主协程里执行缓冲聚合与刷库，避免并发任务打乱写库时序与进度展示。
                    if (
                        processed_symbol_count % flush_symbol_count == 0
                        or len(adjust_factor_rows) >= SECURITY_SYNC_FACTOR_FLUSH_ROWS
                    ):
                        flush_started_at = perf_counter()
                        flushed = await flush_security_sync_buffers(
                            db,
                            profile_rows=profile_rows,
                            suspended_events=suspended_events,
                            st_events=st_events,
                            adjust_factor_rows=adjust_factor_rows,
                            limit_bar_rows=limit_bar_rows,
                            status_meta_map=status_meta_map,
                        )
                        if profiler is not None:
                            profiler.add("security_full_flush", flush_started_at)
                        total_profile_rows += flushed["profiles"]
                        total_suspended_events += flushed["suspended_events"]
                        total_st_events += flushed["st_events"]
                        total_adjust_factors += flushed["adjust_factors"]
                        total_status_metas += flushed["metas"]
                except Exception as exc:
                    failed_request_count += 1
                    processed_symbol_count += 1
                    self.progress_factory.write(
                        f"[全量失败 {processed_symbol_count}/{len(plans)}] {plan.security.gm_symbol} "
                        f"{plan.start_date} -> {plan.end_date}，错误：{exc}"
                    )
                finally:
                    running_task_count = sum(not task.done() for task in symbol_tasks)
                    pbar.set_postfix_str(
                        f"{plan.security.gm_symbol} | 窗口 {plan.start_date}->{plan.end_date} "
                        f"| 抓取 {total_fetched_rows} | 并发中 {running_task_count} "
                        f"| 因子缓冲 {len(adjust_factor_rows)} | 失败 {failed_request_count}"
                    )
                    pbar.update(1)

        flushed = await flush_security_sync_buffers(
            db,
            profile_rows=profile_rows,
            suspended_events=suspended_events,
            st_events=st_events,
            adjust_factor_rows=adjust_factor_rows,
            limit_bar_rows=limit_bar_rows,
            status_meta_map=status_meta_map,
        )
        total_profile_rows += flushed["profiles"]
        total_suspended_events += flushed["suspended_events"]
        total_st_events += flushed["st_events"]
        total_adjust_factors += flushed["adjust_factors"]
        total_status_metas += flushed["metas"]

        return {
            "planned_symbol_count": len(plans),
            "processed_trade_date_count": 0,
            "fetched_rows": total_fetched_rows,
            "saved_profile_rows": total_profile_rows,
            "saved_suspended_events": total_suspended_events,
            "saved_st_events": total_st_events,
            "saved_adjust_factors": total_adjust_factors,
            "saved_status_metas": total_status_metas,
            "failed_request_count": failed_request_count,
            "skipped_missing_meta_symbol_count": 0,
        }

    async def _run_by_date(
        self,
        db: DataBase,
        securities: list[SecurityInfo],
        trade_dates: list[date],
        latest_trade_date: date,
        profiler: StageProfiler | None,
    ) -> dict[str, object]:
        meta_map = await load_security_status_meta_map(db)
        pending_trade_dates, skipped_missing_meta_symbols = build_incremental_trade_dates(
            securities, meta_map, trade_dates, latest_trade_date
        )
        security_map = {item.gm_symbol: item for item in securities}
        security_by_vt_symbol = {item.vt_symbol: item for item in securities}

        total_fetched_rows = 0
        total_profile_rows = 0
        total_suspended_events = 0
        total_st_events = 0
        total_adjust_factors = 0
        total_status_metas = 0
        failed_request_count = 0

        with self.progress_factory(total=len(pending_trade_dates), desc="证券信息增量同步", unit="day", dynamic_ncols=True) as pbar:
            for trade_date in pending_trade_dates:
                profile_rows: list[dict[str, object]] = []
                suspended_events: list[dict[str, object]] = []
                st_events: list[dict[str, object]] = []
                adjust_factor_rows: list[dict[str, object]] = []
                limit_bar_rows: list[dict[str, object]] = []
                status_meta_map: dict[str, SecurityStatusMetaPayload] = {}
                day_checked_symbols: set[str] = set()
                day_skipped_rows = 0

                for config in SECURITY_GROUP_CONFIGS:
                    try:
                        asset_type = str(config["asset_type"])
                        fetch_started_at = perf_counter()
                        df = await self.provider.fetch_symbols_snapshot(asset_type, trade_date)
                        if profiler is not None:
                            profiler.add("security_incremental_fetch", fetch_started_at)

                        normalize_started_at = perf_counter()
                        normalized = _normalize_symbols_snapshot_result(
                            df=df,
                            security_map=security_map,
                            asset_securities=[item for item in securities if item.asset_type == asset_type],
                            trade_date=trade_date,
                            meta_map=meta_map,
                            skipped_missing_meta_symbols=skipped_missing_meta_symbols,
                        )
                        if profiler is not None:
                            profiler.add("security_incremental_normalize", normalize_started_at)
                        total_fetched_rows += int(normalized["fetched_rows"])
                        day_skipped_rows += int(normalized["skipped_rows"])
                        profile_rows.extend(normalized["profiles"])
                        suspended_events.extend(normalized["suspended_events"])
                        st_events.extend(normalized["st_events"])
                        adjust_factor_rows.extend(normalized["adjust_factors"])
                        limit_bar_rows.extend(normalized["limit_bar_rows"])
                        checked_symbols = set(normalized["updated_symbols"]) | set(normalized["checked_empty_symbols"])
                        for vt_symbol in checked_symbols:
                            security = security_by_vt_symbol[vt_symbol]
                            status_meta_map[vt_symbol] = _build_status_meta_payload(
                                security=security,
                                checked_trade_date=trade_date,
                                trade_dates=trade_dates,
                                latest_data_trade_date=trade_date.isoformat() if vt_symbol in normalized["updated_symbols"] else None,
                                current_meta=meta_map.get(vt_symbol),
                            )
                        day_checked_symbols.update(checked_symbols)
                    except Exception as exc:
                        failed_request_count += 1
                        self.progress_factory.write(f"[增量失败] 交易日 {trade_date} 资产组 {config['asset_type']}，错误：{exc}")

                for vt_symbol in day_checked_symbols:
                    saved_meta = status_meta_map[vt_symbol]
                    current_meta = meta_map.get(vt_symbol, {})
                    latest_data_trade_date = saved_meta.get("latest_data_trade_date")
                    meta_map[vt_symbol] = {
                        "vt_symbol": vt_symbol,
                        "latest_checked_trade_date": str(saved_meta["latest_checked_trade_date"]),
                        "latest_data_trade_date": (
                            None
                            if latest_data_trade_date is None
                            else str(latest_data_trade_date)
                        ),
                        "is_terminal": bool(saved_meta.get("is_terminal", False)),
                        "updated_at": str(current_meta.get("updated_at", "")),
                    }

                flushed = await flush_security_sync_buffers(
                    db,
                    profile_rows=profile_rows,
                    suspended_events=suspended_events,
                    st_events=st_events,
                    adjust_factor_rows=adjust_factor_rows,
                    limit_bar_rows=limit_bar_rows,
                    status_meta_map=status_meta_map,
                )
                total_profile_rows += flushed["profiles"]
                total_suspended_events += flushed["suspended_events"]
                total_st_events += flushed["st_events"]
                total_adjust_factors += flushed["adjust_factors"]
                total_status_metas += flushed["metas"]

                pbar.set_postfix_str(
                    f"{trade_date} | 检查证券 {len(day_checked_symbols)} | 抓取 {total_fetched_rows} "
                    f"| 跳过 {day_skipped_rows} | 失败 {failed_request_count}"
                )
                pbar.update(1)

        return {
            "planned_symbol_count": len(securities),
            "processed_trade_date_count": len(pending_trade_dates),
            "fetched_rows": total_fetched_rows,
            "saved_profile_rows": total_profile_rows,
            "saved_suspended_events": total_suspended_events,
            "saved_st_events": total_st_events,
            "saved_adjust_factors": total_adjust_factors,
            "saved_status_metas": total_status_metas,
            "failed_request_count": failed_request_count,
            "skipped_missing_meta_symbol_count": len(skipped_missing_meta_symbols),
        }
