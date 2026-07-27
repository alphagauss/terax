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

    def fake_create_app(
        *,
        token: str | None = None,
        shutdown_callback: object = None,
    ) -> object:
        captured_token["value"] = token
        captured["shutdown_callback"] = shutdown_callback
        return fake_app

    monkeypatch.setattr(server_module, "create_app", fake_create_app)

    class FakeConfig:
        """记录 Uvicorn 配置参数。"""

        def __init__(self, app: object, **options: object) -> None:
            captured.update(app=app, **options)

    class FakeServer:
        """记录单进程服务已经运行。"""

        should_exit = False

        def __init__(self, _config: object) -> None:
            captured["server"] = self

        def run(self) -> None:
            captured["ran"] = True

    monkeypatch.setattr(server_module.uvicorn, "Config", FakeConfig)
    monkeypatch.setattr(server_module.uvicorn, "Server", FakeServer)

    server_module.run_server(
        host="127.0.0.1",
        port=11123,
        log_level="debug",
        token="development-token",
    )

    assert captured_token == {"value": "development-token"}
    assert captured["app"] is fake_app
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 11123
    assert captured["log_level"] == "debug"
    assert captured["workers"] == 1
    assert captured["ran"] is True
    callback = captured["shutdown_callback"]
    assert callable(callback)
    callback()
    assert captured["server"].should_exit is True
