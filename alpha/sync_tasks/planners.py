from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from alpha.sync_tasks.calendar import (
    align_to_next_trade_date,
    align_to_prev_trade_date,
    count_trade_dates_between,
    parse_date_like,
    shift_back_calendar_days,
)
from alpha.sync_tasks.constants import DEFAULT_START_DATE, MAX_HISTORY_ROWS_PER_REQUEST
from alpha.sync_tasks.models import (
    BarSyncPlan,
    IndexConstituentSyncPlan,
    SecurityInfo,
    SecuritySyncPlan,
    YearPlan,
)


def build_full_security_sync_plans(
    securities: list[SecurityInfo],
    meta_map: dict[str, dict[str, object]],
    trade_dates: list[date],
    latest_trade_date: date,
    plan_mode: Literal["incremental", "full"] = "incremental",
) -> list[SecuritySyncPlan]:
    """为逐证券证券资料同步构建计划。

    Args:
        securities: 待同步证券列表。
        meta_map: 数据库中已有的同步元数据映射，键为 ``vt_symbol``。
        trade_dates: 可用交易日列表。
        latest_trade_date: 本次同步目标截止交易日。
        plan_mode: 计划构建模式。
            - ``"incremental"``: 默认模式，起点会参考元数据中的
              ``latest_checked_trade_date``，从下一交易日续跑；
            - ``"full"``: 忽略元数据游标，直接从 ``2005-01-01`` 对齐后的首个
              交易日与证券 ``listed_date`` 中较晚者开始。

    Returns:
        list[SecuritySyncPlan]: 按起止日期排序后的同步计划列表。

    Raises:
        ValueError: 当 ``plan_mode`` 非法，或 2005 年后的起始交易日不存在时抛出。
    """
    if plan_mode not in {"incremental", "full"}:
        raise ValueError(f"不支持的证券同步计划模式: {plan_mode}")

    first_trade_date = align_to_next_trade_date(DEFAULT_START_DATE, trade_dates)
    if first_trade_date is None:
        raise ValueError("2005 年之后未找到可用交易日")

    plans: list[SecuritySyncPlan] = []
    for item in securities:
        meta_row = meta_map.get(item.vt_symbol)
        if meta_row is not None and bool(meta_row.get("is_terminal", False)):
            continue

        listed_trade_date = align_to_next_trade_date(item.listed_date, trade_dates)
        if listed_trade_date is None:
            continue

        # 全量模式至少从 2005 年起跑；增量模式再额外参考元数据游标续跑。
        start_candidates = [first_trade_date, listed_trade_date]
        if plan_mode == "incremental":
            meta_trade_date_text = None if meta_row is None else meta_row.get("latest_checked_trade_date")
            if meta_trade_date_text is not None:
                meta_trade_date = parse_date_like(meta_trade_date_text)
                if meta_trade_date is not None:
                    next_trade_date = align_to_next_trade_date(meta_trade_date + timedelta(days=1), trade_dates)
                    if next_trade_date is not None:
                        start_candidates.append(next_trade_date)
        start_date = max(start_candidates)

        end_date = latest_trade_date
        if item.delisted_date is not None:
            delisted_trade_date = align_to_prev_trade_date(item.delisted_date, trade_dates)
            if delisted_trade_date is None:
                continue
            end_date = min(end_date, delisted_trade_date)

        if start_date > end_date:
            continue

        plans.append(SecuritySyncPlan(security=item, start_date=start_date, end_date=end_date))

    plans.sort(key=lambda item: (item.start_date, item.end_date, item.security.vt_symbol))
    return plans


