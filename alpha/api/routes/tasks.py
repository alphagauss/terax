"""Alpha 后台任务接口。"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.routes._utils import clamp_limit, clamp_offset, date_text, task_status

router = APIRouter()


def _task_response(snapshot: dict[str, object]) -> dict[str, object]:
    """构造任务状态响应。

    Args:
        snapshot: 任务快照。

    Returns:
        前端任务状态。
    """

    metadata = snapshot.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    raw_logs = snapshot.get("logs")
    logs = raw_logs if isinstance(raw_logs, list) else []
    task_id = str(snapshot.get("task_id") or "")
    return {
        "id": task_id,
        "task_id": task_id,
        "status": task_status(snapshot.get("status")),
        "progress": metadata.get("progress"),
        "stage": metadata.get("stage") or snapshot.get("task_type"),
        "message": snapshot.get("error") or (logs[-1] if logs else None),
        "created_at": date_text(snapshot.get("created_at")),
        "started_at": date_text(snapshot.get("created_at")),
        "finished_at": date_text(snapshot.get("finished_at")),
        "backtest_id": metadata.get("instance_name") or task_id,
        "metadata": metadata,
    }


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

    snapshot = services.strategy_manager.get_status_dict().get(task_id)
    if snapshot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    return snapshot


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
    stopped = services.process_manager.stop(task_id)
    if stopped is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前任务无法通过进程管理器取消")
    return _task_response(stopped.snapshot())
