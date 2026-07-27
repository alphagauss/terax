import asyncio
from typing import Callable

from loguru import logger

from alpha.utils import log_execution_time, suppress_execution_time_logging


def _capture_log_messages(run: Callable[[], object]) -> list[str]:
    """捕获执行期间输出的日志消息。"""
    messages: list[str] = []
    handler_id = logger.add(lambda message: messages.append(str(message).strip()), level="INFO")
    try:
        run()
    finally:
        logger.remove(handler_id)
    return messages


def test_suppress_execution_time_logging_hides_sync_decorator_logs() -> None:
    """验证上下文管理器可临时关闭同步耗时日志。"""

    @log_execution_time()
    def sample() -> str:
        return "ok"

    normal_messages = _capture_log_messages(sample)
    suppressed_messages = _capture_log_messages(lambda: _run_with_suppressed_logging(sample))

    assert any("耗时" in message for message in normal_messages)
    assert all("耗时" not in message for message in suppressed_messages)


def test_suppress_execution_time_logging_hides_async_decorator_logs() -> None:
    """验证上下文管理器可临时关闭异步耗时日志。"""

    @log_execution_time()
    async def sample() -> str:
        return "ok"

    normal_messages = _capture_log_messages(lambda: asyncio.run(sample()))
    suppressed_messages = _capture_log_messages(
        lambda: _run_with_suppressed_logging(lambda: asyncio.run(sample()))
    )

    assert any("耗时" in message for message in normal_messages)
    assert all("耗时" not in message for message in suppressed_messages)


def _run_with_suppressed_logging(run: Callable[[], object]) -> object:
    """在关闭耗时日志的上下文中执行回调。"""
    with suppress_execution_time_logging():
        return run()