def build_incremental_trade_dates(
    securities: list[SecurityInfo],
    meta_map: dict[str, dict[str, object]],
    trade_dates: list[date],
    latest_trade_date: date,
) -> tuple[list[date], set[str]]:
    """构建增量模式应扫描的交易日与应跳过的缺失历史证券。"""
    next_trade_dates: list[date] = []
    for item in securities:
        meta_row = meta_map.get(item.vt_symbol)
        if meta_row is None or bool(meta_row.get("is_terminal", False)):
            continue
        meta_trade_date_text = meta_row.get("latest_checked_trade_date")
        if meta_trade_date_text is None:
            continue
        meta_trade_date = parse_date_like(meta_trade_date_text)
        if meta_trade_date is None:
            continue
        next_trade_date = align_to_next_trade_date(meta_trade_date + timedelta(days=1), trade_dates)
        if next_trade_date is not None and next_trade_date <= latest_trade_date:
            next_trade_dates.append(next_trade_date)

    start_date = min(next_trade_dates) if next_trade_dates else latest_trade_date
    pending_trade_dates = [trade_date for trade_date in trade_dates if start_date <= trade_date <= latest_trade_date]

    skipped_missing_meta_symbols: set[str] = set()
    for item in securities:
        meta_row = meta_map.get(item.vt_symbol)
        if meta_row is not None:
            continue
        listed_trade_date = align_to_next_trade_date(item.listed_date, trade_dates)
        if listed_trade_date is None:
            continue
        if listed_trade_date < start_date:
            skipped_missing_meta_symbols.add(item.vt_symbol)

    return pending_trade_dates, skipped_missing_meta_symbols


def build_index_constituent_sync_plans(
    indices: list[SecurityInfo],
    meta_map: dict[str, str],
    trade_dates: list[date],
    latest_trade_date: date,
) -> list[IndexConstituentSyncPlan]:
    """构建指数成分股同步计划。"""
    first_trade_date = align_to_next_trade_date(DEFAULT_START_DATE, trade_dates)
    if first_trade_date is None:
        raise ValueError("2005 年之后未找到可用交易日")

    plans: list[IndexConstituentSyncPlan] = []
    for item in indices:
        if item.delisted_date is not None and item.delisted_date < latest_trade_date:
            continue

        listed_trade_date = align_to_next_trade_date(item.listed_date, trade_dates)
        if listed_trade_date is None:
            continue

        start_candidates = [listed_trade_date, first_trade_date]
        meta_trade_date_text = meta_map.get(item.vt_symbol)
        if meta_trade_date_text is not None:
            meta_trade_date = parse_date_like(meta_trade_date_text)
            if meta_trade_date is not None:
                next_trade_date = align_to_next_trade_date(meta_trade_date + timedelta(days=1), trade_dates)
                if next_trade_date is not None:
                    start_candidates.append(next_trade_date)
        start_date = max(start_candidates)

        end_date = latest_trade_date
        if item.delisted_date is not None:
            delisted_trade_date = align_to_prev_trade_date(item.delisted_date, trade_dates)
            if delisted_trade_date is None:
                continue
            end_date = min(end_date, delisted_trade_date)

        if start_date > end_date:
            continue

        plans.append(IndexConstituentSyncPlan(security=item, start_date=start_date, end_date=end_date))

    plans.sort(key=lambda item: (item.start_date, item.end_date, item.security.vt_symbol))
    return plans


def build_bar_sync_plans(
    securities: list[SecurityInfo],
    overview_map: dict[str, dict[str, object]],
    trade_dates: list[date],
    latest_trade_date: date,
    overlap_validation_days: int = 30,
) -> list[BarSyncPlan]:
    """根据证券池、概览和交易日构建增量更新计划。"""
    if overlap_validation_days < 0:
        raise ValueError("overlap_validation_days 不能小于 0")

    first_trade_date = align_to_next_trade_date(DEFAULT_START_DATE, trade_dates)
    if first_trade_date is None:
        raise ValueError("未找到 2005 年起始交易日")

    plans: list[BarSyncPlan] = []
    for item in securities:
        listed_trade_date = align_to_next_trade_date(item.listed_date, trade_dates)
        if listed_trade_date is None:
            continue

        existing_start: date | None = None
        existing_end: date | None = None
        overlap_start: date | None = None
        overview_row = overview_map.get(item.vt_symbol)
        start_candidates = [first_trade_date, listed_trade_date]

        if overview_row is not None:
            existing_start = parse_date_like(overview_row["start"])
            existing_end = parse_date_like(overview_row["end"])
            if existing_end is not None:
                if overlap_validation_days > 0:
                    overlap_anchor = shift_back_calendar_days(existing_end, overlap_validation_days)
                    overlap_start = align_to_next_trade_date(overlap_anchor, trade_dates)
                    if overlap_start is not None:
                        start_candidates.append(overlap_start)
                else:
                    incremental_start = align_to_next_trade_date(existing_end + timedelta(days=1), trade_dates)
                    if incremental_start is not None:
                        start_candidates.append(incremental_start)

        start_date = max(start_candidates)
        end_date = latest_trade_date
        if item.delisted_date is not None:
            delisted_trade_date = align_to_prev_trade_date(item.delisted_date, trade_dates)
            if delisted_trade_date is None:
                continue
            end_date = min(end_date, delisted_trade_date)

        if start_date > end_date:
            continue

        expected_rows = count_trade_dates_between(trade_dates, start_date, end_date)
        if expected_rows <= 0:
            continue

        plans.append(
            BarSyncPlan(
                asset_type=item.asset_type,
                gm_symbol=item.gm_symbol,
                vt_symbol=item.vt_symbol,
                sec_id=item.sec_id,
                db_exchange=item.db_exchange,
                start_date=start_date,
                end_date=end_date,
                expected_rows=expected_rows,
                existing_start=existing_start,
                existing_end=existing_end,
                overlap_start=overlap_start,
            )
        )

    plans.sort(key=lambda item: (item.start_date, item.end_date, item.vt_symbol))
    return plans


