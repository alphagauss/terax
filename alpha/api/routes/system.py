"""Alpha 服务级控制路由。

这里只提供 Terax 进程之间共享的优雅停止入口，不承载量化业务控制。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import cast

from fastapi import APIRouter, HTTPException, Request, status

from alpha.api.models import ShutdownResponse

router = APIRouter(prefix="/system")


@router.post(
    "/shutdown",
    response_model=ShutdownResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def shutdown(request: Request) -> ShutdownResponse:
    """请求当前 Uvicorn 协调进程在本次响应完成后退出。

    Args:
        request: 用于取得服务运行器注入的停止回调。

    Returns:
        已接受停止请求的响应。

    Raises:
        HTTPException: 当前应用不是由受管 Alpha 运行器启动。
    """

    callback = getattr(request.app.state, "alpha_shutdown", None)
    if not callable(callback):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Alpha shutdown control is unavailable",
        )
    cast(Callable[[], None], callback)()
    return ShutdownResponse()
