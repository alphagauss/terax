"""Alpha 同步任务接口路由。"""

from __future__ import annotations

from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.models import (
    SyncBarsRequest,
    SyncOverviewResponse,
    SyncStartResponse,
)
from alpha.api.routes._utils import task_status
from alpha.sync_tasks.jobs import run_bar_sync_job
from alpha.sync_tasks.reporting import load_quality_snapshot

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


def _sync_task_summary(snapshot: dict[str, object]) -> dict[str, object]:
    """把内部任务快照裁剪为数据页所需字段。"""
    return {
        "task_id": str(snapshot.get("task_id") or ""),
        "status": task_status(snapshot.get("status")),
        "created_at": snapshot.get("created_at"),
        "finished_at": snapshot.get("finished_at"),
        "message": snapshot.get("error"),
    }


@router.get("/sync/overview", response_model=SyncOverviewResponse)
async def sync_overview(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """返回轻量同步状态和最近一次持久化质量快照。"""
    snapshots = _filter_sync_task_snapshots(services.process_manager.list_snapshots())
    return {
        "tasks": [_sync_task_summary(snapshot) for snapshot in snapshots],
        "latest": load_quality_snapshot(),
    }


@router.post("/sync/bars", response_model=SyncStartResponse)
async def start_bar_sync(
    request: SyncBarsRequest,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """启动一个全量增量或定向异常标的日线同步任务。"""
    running = any(
        snapshot.get("task_type") == "sync-bars" and snapshot.get("status") == "running"
        for snapshot in services.process_manager.list_snapshots()
    )
    if running:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "日线同步任务正在运行",
        )

    task_id = f"sync-bars-{uuid4()}"
    try:
        services.process_manager.start(
            task_id,
            "sync-bars",
            run_bar_sync_job,
            args=(request.vt_symbols,),
            name="日线增量同步",
            metadata={
                "targeted": request.vt_symbols is not None,
                "symbol_count": len(request.vt_symbols or []),
            },
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return {"task_id": task_id, "status": "running"}
