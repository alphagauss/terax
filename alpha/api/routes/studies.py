"""Alpha 图表技术指标 definition 与批量计算接口。"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.models import (
    StudyCalculationRequest,
    StudyCalculationResponse,
    StudyDefinitionResponse,
)
from alpha.api.routes._utils import date_text, first_number, normalize_adjust
from alpha.api.routes.bars import (
    _exclusive_after,
    _market_local_datetime,
    bar_time,
)
from alpha.chart.studies import (
    StudyComputationError,
    StudyValidationError,
    calculate_studies,
    maximum_study_lookback,
    normalize_study_instances,
    study_definition_payloads,
)
from alpha.common.schema_market import BarHistoryQuery
from alpha.realtime.model import MarketDataKey

router = APIRouter()
MAX_STUDY_BARS = 4000


def _row_datetime(row: dict[str, object]) -> datetime:
    """读取存储行情的本地时间，用于裁剪用户显示区间。"""
    value = date_text(row.get("datetime") or row.get("time"))
    if value is None:
        raise StudyComputationError("指标行情缺少时间")
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise StudyComputationError("指标行情时间格式非法") from exc


@router.get("/studies", response_model=list[StudyDefinitionResponse])
async def get_studies() -> list[dict[str, object]]:
    """返回首批服务端权威指标 definition。"""
    return study_definition_payloads()


@router.post("/studies/calculate", response_model=StudyCalculationResponse)
async def calculate_chart_studies(
    request: StudyCalculationRequest,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取一次含 warmup 的有界行情并批量计算指标。"""
    try:
        instances = normalize_study_instances(
            [study.model_dump() for study in request.studies]
        )
    except StudyValidationError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"code": "invalid_study", "message": str(exc)},
        ) from exc

    query_start = _market_local_datetime(request.start, request.vt_symbol)
    query_end = _market_local_datetime(
        request.end,
        request.vt_symbol,
        end_of_day=True,
    )
    if query_start is None or query_end is None or query_start > query_end:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"code": "invalid_study_range"},
        )

    lookback = maximum_study_lookback(instances)
    page = await services.database.load_bar_history(
        BarHistoryQuery(
            vt_symbol=request.vt_symbol,
            interval=request.interval,
            adjust=normalize_adjust(request.adjust),
            before=_exclusive_after(query_end),
            limit=MAX_STUDY_BARS + lookback,
        )
    )
    rows = page["items"]
    _, live_bars = await services.market_data.snapshot(
        MarketDataKey(
            vt_symbol=request.vt_symbol,
            interval=request.interval,
            adjust=request.adjust,
        )
    )
    if live_bars:
        rows_by_time = {_row_datetime(row): row for row in rows}
        for live_bar in live_bars:
            live_datetime = _market_local_datetime(
                live_bar.time,
                request.vt_symbol,
            )
            if live_datetime is not None and live_datetime <= query_end:
                rows_by_time[live_datetime] = {
                    "datetime": live_datetime.isoformat(sep=" "),
                    "close": live_bar.close,
                }
        rows = [rows_by_time[key] for key in sorted(rows_by_time)]
    try:
        row_datetimes = [_row_datetime(row) for row in rows]
    except StudyComputationError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            {"code": "study_calculation_failed"},
        ) from exc

    visible_from = next(
        (
            index
            for index, row_datetime in enumerate(row_datetimes)
            if row_datetime >= query_start
        ),
        len(rows),
    )
    visible_rows = rows[visible_from:]
    if len(visible_rows) > MAX_STUDY_BARS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"code": "study_bar_limit_exceeded", "limit": MAX_STUDY_BARS},
        )

    calculation_rows = [
        {
            "time": bar_time(row, request.interval, request.vt_symbol),
            "close": first_number(row, ("close",)),
        }
        for row in rows
    ]
    try:
        items = await asyncio.to_thread(
            calculate_studies,
            calculation_rows,
            instances,
            visible_from=visible_from,
        )
    except StudyComputationError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            {"code": "study_calculation_failed"},
        ) from exc

    actual_start = (
        bar_time(visible_rows[0], request.interval, request.vt_symbol)
        if visible_rows
        else None
    )
    actual_end = (
        bar_time(visible_rows[-1], request.interval, request.vt_symbol)
        if visible_rows
        else None
    )
    return {
        "actual_start": actual_start,
        "actual_end": actual_end,
        "items": items,
    }
