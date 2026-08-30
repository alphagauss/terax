"""Alpha 统一公共事件 WebSocket 路由。"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, WebSocket

from alpha.api.auth import require_alpha_websocket_token
from alpha.api.container import AlphaServiceContainer

router = APIRouter()


@router.websocket("/events")
async def events(websocket: WebSocket) -> None:
    """认证连接后把协议处理交给统一 WebSocketEventGateway。"""

    await require_alpha_websocket_token(websocket)
    await websocket.accept()
    services = cast(AlphaServiceContainer, websocket.app.state.alpha_services)
    await services.event_gateway.serve(websocket)
