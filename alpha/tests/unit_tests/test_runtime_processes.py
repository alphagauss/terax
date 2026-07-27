from __future__ import annotations

from time import sleep

import pytest

from alpha.runtime.processes import (
    ProcessMessagePublisher,
    ProcessTaskManager,
    TaskStatus,
)


def _return_value(
    value: int,
    publisher: ProcessMessagePublisher | None = None,
) -> dict[str, int]:
    """返回测试值并发送日志。"""

    if publisher:
        publisher.log("子进程日志")
    return {"value": value}


def _sleep_task(
    seconds: float,
    publisher: ProcessMessagePublisher | None = None,
) -> None:
    """用于验证停止任务。"""

    if publisher:
        publisher.log("开始休眠")
    sleep(seconds)


def _raise_error(publisher: ProcessMessagePublisher | None = None) -> None:
    """用于验证错误回传。"""

    raise RuntimeError("测试错误")


def test_process_task_manager_should_route_shared_queue_result() -> None:
    """验证共享队列可将子进程结果路由回任务。"""

    manager = ProcessTaskManager()
    manager.start("bt-001", "backtest", _return_value, args=(3,))

    result = manager.wait_result("bt-001")
    task = manager.get("bt-001")

    assert result == {"value": 3}
    assert task is not None
    assert task.status == TaskStatus.SUCCEEDED
    assert task.logs == ["子进程日志"]
    manager.close()


def test_process_task_manager_should_stop_running_task() -> None:
    """验证可停止正在运行的任务。"""

    manager = ProcessTaskManager(stop_timeout=0.1)
    manager.start("bt-stop", "backtest", _sleep_task, args=(5.0,))

    task = manager.stop("bt-stop")

    assert task is not None
    assert task.status == TaskStatus.CANCELLED
    manager.close()


def test_process_task_manager_should_raise_child_error() -> None:
    """验证子进程错误会回传给等待方。"""

    manager = ProcessTaskManager()
    manager.start("bt-error", "backtest", _raise_error)

    with pytest.raises(RuntimeError, match="测试错误"):
        manager.wait_result("bt-error")

    task = manager.get("bt-error")
    assert task is not None
    assert task.status == TaskStatus.FAILED
    manager.close()


def test_process_task_manager_should_reject_running_duplicate() -> None:
    """验证运行中的同名任务会被拒绝。"""

    manager = ProcessTaskManager()
    manager.start("same-id", "backtest", _sleep_task, args=(5.0,))

    with pytest.raises(ValueError):
        manager.start("same-id", "backtest", _sleep_task, args=(5.0,))

    manager.stop("same-id")
    manager.close()
