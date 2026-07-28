"""Alpha API 服务凭据验证。

只验证 Rust 代理或测试客户端提供的 Bearer 凭据，领域权限仍由各业务路由负责。
"""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import (
    HTTPException,
    Request,
    Security,
    WebSocket,
    WebSocketException,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_BEARER = HTTPBearer(auto_error=False)


def _valid_bearer(value: str | None, expected: str) -> bool:
    """验证原始 Authorization 请求头。

    Args:
        value: Authorization 请求头。
        expected: 应用持有的服务凭据。

    Returns:
        请求头包含匹配的 Bearer 凭据时返回 True。
    """

    if value is None:
        return False
    scheme, separator, credentials = value.partition(" ")
    return (
        separator == " "
        and scheme.lower() == "bearer"
        and bool(credentials)
        and secrets.compare_digest(credentials, expected)
    )


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


async def require_alpha_websocket_token(websocket: WebSocket) -> None:
    """验证 WebSocket 握手携带的 Alpha Bearer 凭据。

    Args:
        websocket: 尚未接受的 WebSocket 连接。

    Raises:
        WebSocketException: 缺少凭据或凭据不匹配。
    """

    expected = websocket.app.state.alpha_token
    if not _valid_bearer(websocket.headers.get("authorization"), expected):
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Alpha 服务凭据无效",
        )
