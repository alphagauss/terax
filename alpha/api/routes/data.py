"""Alpha 数据接口路由。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from alpha.api.deps import get_alpha_services
from alpha.api.models import DataOverviewResponse
from alpha.api.container import AlphaServiceContainer

router = APIRouter()


def _build_data_overview(rows: list[dict[str, object]]) -> dict[str, object]:
    """构建行情数据概览响应。

    Args:
        rows: `DataBase.get_bar_overview()` 返回的 K 线概览行。

    Returns:
        包含 K 线总行数和原始概览行的响应字典。
    """

    total_bar_count = 0
    bars: dict[str, dict[str, object]] = {}

    # 汇总各标的与周期的 K 线条数，字段来自 storage.bar_overview。
    for row in rows:
        count = row.get("count", 0)
        if isinstance(count, int):
            total_bar_count += count
        elif isinstance(count, float):
            total_bar_count += int(count)

        interval = str(row.get("interval") or "")
        if not interval:
            continue

        current = bars.setdefault(
            interval,
            {
                "symbols": 0,
                "rows": 0,
                "start_date": None,
                "end_date": None,
            },
        )
        current["symbols"] = int(current["symbols"]) + 1
        current["rows"] = int(current["rows"]) + int(count or 0)

        start = row.get("start")
        if start is not None:
            start_text = str(start)[:10]
            if current["start_date"] is None or start_text < str(current["start_date"]):
                current["start_date"] = start_text

        end = row.get("end")
        if end is not None:
            end_text = str(end)[:10]
            if current["end_date"] is None or end_text > str(current["end_date"]):
                current["end_date"] = end_text

    return {
        "total_bar_count": total_bar_count,
        "bar_overview": rows,
        "bars": bars,
        "security_profile": {
            "count": len({str(row.get("vt_symbol")) for row in rows if row.get("vt_symbol")}),
            "latest_updated_at": max(
                (str(row.get("updated_at")) for row in rows if row.get("updated_at")),
                default=None,
            ),
        },
        "index_constituents": {
            "index_count": 0,
            "latest_date": None,
        },
    }


@router.get("/data/overview", response_model=DataOverviewResponse)
async def data_overview(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """返回行情数据概览。

    Args:
        services: Alpha 业务服务容器。

    Returns:
        行情数据概览。
    """

    rows = await services.database.get_bar_overview()
    return _build_data_overview(rows)
