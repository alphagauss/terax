"""Alpha 后台任务接口。"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.routes._utils import clamp_limit, clamp_offset

router = APIRouter()


def _task_response(snapshot: dict[str, object]) -> dict[str, object]:
    """返回 EventEngine 和 HTTP 共用的完整任务快照。

    Args:
        snapshot: 任务快照。

    Returns:
        前端任务状态。
    """

    return dict(snapshot)


def _find_task(
    services: AlphaServiceContainer,
    task_id: str,
) -> dict[str, object]:
    """查找任务快照。

    Args:
        services: Alpha 业务服务容器。
        task_id: 任务标识。

    Returns:
        任务快照。

    Raises:
        HTTPException: 任务不存在。
    """

    task = services.task_manager.get(task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    return task.snapshot()


@router.get("/tasks", response_model=list[dict[str, object]])
async def list_tasks(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> list[dict[str, object]]:
    """返回运行时保留的有界任务快照，供面板打开及重连后恢复。"""
    return services.task_manager.list_snapshots()


@router.get("/tasks/{task_id}", response_model=dict[str, object])
async def get_task(
    task_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取任务状态。

    Args:
        task_id: 任务标识。
        services: Alpha 业务服务容器。

    Returns:
        任务状态响应。
    """

    return _task_response(_find_task(services, task_id))


@router.get("/tasks/{task_id}/logs", response_model=dict[str, object])
async def get_task_logs(
    task_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    limit: int = 100,
    offset: int = 0,
    level: str | None = None,
) -> dict[str, object]:
    """读取任务日志。

    Args:
        task_id: 任务标识。
        services: Alpha 业务服务容器。
        limit: 页大小。
        offset: 偏移量。
        level: 日志级别过滤，第一版仅保留参数位置。

    Returns:
        日志分页响应。
    """

    snapshot = _find_task(services, task_id)
    raw_logs = snapshot.get("logs")
    logs = raw_logs if isinstance(raw_logs, list) else []
    items = [
        {
            "time": datetime.now().isoformat(),
            "level": level or "info",
            "message": str(message),
        }
        for message in logs
    ]
    normalized_limit = clamp_limit(limit, default=100)
    normalized_offset = clamp_offset(offset)
    return {
        "items": items[normalized_offset : normalized_offset + normalized_limit],
        "total": len(items),
    }


@router.post("/tasks/{task_id}/cancel", response_model=dict[str, object])
async def cancel_task(
    task_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """取消运行中的进程任务。

    Args:
        task_id: 任务标识。
        services: Alpha 业务服务容器。

    Returns:
        取消后的任务状态。

    Raises:
        HTTPException: 任务不存在或无法取消。
    """

    _find_task(services, task_id)
    # 进程终止可能等待数秒，不能阻塞 FastAPI 事件循环和其他事件订阅。
    stopped = await asyncio.to_thread(services.task_manager.stop, task_id)
    if stopped is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前任务无法通过进程管理器取消")
    return _task_response(stopped.snapshot())
