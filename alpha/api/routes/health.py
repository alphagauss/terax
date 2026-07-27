"""Alpha 健康检查路由。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from alpha.api.deps import get_alpha_services
from alpha.api.models import HealthResponse
from alpha.api.container import AlphaServiceContainer

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health(
    _services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> HealthResponse:
    """返回 Alpha 业务模块健康状态。

    Args:
        _services: Alpha 业务服务容器，用于确认服务已初始化。

    Returns:
        健康检查响应。
    """

    return HealthResponse(status="ok", services_ready=True)
