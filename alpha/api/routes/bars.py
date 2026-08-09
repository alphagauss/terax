"""Alpha K 线接口。"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.routes._utils import (
    MAX_BAR_LIMIT,
    clamp_limit,
    date_text,
    first_number,
    normalize_adjust,
    normalize_interval,
    parse_datetime,
)
from alpha.common.schema_market import BarDataQuery

router = APIRouter()


def _bar_item(row: dict[str, object]) -> dict[str, object]:
    """构造图表友好的 K 线行。

    Args:
        row: 数据库 K 线行。

    Returns:
        前端 K 线数据。
    """

    return {
        "time": date_text(row.get("datetime") or row.get("time")) or "",
        "open": first_number(row, ("open",)) or 0,
        "high": first_number(row, ("high",)) or 0,
        "low": first_number(row, ("low",)) or 0,
        "close": first_number(row, ("close",)) or 0,
        "volume": first_number(row, ("volume",)),
        "amount": first_number(row, ("amount", "turnover")),
    }


def _overview_window(
    overview: dict[str, object] | None,
) -> tuple[datetime | None, datetime | None]:
    """从单条 K 线概览读取查询窗口。"""
    if overview is None:
        return None, None
    start_text = date_text(overview.get("start"))
    end_text = date_text(overview.get("end"))
    start = parse_datetime(start_text) if start_text else None
    end = parse_datetime(end_text, end_of_day=True) if end_text else None
    return start, end


@router.get("/bars", response_model=dict[str, object])
async def get_bars(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    vt_symbol: str,
    interval: str = "d",
    start: str | None = None,
    end: str | None = None,
    adjust: str = "none",
    limit: int = 500,
) -> dict[str, object]:
    """读取单证券 K 线。

    Args:
        services: Alpha 业务服务容器。
        vt_symbol: 项目内部证券代码。
        interval: 周期。
        start: 开始日期。
        end: 结束日期。
        adjust: 复权方式。
        limit: 最大返回条数。

    Returns:
        图表友好的 K 线响应。
    """

    normalized_interval = normalize_interval(interval)
    normalized_adjust = normalize_adjust(adjust)
    normalized_limit = clamp_limit(limit, default=500, maximum=MAX_BAR_LIMIT)

    overview = await services.database.get_bar_overview_item(
        vt_symbol,
        normalized_interval,
    )
    overview_start, overview_end = _overview_window(overview)
    query_end = parse_datetime(end, end_of_day=True) or overview_end or datetime.now()
    query_start = (
        parse_datetime(start)
        or overview_start
        or query_end - timedelta(days=max(normalized_limit * 2, 365))
    )

    rows = await services.database.load_bar_data(
        BarDataQuery(
            vt_symbol=vt_symbol,
            interval=cast(Literal["1m", "1h", "d", "w", "tick"], normalized_interval),
            adjust=normalized_adjust,
            start=query_start,
            end=query_end,
        )
    )
    items = [_bar_item(row) for row in rows][-normalized_limit:]
    return {
        "vt_symbol": vt_symbol,
        "interval": interval,
        "adjust": adjust,
        "items": items,
    }
