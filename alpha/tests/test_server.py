"""测试 Alpha Uvicorn 运行器保持单进程前台启动语义。"""

from __future__ import annotations

import pytest

import alpha.server as server_module


def test_run_server_starts_single_uvicorn_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证服务运行器使用应用工厂结果启动单个 Uvicorn 进程。"""

    fake_app = object()
    captured: dict[str, object] = {}

    captured_token: dict[str, str | None] = {}

    def fake_create_app(*, token: str | None = None) -> object:
        captured_token["value"] = token
        return fake_app

    monkeypatch.setattr(server_module, "create_app", fake_create_app)

    def fake_uvicorn_run(app: object, **options: object) -> None:
        captured.update(app=app, **options)

    monkeypatch.setattr(server_module.uvicorn, "run", fake_uvicorn_run)

    server_module.run_server(
        host="127.0.0.1",
        port=8701,
        log_level="debug",
        token="development-token",
    )

    assert captured_token == {"value": "development-token"}
    assert captured == {
        "app": fake_app,
        "host": "127.0.0.1",
        "port": 8701,
        "log_level": "debug",
        "workers": 1,
    }
