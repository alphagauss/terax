"""测试 Alpha 模块入口的参数解析和服务转发。"""

from __future__ import annotations

import pytest

import alpha.__main__ as main_module


def test_main_uses_safe_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """验证模块入口默认只监听本机并以前台模式启动。"""

    captured: dict[str, object] = {}

    def fake_run_server(
        *,
        host: str,
        port: int,
        log_level: str,
        token: str | None,
    ) -> None:
        captured.update(host=host, port=port, log_level=log_level, token=token)

    monkeypatch.setattr(main_module, "run_server", fake_run_server)

    main_module.main([])

    assert captured == {
        "host": "127.0.0.1",
        "port": 8701,
        "log_level": "info",
        "token": None,
    }


def test_main_forwards_explicit_options(monkeypatch: pytest.MonkeyPatch) -> None:
    """验证模块入口把显式监听参数转交给服务运行器。"""

    captured: dict[str, object] = {}

    def fake_run_server(
        *,
        host: str,
        port: int,
        log_level: str,
        token: str | None,
    ) -> None:
        captured.update(host=host, port=port, log_level=log_level, token=token)

    monkeypatch.setattr(main_module, "run_server", fake_run_server)

    main_module.main(
        [
            "--host",
            "127.0.0.2",
            "--port",
            "9988",
            "--log-level",
            "DEBUG",
            "--token",
            "development-token",
        ]
    )

    assert captured == {
        "host": "127.0.0.2",
        "port": 9988,
        "log_level": "debug",
        "token": "development-token",
    }


def test_main_accepts_short_token_option(monkeypatch: pytest.MonkeyPatch) -> None:
    """验证开发调试可以通过短参数传入服务凭据。"""

    captured: dict[str, object] = {}

    def fake_run_server(
        *,
        host: str,
        port: int,
        log_level: str,
        token: str | None,
    ) -> None:
        captured.update(token=token)

    monkeypatch.setattr(main_module, "run_server", fake_run_server)

    main_module.main(["-t", "dev"])

    assert captured["token"] == "dev"
