from __future__ import annotations

from datetime import date, datetime, time
from typing import Iterable

import pandas as pd

from alpha.common.enums import Interval
from alpha.common.schema import BarDataQuery
from alpha.storage.database import DataBase
from alpha.sync_tasks.models import BarSyncPlan, ValidationIssue, YearPlan


def group_rows_by_vt_symbol(rows: Iterable[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    """按 vt_symbol 分组。"""
    grouped: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        vt_symbol = str(row["vt_symbol"])
        grouped.setdefault(vt_symbol, []).append(row)
    return grouped


async def load_existing_overlap_rows(
    db: DataBase,
    vt_symbol: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, object]]:
    """加载数据库中重叠区的原有数据。"""
    query = BarDataQuery(
        vt_symbol=vt_symbol,
        interval=Interval.DAILY.value,
        start=datetime.combine(start_date, time.min),
        end=datetime.combine(end_date, time.min),
    )
    return await db.load_bar_data(query)


async def validate_overlap_rows(
    db: DataBase,
    plan: BarSyncPlan | YearPlan,
    fetched_rows: list[dict[str, object]],
) -> list[ValidationIssue]:
    """校验重叠区是否存在污染。"""
    if plan.existing_end is None or plan.overlap_start is None:
        return []

    existing_rows = await load_existing_overlap_rows(
        db,
        plan.vt_symbol,
        plan.overlap_start,
        plan.existing_end,
    )
    if not existing_rows:
        return []

    existing_map = {str(row["datetime"]).split(" ")[0]: row for row in existing_rows}
    fetched_map = {
        str(row["datetime"]).split(" ")[0]: row
        for row in fetched_rows
        if plan.overlap_start <= pd.Timestamp(row["datetime"]).date() <= plan.existing_end
    }

    issues: list[ValidationIssue] = []
    compare_fields = ("open", "high", "low", "close", "volume", "turnover")
    for trade_date, fetched_row in fetched_map.items():
        existing_row = existing_map.get(trade_date)
        if existing_row is None:
            continue
        for field in compare_fields:
            existing_value = float(existing_row[field] or 0)
            fetched_value = float(fetched_row[field] or 0)
            if abs(existing_value - fetched_value) > 1e-8:
                issues.append(
                    ValidationIssue(
                        vt_symbol=plan.vt_symbol,
                        trade_date=trade_date,
                        field=field,
                        db_value=existing_value,
                        fetched_value=fetched_value,
                    )
                )
    return issues
