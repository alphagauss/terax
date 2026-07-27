"""Alpha API 依赖函数。"""

from __future__ import annotations

from typing import cast

from fastapi import HTTPException, Request, status

from alpha.api.container import AlphaServiceContainer


async def get_alpha_services(request: Request) -> AlphaServiceContainer:
    """获取 Alpha 业务服务容器。

    Args:
        request: FastAPI 请求对象。

    Returns:
        当前应用共享的 Alpha 业务服务容器。

    Raises:
        HTTPException: Alpha 服务容器未初始化。
    """

    container = getattr(request.app.state, "alpha_services", None)
    if container is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Alpha 服务尚未初始化",
        )
    return cast(AlphaServiceContainer, container)
