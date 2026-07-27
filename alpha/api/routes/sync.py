"""Alpha 同步任务接口路由。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from alpha.api.deps import get_alpha_services
from alpha.api.container import AlphaServiceContainer

router = APIRouter()


def _filter_sync_task_snapshots(
    snapshots: list[dict[str, object]],
) -> list[dict[str, object]]:
    """过滤同步任务快照。

    Args:
        snapshots: 进程任务管理器返回的全部任务快照。

    Returns:
        任务类型以 `sync` 开头的任务快照列表。
    """

    tasks: list[dict[str, object]] = []
    for snapshot in snapshots:
        task_type = snapshot.get("task_type")
        if isinstance(task_type, str) and task_type.startswith("sync"):
            tasks.append(snapshot)
    return tasks


@router.get("/sync/tasks", response_model=list[dict[str, object]])
async def list_sync_tasks(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> list[dict[str, object]]:
    """列出 Alpha 同步任务。

    Args:
        services: Alpha 业务服务容器。

    Returns:
        同步任务快照列表。
    """

    return _filter_sync_task_snapshots(services.process_manager.list_snapshots())