def chunk_bar_sync_plans(
    plans: list[BarSyncPlan],
    max_rows_per_request: int = MAX_HISTORY_ROWS_PER_REQUEST,
) -> list[list[BarSyncPlan]]:
    """按时间窗口和预估条数切分请求批次。"""
    grouped: dict[tuple[date, date], list[BarSyncPlan]] = {}
    for plan in plans:
        grouped.setdefault((plan.start_date, plan.end_date), []).append(plan)

    batches: list[list[BarSyncPlan]] = []
    for key in sorted(grouped):
        current_batch: list[BarSyncPlan] = []
        current_rows = 0
        for plan in grouped[key]:
            next_rows = current_rows + plan.expected_rows
            if current_batch and next_rows > max_rows_per_request:
                batches.append(current_batch)
                current_batch = []
                current_rows = 0
            current_batch.append(plan)
            current_rows += plan.expected_rows
        if current_batch:
            batches.append(current_batch)
    return batches


def split_bar_sync_plans_by_year(
    plans: list[BarSyncPlan],
    trade_dates: list[date],
) -> list[YearPlan]:
    """将更新计划按年份拆分为年内区间。"""
    year_plans: list[YearPlan] = []
    for plan in plans:
        for year in range(plan.start_date.year, plan.end_date.year + 1):
            year_start = max(plan.start_date, date(year, 1, 1))
            year_end = min(plan.end_date, date(year, 12, 31))
            aligned_start = align_to_next_trade_date(year_start, trade_dates)
            aligned_end = align_to_prev_trade_date(year_end, trade_dates)
            if aligned_start is None or aligned_end is None or aligned_start > aligned_end:
                continue

            expected_rows = count_trade_dates_between(trade_dates, aligned_start, aligned_end)
            if expected_rows <= 0:
                continue

            year_plans.append(
                YearPlan(
                    year=year,
                    asset_type=plan.asset_type,
                    gm_symbol=plan.gm_symbol,
                    vt_symbol=plan.vt_symbol,
                    sec_id=plan.sec_id,
                    db_exchange=plan.db_exchange,
                    start_date=aligned_start,
                    end_date=aligned_end,
                    expected_rows=expected_rows,
                    existing_start=plan.existing_start,
                    existing_end=plan.existing_end,
                    overlap_start=plan.overlap_start,
                )
            )

    year_plans.sort(key=lambda item: (item.year, item.start_date, item.end_date, item.vt_symbol))
    return year_plans


def chunk_year_plans(
    year_plans: list[YearPlan],
    max_rows_per_request: int = MAX_HISTORY_ROWS_PER_REQUEST,
) -> dict[int, list[list[YearPlan]]]:
    """按年份、时间窗口和预估条数切分请求批次。"""
    grouped_by_year: dict[int, list[YearPlan]] = {}
    for plan in year_plans:
        grouped_by_year.setdefault(plan.year, []).append(plan)

    batches_by_year: dict[int, list[list[YearPlan]]] = {}
    for year, plans in grouped_by_year.items():
        year_batches = chunk_bar_sync_plans(plans, max_rows_per_request)
        batches_by_year[year] = year_batches
    return batches_by_year
