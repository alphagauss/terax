"""Alpha K 线接口。"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Annotated, Literal, cast
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, status

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
from alpha.common.market_metadata import get_market_metadata
from alpha.common.schema_market import BarDataQuery, BarHistoryQuery

router = APIRouter()


def _exchange_timezone(vt_symbol: str) -> ZoneInfo:
    """返回证券所属交易所时区。"""
    return get_market_metadata(vt_symbol).timezone


def _market_local_datetime(
    value: str | None,
    vt_symbol: str,
    *,
    end_of_day: bool = False,
) -> datetime | None:
    """把 API 时间边界归一到数据库使用的交易所本地时间。"""
    parsed = parse_datetime(value, end_of_day=end_of_day)
    if parsed is None or parsed.tzinfo is None:
        return parsed
    return parsed.astimezone(_exchange_timezone(vt_symbol)).replace(tzinfo=None)


def bar_time(row: dict[str, object], interval: str, vt_symbol: str) -> str:
    """把存储时间转换为公共行情协议要求的时间文本。

    日线和周线保留无时区交易日；盘中数据按证券所属交易所解释存储中的
    本地时间，并输出带偏移的 ISO 时间，避免前端按系统时区猜测。
    """
    value = date_text(row.get("datetime") or row.get("time")) or ""
    if interval in {"d", "w"} or not value:
        return value

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_exchange_timezone(vt_symbol))
    return parsed.isoformat()


def _bar_item(
    row: dict[str, object],
    *,
    interval: str,
    vt_symbol: str,
) -> dict[str, object]:
    """构造图表友好的 K 线行。

    Args:
        row: 数据库 K 线行。
        interval: 已归一化的行情周期。
        vt_symbol: 用于确定盘中行情交易所时区的证券代码。

    Returns:
        前端 K 线数据。
    """

    return {
        "time": bar_time(row, interval, vt_symbol),
        "open": first_number(row, ("open",)) or 0,
        "high": first_number(row, ("high",)) or 0,
        "low": first_number(row, ("low",)) or 0,
        "close": first_number(row, ("close",)) or 0,
        "volume": first_number(row, ("volume",)),
        "amount": first_number(row, ("amount", "turnover")),
        "open_interest": first_number(row, ("open_interest",)),
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


def _exclusive_after(value: datetime | None) -> datetime | None:
    """把闭区间锚点转换为历史查询可消费的排他上界。"""
    return value + timedelta(microseconds=1) if value is not None else None


async def _load_price_reference(
    services: AlphaServiceContainer,
    *,
    vt_symbol: str,
    interval: str,
    adjust: Literal["pre", "post", "non"],
    anchor: datetime | None,
) -> tuple[float | None, str | None]:
    """读取与当前周期、复权和查询锚点一致的参考收盘价。

    历史分页不把页游标作为锚点，调用方传入 ``None`` 时始终以完整覆盖范围
    的最新数据为准。盘中周期先定位最新交易时段，再读取该时段之前最近的
    已完成日线收盘价。
    """
    normalized_interval = cast(
        Literal["1m", "1h", "d", "w", "tick"],
        interval,
    )
    if interval in {"d", "w"}:
        page = await services.database.load_bar_history(
            BarHistoryQuery(
                vt_symbol=vt_symbol,
                interval=normalized_interval,
                adjust=adjust,
                before=_exclusive_after(anchor),
                limit=2,
            )
        )
        rows = page["items"]
        if len(rows) < 2:
            return None, None
        row = rows[-2]
        return first_number(row, ("close",)), bar_time(row, interval, vt_symbol)

    anchor_page = await services.database.load_bar_history(
        BarHistoryQuery(
            vt_symbol=vt_symbol,
            interval=normalized_interval,
            adjust=adjust,
            before=_exclusive_after(anchor),
            limit=1,
        )
    )
    if not anchor_page["items"]:
        return None, None
    anchor_text = date_text(anchor_page["items"][-1].get("datetime"))
    if not anchor_text:
        return None, None
    session_start = datetime.combine(
        datetime.fromisoformat(anchor_text).date(), time.min
    )
    daily_page = await services.database.load_bar_history(
        BarHistoryQuery(
            vt_symbol=vt_symbol,
            interval="d",
            adjust=adjust,
            before=session_start,
            limit=1,
        )
    )
    if not daily_page["items"]:
        return None, None
    row = daily_page["items"][-1]
    return first_number(row, ("close",)), bar_time(row, "d", vt_symbol)


@router.get("/bars", response_model=dict[str, object])
async def get_bars(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    vt_symbol: str,
    interval: str = "d",
    start: str | None = None,
    end: str | None = None,
    before: str | None = None,
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
        before: 历史分页使用的排他时间游标，不能与起止范围同时使用。
        adjust: 复权方式。
        limit: 最大返回条数。

    Returns:
        图表友好的 K 线响应。
    """

    normalized_interval = normalize_interval(interval)
    normalized_adjust = normalize_adjust(adjust)
    normalized_limit = clamp_limit(limit, default=500, maximum=MAX_BAR_LIMIT)

    if before is not None and (start is not None or end is not None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "before 不能与 start 或 end 同时使用",
        )

    if start is None and end is None:
        page = await services.database.load_bar_history(
            BarHistoryQuery(
                vt_symbol=vt_symbol,
                interval=cast(
                    Literal["1m", "1h", "d", "w", "tick"],
                    normalized_interval,
                ),
                adjust=normalized_adjust,
                before=_market_local_datetime(before, vt_symbol),
                limit=normalized_limit,
            )
        )
        items = [
            _bar_item(row, interval=normalized_interval, vt_symbol=vt_symbol)
            for row in page["items"]
        ]
        has_more_before = bool(page["has_more_before"])
        next_before = page["next_before"]
        reference_close, reference_time = await _load_price_reference(
            services,
            vt_symbol=vt_symbol,
            interval=normalized_interval,
            adjust=normalized_adjust,
            anchor=None,
        )
        if before is None and normalized_interval in {"d", "w"} and len(items) >= 2:
            reference_close = first_number(items[-2], ("close",))
            reference_time = str(items[-2]["time"])
        return {
            "vt_symbol": vt_symbol,
            "interval": normalized_interval,
            "adjust": normalized_adjust,
            **page,
            "items": items,
            "has_more_before": has_more_before,
            "next_before": next_before,
            "actual_start": items[0]["time"] if items else None,
            "actual_end": items[-1]["time"] if items else None,
            "reference_close": reference_close,
            "reference_time": reference_time,
        }

    overview = await services.database.get_bar_overview_item(
        vt_symbol,
        normalized_interval,
    )
    overview_start, overview_end = _overview_window(overview)
    query_end = (
        _market_local_datetime(end, vt_symbol, end_of_day=True)
        or overview_end
        or datetime.now()
    )
    query_start = (
        _market_local_datetime(start, vt_symbol)
        or overview_start
        or query_end - timedelta(days=max(normalized_limit * 2, 365))
    )

    rows = await services.database.load_bar_data(
        BarDataQuery(
            vt_symbol=vt_symbol,
            interval=cast(
                Literal["1m", "1h", "d", "w", "tick"],
                normalized_interval,
            ),
            adjust=normalized_adjust,
            start=query_start,
            end=query_end,
        )
    )
    selected_rows = rows[-normalized_limit:]
    items = [
        _bar_item(row, interval=normalized_interval, vt_symbol=vt_symbol)
        for row in selected_rows
    ]
    reference_anchor = None
    if selected_rows:
        anchor_text = date_text(selected_rows[-1].get("datetime"))
        if anchor_text:
            reference_anchor = datetime.fromisoformat(anchor_text)
    reference_close, reference_time = await _load_price_reference(
        services,
        vt_symbol=vt_symbol,
        interval=normalized_interval,
        adjust=normalized_adjust,
        anchor=reference_anchor,
    )
    return {
        "vt_symbol": vt_symbol,
        "interval": normalized_interval,
        "adjust": normalized_adjust,
        "items": items,
        "has_more_before": False,
        "next_before": None,
        "actual_start": items[0]["time"] if items else None,
        "actual_end": items[-1]["time"] if items else None,
        "reference_close": reference_close,
        "reference_time": reference_time,
    }
