from __future__ import annotations

from datetime import date, datetime, time
from math import isfinite
import pandas as pd

from alpha.common.enums import Interval
from alpha.common.schema import BarDataQuery
from alpha.storage.database import DataBase
from alpha.sync_tasks.constants import MAX_QUALITY_ISSUES
from alpha.sync_tasks.models import (
    BarBatchValidation,
    BarSyncPlan,
    BarWriteCoverage,
    ValidationIssue,
    ValidationResult,
    YearPlan,
)

_REQUIRED_NUMERIC_FIELDS = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "turnover",
    "open_interest",
)


def _append_issue(
    issues: list[ValidationIssue],
    issue: ValidationIssue,
    *,
    limit: int,
) -> None:
    """在固定上限内保留一条异常明细。"""
    if len(issues) < limit:
        issues.append(issue)


def validate_bar_batch(
    rows: list[dict[str, object]],
    plans: list[YearPlan],
    *,
    issue_limit: int = MAX_QUALITY_ISSUES,
) -> BarBatchValidation:
    """单次遍历校验标准日线批次并汇总待写覆盖。

    任何字段或 OHLC 异常都会拒绝整个 provider 批次；预期行数不足只记录
    覆盖缺口，允许已有合法行继续写入并进入后续定向重试。
    """
    plan_map = {plan.vt_symbol: plan for plan in plans}
    coverage: dict[str, BarWriteCoverage] = {}
    rows_by_symbol: dict[str, list[dict[str, object]]] = {}
    seen_keys: set[tuple[str, date]] = set()
    issues: list[ValidationIssue] = []
    retry_vt_symbols: set[str] = set()
    issue_count = 0
    blocking_issue_count = 0

    def reject(
        *,
        vt_symbol: str,
        trade_date: str,
        field: str,
        kind: str,
        message: str,
    ) -> None:
        nonlocal issue_count, blocking_issue_count
        issue_count += 1
        blocking_issue_count += 1
        _append_issue(
            issues,
            ValidationIssue(
                vt_symbol=vt_symbol,
                trade_date=trade_date,
                field=field,
                kind=kind,
                message=message,
            ),
            limit=issue_limit,
        )

    for row in rows:
        vt_symbol = str(row.get("vt_symbol") or "").strip()
        datetime_text = str(row.get("datetime") or "").strip()
        trade_date_text = datetime_text[:10]
        plan = plan_map.get(vt_symbol)
        if plan is None:
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="vt_symbol",
                kind="unexpected_symbol",
                message="返回标的不在当前同步批次",
            )
            continue
        if len(datetime_text) != 19 or datetime_text[10:] != " 00:00:00":
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="datetime",
                kind="invalid_datetime",
                message="日线时间必须是交易日零点",
            )
            continue
        try:
            trade_date = date.fromisoformat(trade_date_text)
        except ValueError:
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="datetime",
                kind="invalid_datetime",
                message="交易日格式非法",
            )
            continue
        if not plan.start_date <= trade_date <= plan.end_date:
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="datetime",
                kind="out_of_range",
                message="交易日超出当前同步计划",
            )
            continue
        if row.get("interval") != "d" or row.get("adjust") != "non":
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="interval",
                kind="invalid_semantics",
                message="日线同步只接受未复权日线",
            )
            continue

        key = (vt_symbol, trade_date)
        if key in seen_keys:
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="datetime",
                kind="duplicate_key",
                message="批次内存在重复主键",
            )
            continue
        seen_keys.add(key)

        numbers: dict[str, float] = {}
        invalid_field: str | None = None
        for field_name in _REQUIRED_NUMERIC_FIELDS:
            value = row.get(field_name)
            if isinstance(value, bool):
                invalid_field = field_name
                break
            try:
                number = float(value)
            except (TypeError, ValueError):
                invalid_field = field_name
                break
            if not isfinite(number):
                invalid_field = field_name
                break
            numbers[field_name] = number
        if invalid_field is not None:
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field=invalid_field,
                kind="invalid_number",
                message="行情字段必须是有限数值",
            )
            continue
        if any(numbers[field] < 0 for field in ("volume", "turnover", "open_interest")):
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="volume",
                kind="negative_quantity",
                message="成交量、成交额和持仓量不能为负数",
            )
            continue
        if (
            numbers["high"] < max(numbers["open"], numbers["close"])
            or numbers["low"] > min(numbers["open"], numbers["close"])
            or numbers["high"] < numbers["low"]
        ):
            reject(
                vt_symbol=vt_symbol,
                trade_date=trade_date_text,
                field="ohlc",
                kind="invalid_ohlc",
                message="OHLC 高低价关系非法",
            )
            continue

        current = coverage.get(vt_symbol)
        if current is None:
            coverage[vt_symbol] = BarWriteCoverage(trade_date, trade_date, 1)
        else:
            current.start = min(current.start, trade_date)
            current.end = max(current.end, trade_date)
            current.rows += 1
        rows_by_symbol.setdefault(vt_symbol, []).append(row)

    if blocking_issue_count == 0:
        for plan in plans:
            actual_rows = coverage.get(plan.vt_symbol)
            actual_count = actual_rows.rows if actual_rows else 0
            if actual_count >= plan.expected_rows:
                continue
            issue_count += 1
            retry_vt_symbols.add(plan.vt_symbol)
            _append_issue(
                issues,
                ValidationIssue(
                    vt_symbol=plan.vt_symbol,
                    trade_date=f"{plan.start_date.isoformat()}..{plan.end_date.isoformat()}",
                    field="rows",
                    kind="coverage_gap",
                    message=f"预期 {plan.expected_rows} 行，实际 {actual_count} 行",
                ),
                limit=issue_limit,
            )

    return BarBatchValidation(
        can_write=blocking_issue_count == 0,
        issue_count=issue_count,
        issues=issues,
        coverage=coverage,
        rows_by_symbol=rows_by_symbol,
        retry_vt_symbols=retry_vt_symbols,
    )


