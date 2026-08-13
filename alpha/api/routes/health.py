"""Alpha 健康检查路由。"""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.models import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health(
    request: Request,
    _services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> HealthResponse:
    """返回 Alpha 业务模块健康状态。

    Args:
        request: 当前 FastAPI 请求，用于读取服务实例启动元数据。
        _services: Alpha 业务服务容器，用于确认服务已初始化。

    Returns:
        健康检查响应。
    """

    return HealthResponse(
        status="ok",
        ready=True,
        runtime_revision=os.environ.get(
            "TERAX_ALPHA_RUNTIME_REVISION",
            "dev:unmanaged",
        ),
        started_at=request.app.state.alpha_started_at,
    )
