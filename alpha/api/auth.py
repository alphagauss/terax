"""Alpha API 服务凭据验证。

只验证 Rust 代理或测试客户端提供的 Bearer 凭据，领域权限仍由各业务路由负责。
"""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_BEARER = HTTPBearer(auto_error=False)


async def require_alpha_token(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(_BEARER),
    ],
) -> None:
    """验证请求携带的 Alpha Bearer 凭据。

    Args:
        request: 当前 FastAPI 请求，用于读取应用持有的服务凭据。
        credentials: HTTP Bearer 认证信息。

    Returns:
        验证通过时无返回值。

    Raises:
        HTTPException: 缺少凭据或凭据不匹配。
    """

    expected = request.app.state.alpha_token
    valid = (
        credentials is not None
        and credentials.scheme.lower() == "bearer"
        and secrets.compare_digest(credentials.credentials, expected)
    )
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Alpha 服务凭据无效",
            headers={"WWW-Authenticate": "Bearer"},
        )