def merge_bar_coverage(
    target: dict[str, BarWriteCoverage],
    incoming: dict[str, BarWriteCoverage],
) -> None:
    """把单批覆盖合并到任务级覆盖，不保留逐行主键。"""
    for vt_symbol, current in incoming.items():
        existing = target.get(vt_symbol)
        if existing is None:
            target[vt_symbol] = BarWriteCoverage(
                current.start,
                current.end,
                current.rows,
            )
            continue
        existing.start = min(existing.start, current.start)
        existing.end = max(existing.end, current.end)
        existing.rows += current.rows


def validate_overview_coverage(
    overview_rows: list[dict[str, object]],
    expected: dict[str, BarWriteCoverage],
    *,
    issue_limit: int = MAX_QUALITY_ISSUES,
) -> ValidationResult:
    """使用一次主库 overview 读取核对本次写入覆盖。"""
    overview_map = {
        str(row.get("vt_symbol")): row
        for row in overview_rows
        if row.get("interval") == "d"
    }
    result = ValidationResult()
    for vt_symbol, coverage in expected.items():
        row = overview_map.get(vt_symbol)
        valid = False
        if row is not None:
            try:
                actual_start = date.fromisoformat(str(row.get("start"))[:10])
                actual_end = date.fromisoformat(str(row.get("end"))[:10])
                actual_count = int(row.get("count") or 0)
                valid = (
                    actual_start <= coverage.start
                    and actual_end >= coverage.end
                    and actual_count >= coverage.rows
                )
            except (TypeError, ValueError):
                valid = False
        if valid:
            continue
        result.issue_count += 1
        result.affected_vt_symbols.add(vt_symbol)
        _append_issue(
            result.issues,
            ValidationIssue(
                vt_symbol=vt_symbol,
                trade_date=f"{coverage.start.isoformat()}..{coverage.end.isoformat()}",
                field="bar_overview",
                kind="overview_mismatch",
                message="写入后的行情概览未覆盖本次合法数据",
            ),
            limit=issue_limit,
        )
    return result


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
) -> ValidationResult:
    """校验重叠区是否存在污染。"""
    if plan.existing_end is None or plan.overlap_start is None:
        return ValidationResult()

    existing_rows = await load_existing_overlap_rows(
        db,
        plan.vt_symbol,
        plan.overlap_start,
        plan.existing_end,
    )
    if not existing_rows:
        return ValidationResult()

    existing_map = {str(row["datetime"]).split(" ")[0]: row for row in existing_rows}
    fetched_map = {
        str(row["datetime"]).split(" ")[0]: row
        for row in fetched_rows
        if plan.overlap_start
        <= pd.Timestamp(row["datetime"]).date()
        <= plan.existing_end
    }

    result = ValidationResult()
    compare_fields = ("open", "high", "low", "close", "volume", "turnover")
    for trade_date, fetched_row in fetched_map.items():
        existing_row = existing_map.get(trade_date)
        if existing_row is None:
            continue
        for field in compare_fields:
            existing_value = float(existing_row[field] or 0)
            fetched_value = float(fetched_row[field] or 0)
            if abs(existing_value - fetched_value) > 1e-8:
                result.issue_count += 1
                _append_issue(
                    result.issues,
                    ValidationIssue(
                        vt_symbol=plan.vt_symbol,
                        trade_date=trade_date,
                        field=field,
                        db_value=existing_value,
                        fetched_value=fetched_value,
                        message="重叠区新旧行情不一致",
                    ),
                    limit=MAX_QUALITY_ISSUES,
                )
    return result
