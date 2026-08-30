"""测试统一 TaskManager 的结果提交、进度事件和终止语义。"""

from __future__ import annotations

from queue import Queue
from time import sleep

import pytest

from alpha.runtime.event import Event, EventEngine
from alpha.runtime.event_types import EVENT_TASK_UPDATED
from alpha.runtime.processes import TaskManager, TaskMessagePublisher, TaskStatus


def _return_value(
    value: int,
    publisher: TaskMessagePublisher | None = None,
) -> dict[str, int]:
    """报告确定进度后返回测试值。"""

    if publisher:
        publisher.log("子进程日志")
        publisher.progress(
            "simulating",
            completed=1,
            total=2,
            unit="bars",
            force=True,
        )
        publisher.progress(
            "simulating",
            completed=2,
            total=2,
            unit="bars",
            force=True,
        )
    return {"value": value}


def _sleep_task(
    seconds: float,
    publisher: TaskMessagePublisher | None = None,
) -> None:
    """用于验证任务停止。"""

    if publisher:
        publisher.stage("waiting")
    sleep(seconds)


def _raise_error(publisher: TaskMessagePublisher | None = None) -> None:
    """用于验证错误终态。"""

    raise RuntimeError("测试错误")


def _finish_after_finalizing(
    publisher: TaskMessagePublisher | None = None,
) -> str:
    """验证确定进度不会被后续不确定阶段清空。"""

    if publisher:
        publisher.progress(
            "simulating",
            completed=10,
            total=10,
            unit="bars",
            metrics={"trade_count": 2},
            force=True,
        )
        publisher.stage("finalizing")
    return "done"


def _runtime() -> tuple[EventEngine, TaskManager, Queue[Event]]:
    """创建已经启动事件分发的任务测试运行时。"""

    engine = EventEngine(interval=60)
    events: Queue[Event] = Queue()
    engine.sub(EVENT_TASK_UPDATED, events.put)
    engine.start()
    return engine, TaskManager(engine), events


def test_task_manager_publishes_progress_and_commits_result_before_success() -> None:
    """结果 handler 成功后才发布 succeeded，进度使用完整任务快照。"""

    engine, manager, events = _runtime()
    committed: list[object] = []
    try:
        manager.start(
            "bt-001",
            "backtest",
            _return_value,
            args=(3,),
            result_handler=committed.append,
        )
        result = manager.wait_result("bt-001")
        task = manager.get("bt-001")

        assert result == {"value": 3}
        assert committed == [result]
        assert task is not None
        assert task.status == TaskStatus.SUCCEEDED
        assert task.progress == {"completed": 2, "total": 2, "unit": "bars"}
        snapshots = []
        while not events.empty():
            snapshots.append(events.get().data)
        assert any(item["stage"] == "simulating" for item in snapshots)
        assert snapshots[-1]["status"] == "succeeded"
        assert snapshots[-1]["revision"] >= 3
    finally:
        manager.close()
        engine.stop()


def test_task_manager_stops_running_task_and_publishes_cancelled() -> None:
    """显式停止会清理子进程并形成 cancelled 终态。"""

    engine, manager, _events = _runtime()
    try:
        manager.start("bt-stop", "backtest", _sleep_task, args=(5.0,))
        task = manager.stop("bt-stop")

        assert task is not None
        assert task.status == TaskStatus.CANCELLED
    finally:
        manager.close()
        engine.stop()


def test_task_manager_routes_child_error_to_waiter() -> None:
    """子进程异常进入 failed 并让等待方得到错误。"""

    engine, manager, _events = _runtime()
    try:
        manager.start("bt-error", "backtest", _raise_error)
        with pytest.raises(RuntimeError, match="测试错误"):
            manager.wait_result("bt-error")

        task = manager.get("bt-error")
        assert task is not None
        assert task.status == TaskStatus.FAILED
    finally:
        manager.close()
        engine.stop()


def test_task_manager_rejects_running_duplicate() -> None:
    """同一 task ID 的运行实例只能存在一个。"""

    engine, manager, _events = _runtime()
    try:
        manager.start("same-id", "backtest", _sleep_task, args=(5.0,))
        with pytest.raises(ValueError):
            manager.start("same-id", "backtest", _sleep_task, args=(5.0,))
        manager.stop("same-id")
    finally:
        manager.close()
        engine.stop()


def test_task_manager_preserves_progress_through_finalizing_stage() -> None:
    """不确定的收尾阶段保留最后确定进度和指标。"""

    engine, manager, _events = _runtime()
    try:
        manager.start("bt-finalizing", "backtest", _finish_after_finalizing)
        assert manager.wait_result("bt-finalizing") == "done"
        task = manager.get("bt-finalizing")

        assert task is not None
        assert task.stage == "finished"
        assert task.progress == {"completed": 10, "total": 10, "unit": "bars"}
        assert task.metrics == {"trade_count": 2}
        assert manager.stop("bt-finalizing") is None
    finally:
        manager.close()
        engine.stop()


def test_task_manager_keeps_revision_monotonic_when_task_id_is_reused() -> None:
    """同一业务 ID 再次执行时 revision 不回退，避免前端误判旧事件。"""

    engine, manager, _events = _runtime()
    try:
        manager.start("repeat", "backtest", _return_value, args=(1,))
        manager.wait_result("repeat")
        first = manager.get("repeat")
        assert first is not None
        first_revision = first.revision

        manager.start("repeat", "backtest", _return_value, args=(2,))
        second_start = manager.get("repeat")
        assert second_start is not None
        assert second_start.revision > first_revision
        assert manager.wait_result("repeat") == {"value": 2}
    finally:
        manager.close()
        engine.stop()


def test_task_manager_rejects_new_tasks_after_close() -> None:
    """关闭后的管理器不会启动无人消费消息的孤儿子进程。"""

    engine, manager, _events = _runtime()
    manager.close()
    try:
        with pytest.raises(RuntimeError, match="已关闭"):
            manager.start("late", "backtest", _return_value, args=(1,))
    finally:
        engine.stop()
