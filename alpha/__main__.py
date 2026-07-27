"""Alpha 模块命令入口。

负责解析 FastAPI 监听参数并以前台模式启动服务，不管理后台进程或业务命令。
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from alpha.server import run_server


def _parse_port(value: str) -> int:
    """解析并校验 TCP 端口。

    Args:
        value: 命令行传入的端口字符串。

    Returns:
        有效的 TCP 端口。

    Raises:
        argparse.ArgumentTypeError: 端口不是整数或超出有效范围。
    """

    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("端口必须是整数") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须位于 1 到 65535 之间")
    return port


def _build_parser() -> argparse.ArgumentParser:
    """创建 Alpha 服务命令行解析器。

    Returns:
        已配置监听地址、端口和日志级别的解析器。
    """

    parser = argparse.ArgumentParser(description="启动 Alpha 量化后端")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="FastAPI 监听地址，默认仅监听本机",
    )
    parser.add_argument(
        "--port",
        type=_parse_port,
        default=8701,
        help="FastAPI 监听端口",
    )
    parser.add_argument(
        "--log-level",
        type=str.lower,
        choices=("critical", "error", "warning", "info", "debug", "trace"),
        default="info",
        help="Uvicorn 日志级别",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """解析参数并启动 Alpha 服务。

    Args:
        argv: 可选参数序列；为空时读取当前进程命令行。

    Returns:
        无返回值。
    """

    args = _build_parser().parse_args(list(argv) if argv is not None else None)
    run_server(
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()
