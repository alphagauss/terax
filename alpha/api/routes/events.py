"""Alpha 双向 WebSocket 通路。

当前只锁定鉴权和双向 JSON 基础协议，不订阅或暴露内部事件总线。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from alpha.api.auth import require_alpha_websocket_token

router = APIRouter()


@router.websocket("/events")
async def events(websocket: WebSocket) -> None:
    """建立受认证的 Alpha 双向事件连接。

    当前客户端消息只定义 ping，其他 JSON 消息返回协议错误；后续按公共事件协议
    增加显式订阅，不直接转发内部 EventEngine 的全部事件。

    Args:
        websocket: 当前 WebSocket 连接。
    """

    await require_alpha_websocket_token(websocket)
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {"type": "error", "message": "WebSocket 消息必须是 JSON"}
                )
                continue
            if message == {"type": "ping"}:
                await websocket.send_json({"type": "pong"})
                continue
            await websocket.send_json(
                {"type": "error", "message": "不支持的客户端消息"}
            )
    except WebSocketDisconnect:
        pass
