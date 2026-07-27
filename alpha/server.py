"""Alpha FastAPI 前台服务运行器。

本模块只负责启动单个 Uvicorn 协调进程，进程生命周期由调用方管理。
"""

from __future__ import annotations

import uvicorn

from alpha.api.app import create_app


def run_server(
    *,
    host: str,
    port: int,
    log_level: str,
    token: str | None = None,
) -> None:
    """以前台模式运行 Alpha FastAPI 服务。

    Args:
        host: Uvicorn 监听地址。
        port: Uvicorn 监听端口。
        log_level: Uvicorn 日志级别。
        token: 可选的显式服务凭据；为空时由应用工厂读取运行环境。

    Returns:
        服务停止后返回。
    """

    uvicorn.run(
        create_app(token=token),
        host=host,
        port=port,
        log_level=log_level,
        workers=1,
    )
