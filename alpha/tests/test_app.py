"""测试 Alpha FastAPI 应用组装、鉴权和生命周期边界。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import alpha.api.app as app_module
from alpha.config import AlphaConfig


@dataclass
class FakeContainer:
    """记录关闭状态的最小服务容器替身。"""

    closed: bool = False

    async def close(self) -> None:
        """记录应用生命周期已经关闭容器。"""

        self.closed = True


def _stub_container(
    monkeypatch: pytest.MonkeyPatch,
    container: FakeContainer,
) -> None:
    """让应用生命周期使用固定配置和测试容器。"""

    monkeypatch.setattr(
        app_module,
        "create_alpha_service_container",
        lambda _config: container,
    )
    monkeypatch.setattr(
        app_module,
        "load_config",
        lambda: AlphaConfig(data_dir=Path.cwd()),
    )


def test_create_app_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """验证未配置服务凭据时拒绝创建应用。"""

    monkeypatch.delenv("TERAX_ALPHA_TOKEN", raising=False)

    with pytest.raises(RuntimeError, match="TERAX_ALPHA_TOKEN"):
        app_module.create_app()


def test_app_mounts_router_and_closes_container(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证应用挂载受保护路由并在退出时关闭同一容器。"""

    container = FakeContainer()
    _stub_container(monkeypatch, container)
    app = app_module.create_app(token="test-token")

    with TestClient(app) as client:
        assert app.state.alpha_services is container
        missing = client.get("/api/alpha/health")
        invalid = client.get(
            "/api/alpha/health",
            headers={"Authorization": "Bearer wrong-token"},
        )
        valid = client.get(
            "/api/alpha/health",
            headers={"Authorization": "Bearer test-token"},
        )
        repeated = client.get(
            "/api/alpha/health",
            headers={"Authorization": "Bearer test-token"},
        )

    assert missing.status_code == 401
    assert invalid.status_code == 401
    assert valid.status_code == 200
    body = valid.json()
    started_at = body.pop("started_at")
    assert body == {
        "status": "ok",
        "ready": True,
        "service": "terax-alpha",
        "protocol_version": 2,
        "runtime_revision": "dev:unmanaged",
    }
    parsed_started_at = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    assert parsed_started_at.tzinfo is not None
    assert repeated.json()["started_at"] == started_at
    assert container.closed is True


def test_create_app_reads_token_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证应用默认从运行环境读取服务凭据。"""

    container = FakeContainer()
    monkeypatch.setenv("TERAX_ALPHA_TOKEN", "environment-token")
    _stub_container(monkeypatch, container)
    app = app_module.create_app()

    with TestClient(app) as client:
        response = client.get(
            "/api/alpha/health",
            headers={"Authorization": "Bearer environment-token"},
        )

    assert response.status_code == 200


def test_shutdown_route_calls_managed_server_callback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证任意受认证客户端都能请求当前共享服务优雅退出。"""

    container = FakeContainer()
    shutdown_requested: list[bool] = []
    _stub_container(monkeypatch, container)
    app = app_module.create_app(
        token="test-token",
        shutdown_callback=lambda: shutdown_requested.append(True),
    )

    with TestClient(app) as client:
        unauthorized = client.post("/api/alpha/system/shutdown")
        assert shutdown_requested == []
        response = client.post(
            "/api/alpha/system/shutdown",
            headers={"Authorization": "Bearer test-token"},
        )

    assert unauthorized.status_code == 401
    assert response.status_code == 202
    assert response.json() == {"status": "stopping"}
    assert shutdown_requested == [True]


def test_websocket_requires_token_and_supports_bidirectional_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证事件 WebSocket 独立鉴权并支持客户端发送 JSON。"""

    container = FakeContainer()
    _stub_container(monkeypatch, container)
    app = app_module.create_app(token="test-token")

    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/alpha/events"):
                pass

        with client.websocket_connect(
            "/api/alpha/events",
            headers={"Authorization": "Bearer test-token"},
        ) as websocket:
            websocket.send_json({"type": "ping"})
            assert websocket.receive_json() == {"type": "pong"}
