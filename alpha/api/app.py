"""Alpha FastAPI 应用组装。

负责挂载量化业务路由、注入共享运行容器并在应用退出时释放资源。
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI

from alpha.api.auth import require_alpha_token
from alpha.api.container import create_alpha_service_container
from alpha.api.router import router
from alpha.api.routes import events
from alpha.config import load_config

ALPHA_TOKEN_ENV = "TERAX_ALPHA_TOKEN"


def _resolve_token(token: str | None) -> str:
    """解析 Alpha 服务使用的访问凭据。

    Args:
        token: 调用方显式注入的凭据；为空时读取运行环境。

    Returns:
        非空访问凭据。

    Raises:
        RuntimeError: 未提供有效凭据。
    """

    resolved = token if token is not None else os.environ.get(ALPHA_TOKEN_ENV)
    if not resolved:
        raise RuntimeError(f"必须通过 {ALPHA_TOKEN_ENV} 配置 Alpha 服务凭据")
    return resolved


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """管理 Alpha 共享运行对象的完整生命周期。

    Args:
        app: 当前 FastAPI 应用。

    Yields:
        应用运行阶段的控制权。
    """

    container = create_alpha_service_container(load_config())
    app.state.alpha_services = container
    app.state.alpha_started_at = datetime.now(timezone.utc)
    await container.start()
    try:
        yield
    finally:
        await container.close()


def create_app(
    *,
    token: str | None = None,
    shutdown_callback: Callable[[], None] | None = None,
) -> FastAPI:
    """创建受 Bearer 凭据保护的 Alpha FastAPI 应用。

    Args:
        token: 测试或受管调用方显式注入的凭据；默认读取运行环境。
        shutdown_callback: Uvicorn 运行器提供的优雅停止回调。

    Returns:
        已挂载 `/api/alpha` 业务路由的 FastAPI 应用。
    """

    app = FastAPI(
        title="Terax Alpha",
        lifespan=_lifespan,
    )
    app.state.alpha_token = _resolve_token(token)
    app.state.alpha_shutdown = shutdown_callback
    app.include_router(
        router,
        prefix="/api/alpha",
        dependencies=[Depends(require_alpha_token)],
    )
    app.include_router(events.router, prefix="/api/alpha")
    return app
