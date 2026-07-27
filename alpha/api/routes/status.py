"""Alpha 工作台状态接口。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.routes._utils import date_text, task_status

router = APIRouter()


def _latest_trade_date(rows: list[dict[str, object]]) -> str | None:
    """从 K 线概览中提取最新交易日期。

    Args:
        rows: K 线概览行。

    Returns:
        最新日期字符串；无数据时返回 ``None``。
    """

    values = [text for row in rows if (text := date_text(row.get("end")))]
    if not values:
        return None
    return max(values)[:10]


@router.get("/status", response_model=dict[str, object])
async def alpha_status(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """返回 Alpha 工作台入口状态。

    Args:
        services: Alpha 业务服务容器。

    Returns:
        Alpha 模块状态、数据库状态和轻量数据摘要。
    """

    try:
        overview = await services.database.get_bar_overview()
        symbols = {
            str(row["vt_symbol"])
            for row in overview
            if row.get("vt_symbol") is not None
        }
        snapshots = services.strategy_manager.get_status_dict()
        running_tasks = sum(
            1
            for snapshot in snapshots.values()
            if task_status(snapshot.get("status")) == "running"
        )
        return {
            "enabled": True,
            "database_ready": True,
            "data_dir": str(services.database.data_dir),
            "latest_trade_date": _latest_trade_date(overview),
            "security_count": len(symbols),
            "running_tasks": running_tasks,
            "message": None,
        }
    except Exception as exc:  # noqa: BLE001 - 状态接口需要把数据库异常转换为可展示状态。
        data_dir = getattr(services.database, "data_dir", None)
        return {
            "enabled": True,
            "database_ready": False,
            "data_dir": None if data_dir is None else str(data_dir),
            "latest_trade_date": None,
            "security_count": 0,
            "running_tasks": 0,
            "message": str(exc),
        }

