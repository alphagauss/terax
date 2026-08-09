"""Alpha 工作台状态接口。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.routes._utils import task_status

router = APIRouter()


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
        overview = await services.data_overview_cache.get(
            services.database.get_data_catalog_overview
        )
        summary = overview["summary"]
        if not isinstance(summary, dict):
            raise TypeError("数据概览摘要格式无效")
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
            "latest_trade_date": (
                None
                if summary.get("data_end") is None
                else str(summary["data_end"])[:10]
            ),
            "security_count": int(summary.get("security_count") or 0),
            "running_tasks": running_tasks,
            "message": None,
        }
    # 状态接口需要把数据库异常转换为可展示状态。
    except Exception as exc:  # noqa: BLE001
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
