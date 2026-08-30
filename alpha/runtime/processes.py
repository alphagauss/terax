"""Alpha 有限后台任务和子进程消息管理。

TaskManager 是回测、优化和数据同步共用的唯一任务运行管理器。子进程只通过
TaskMessagePublisher 上报日志、进度、结果或错误，主进程先更新 TaskSnapshot，
再通过 EventEngine 发布 ``task.updated``。
"""

from __future__ import annotations

import math
import traceback
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from multiprocessing import get_context
from multiprocessing.context import BaseContext
from queue import Empty
from threading import Condition, Thread
from time import monotonic

from alpha.runtime.event import Event, EventEngine
from alpha.runtime.event_types import EVENT_TASK_UPDATED

TaskTarget = Callable[..., object]
TaskResultHandler = Callable[[object], None]
PROGRESS_EMIT_INTERVAL_SECONDS = 0.2
PROCESS_EXIT_MESSAGE_GRACE_SECONDS = 1.0
TASK_MESSAGE_QUEUE_CAPACITY = 256
TASK_LOG_CAPACITY = 100


class TaskStatus(str, Enum):
    """有限任务的稳定生命周期状态。"""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


@dataclass
class Task:
    """一个有限后台任务的主进程权威快照。"""

    task_id: str
    kind: str
    process: object
    name: str = ""
    metadata: dict[str, object] = field(default_factory=dict)
    result_handler: TaskResultHandler | None = field(default=None, repr=False)
    status: TaskStatus = TaskStatus.RUNNING
    result: object | None = field(default=None, repr=False)
    result_ready: bool = False
    error: str | None = None
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=TASK_LOG_CAPACITY))
    stage: str | None = None
    progress: dict[str, object] | None = None
    metrics: dict[str, object] = field(default_factory=dict)
    message: str | None = None
    revision: int = 0
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    exit_observed_at: float | None = field(default=None, repr=False)
    committing: bool = field(default=False, repr=False)

    def snapshot(self) -> dict[str, object]:
        """返回 HTTP 和事件协议共用的完整任务快照。"""

        return {
            "id": self.task_id,
            "task_id": self.task_id,
            "kind": self.kind,
            "name": self.name,
            "metadata": self.metadata,
            "status": self.status.value,
            "stage": self.stage,
            "progress": self.progress,
            "metrics": self.metrics,
            "message": self.error or self.message,
            "revision": self.revision,
            "pid": getattr(self.process, "pid", None),
            "exitcode": getattr(self.process, "exitcode", None),
            "error": self.error,
            "logs": list(self.logs)[-20:],
            "created_at": self.created_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


@dataclass
class TaskMessagePublisher:
    """子进程使用的有界任务消息发布器。"""

    task_id: str
    queue: object
    _last_progress_at: float = field(default=0.0, init=False, repr=False)
    _last_stage: str | None = field(default=None, init=False, repr=False)
    _pending_progress: dict[str, object] | None = field(
        default=None,
        init=False,
        repr=False,
    )

    def put(self, kind: str, data: object | None = None) -> None:
        """向父进程任务队列发布一条消息。"""

        self.queue.put({"task_id": self.task_id, "kind": kind, "data": data})

    def log(self, msg: object) -> None:
        """发布一条任务日志。"""

        self.put("log", str(msg))

    def progress(
        self,
        stage: str,
        *,
        completed: int | float | None = None,
        total: int | float | None = None,
        unit: str | None = None,
        metrics: dict[str, object] | None = None,
        message: str | None = None,
        force: bool = False,
    ) -> None:
        """记录最新进度，并最多每 200ms 跨进程发送一次。

        调用方可以逐 bar 调用本方法；节流只影响传输频率，不改变最终计数。
        阶段变化、显式 ``force`` 和完成点立即发送。
        """

        payload: dict[str, object] = {
            "stage": stage,
            "completed": completed,
            "total": total,
            "unit": unit,
            "metrics": metrics or {},
            "message": message,
        }
        stage_changed = self._last_stage != stage
        self._last_stage = stage
        self._pending_progress = payload
        now = monotonic()
        finished = completed is not None and total is not None and completed >= total
        if (
            force
            or finished
            or stage_changed
            or now - self._last_progress_at >= PROGRESS_EMIT_INTERVAL_SECONDS
        ):
            self.flush_progress()

    def stage(self, stage: str, message: str | None = None) -> None:
        """立即发布一个不确定进度阶段。"""

        self.progress(stage, message=message, force=True)

    def flush_progress(self) -> None:
        """立即发送尚未跨进程发布的最新进度。"""

        if self._pending_progress is None:
            return
        self.put("progress", self._pending_progress)
        self._pending_progress = None
        self._last_progress_at = monotonic()

    def result(self, result: object) -> None:
        """先刷新最终进度，再发布任务结果。"""

        self.flush_progress()
        self.put("result", result)

    def error(self, error: str) -> None:
        """先刷新最终进度，再发布任务错误。"""

        self.flush_progress()
        self.put("error", error)


def _run_child(
    task_id: str,
    queue: object,
    target: TaskTarget,
    args: tuple[object, ...],
    kwargs: dict[str, object],
    with_publisher: bool,
) -> None:
    """执行子进程入口并把终态消息刷新到父进程。"""

    publisher = TaskMessagePublisher(task_id, queue)
    try:
        if with_publisher:
            kwargs = {**kwargs, "publisher": publisher}
        publisher.result(target(*args, **kwargs))
    except Exception:
        publisher.error(traceback.format_exc())
        raise


class TaskManager:
    """管理有限子进程任务并发布完整任务快照事件。"""

    def __init__(self, event_engine: EventEngine, stop_timeout: float = 5.0) -> None:
        """创建任务管理器并启动唯一的进程消息消费线程。"""

        self.event_engine = event_engine
        self.stop_timeout = stop_timeout
        self._ctx: BaseContext = get_context("spawn")
        self._queue = self._ctx.Queue(maxsize=TASK_MESSAGE_QUEUE_CAPACITY)
        self._tasks: dict[str, Task] = {}
        self._revisions: dict[str, int] = {}
        self._condition = Condition()
        self._active = True
        self._closed = False
        self._thread = Thread(
            target=self._consume_messages,
            name="alpha-tasks",
            daemon=True,
        )
        self._thread.start()

    def start(
        self,
        task_id: str,
        kind: str,
        target: TaskTarget,
        args: tuple[object, ...] = (),
        kwargs: dict[str, object] | None = None,
        name: str = "",
        metadata: dict[str, object] | None = None,
        with_publisher: bool = True,
        result_handler: TaskResultHandler | None = None,
    ) -> Task:
        """启动任务，并在进程创建成功后发布首个运行快照。"""

        if not task_id or not kind:
            raise ValueError("任务 ID 和类型不能为空")
        with self._condition:
            if self._closed:
                raise RuntimeError("任务管理器已关闭")
        self.cleanup(task_id)
        with self._condition:
            if self._closed:
                raise RuntimeError("任务管理器已关闭")
            if task_id in self._tasks:
                raise ValueError(f"任务仍在运行: {task_id}")
            process = self._ctx.Process(
                target=_run_child,
                args=(task_id, self._queue, target, args, kwargs or {}, with_publisher),
            )
            task = Task(
                task_id=task_id,
                kind=kind,
                process=process,
                name=name,
                metadata=metadata or {},
                result_handler=result_handler,
                stage="starting",
            )
            self._tasks[task_id] = task
            try:
                process.start()
            except Exception:
                self._tasks.pop(task_id, None)
                raise
            self._publish_locked(task)
            self._condition.notify_all()
            return task

    def wait_result(self, task_id: str, timeout: float | None = None) -> object:
        """等待一个任务完成并返回子进程结果。"""

        deadline = None if timeout is None else monotonic() + timeout
        terminal_error: str | None = None
        with self._condition:
            while True:
                task = self._tasks.get(task_id)
                if task is None:
                    raise RuntimeError(f"任务不存在: {task_id}")
                self._refresh_locked(task)
                if task.status == TaskStatus.SUCCEEDED and task.result_ready:
                    result = task.result
                    process = task.process
                    break
                if task.status in {
                    TaskStatus.FAILED,
                    TaskStatus.CANCELLED,
                    TaskStatus.TIMEOUT,
                }:
                    terminal_error = task.error or f"任务未返回结果: {task.snapshot()}"
                    process = task.process
                    break
                if deadline is not None and monotonic() >= deadline:
                    raise TimeoutError(f"等待任务超时: {task_id}")
                self._condition.wait(timeout=0.2)

        process.join()
        if terminal_error is not None:
            raise RuntimeError(terminal_error)
        return result

    def get(self, task_id: str) -> Task | None:
        """读取一个任务的当前权威状态。"""

        with self._condition:
            task = self._tasks.get(task_id)
            if task is not None:
                self._refresh_locked(task)
            return task

    def list_snapshots(self) -> list[dict[str, object]]:
        """返回全部任务的完整快照。"""

        with self._condition:
            for task in self._tasks.values():
                self._refresh_locked(task)
            return [task.snapshot() for task in self._tasks.values()]

    def stop(self, task_id: str, timeout_status: bool = False) -> Task | None:
        """终止一个任务并发布取消或超时终态。"""

        task = self.get(task_id)
        if task is None:
            return None
        if task.status != TaskStatus.RUNNING:
            return None
        if not task.process.is_alive():
            deadline = monotonic() + PROCESS_EXIT_MESSAGE_GRACE_SECONDS
            with self._condition:
                while task.status == TaskStatus.RUNNING:
                    self._refresh_locked(task)
                    if task.status != TaskStatus.RUNNING:
                        return None
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        self._refresh_locked(task)
                        return None
                    self._condition.wait(timeout=min(0.2, remaining))
        if task.process.is_alive():
            task.process.terminate()
            task.process.join(self.stop_timeout)
        if task.process.is_alive():
            task.process.kill()
            task.process.join()
        with self._condition:
            if task.status != TaskStatus.RUNNING:
                return None
            task.status = TaskStatus.TIMEOUT if timeout_status else TaskStatus.CANCELLED
            task.stage = "finished"
            task.finished_at = task.finished_at or datetime.now(timezone.utc)
            self._publish_locked(task)
            self._condition.notify_all()
            return task

    def mark_error(self, task_id: str, error: str) -> None:
        """把任务标记为失败并发布终态。"""

        with self._condition:
            task = self._tasks.get(task_id)
            if task is None or task.status != TaskStatus.RUNNING:
                return
            task.error = error
            task.status = TaskStatus.FAILED
            task.stage = "finished"
            task.finished_at = task.finished_at or datetime.now(timezone.utc)
            self._publish_locked(task)
            self._condition.notify_all()

    def cleanup(self, task_id: str) -> None:
        """删除一个已经结束的任务运行态。"""

        task = self.get(task_id)
        if task is None or task.process.is_alive():
            return
        with self._condition:
            self._tasks.pop(task_id, None)

    def close(self, stop_running: bool = False) -> None:
        """停止消息线程，可选终止仍在运行的全部任务。"""

        with self._condition:
            if self._closed:
                return
            if not stop_running and any(
                task.status == TaskStatus.RUNNING for task in self._tasks.values()
            ):
                raise RuntimeError("仍有运行任务，关闭时必须显式终止")
            self._closed = True
        if stop_running:
            for task_id in list(self._tasks):
                self.stop(task_id)
        self._active = False
        self._thread.join()

    def _consume_messages(self) -> None:
        """消费子进程消息，并定期发现无消息异常退出。"""

        while self._active:
            try:
                message = self._queue.get(timeout=0.2)
            except Empty:
                self._refresh_all()
                continue
            except (EOFError, OSError):
                break
            self._handle_message(message)

    def _handle_message(self, message: object) -> None:
        """验证并应用一条子进程消息。"""

        if not isinstance(message, dict):
            return
        task_id = str(message.get("task_id", ""))
        kind = str(message.get("kind", ""))
        data = message.get("data")
        if kind == "result":
            self._handle_result(task_id, data)
            return

        with self._condition:
            task = self._tasks.get(task_id)
            if task is None or task.status != TaskStatus.RUNNING:
                return
            if kind == "log":
                task.logs.append(str(data or ""))
                task.message = str(data or "")
            elif kind == "progress":
                try:
                    self._apply_progress(task, data)
                except ValueError as exc:
                    task.error = str(exc)
                    task.status = TaskStatus.FAILED
                    task.stage = "finished"
                    task.finished_at = datetime.now(timezone.utc)
                self._publish_locked(task)
            elif kind == "error":
                task.error = str(data or "子进程执行失败")
                task.status = TaskStatus.FAILED
                task.stage = "finished"
                task.finished_at = datetime.now(timezone.utc)
                self._publish_locked(task)
            self._condition.notify_all()

    def _handle_result(self, task_id: str, result: object) -> None:
        """先执行领域结果提交，再发布成功终态。"""

        with self._condition:
            task = self._tasks.get(task_id)
            if task is None or task.status != TaskStatus.RUNNING:
                return
            result_handler = task.result_handler
            task.committing = True

        try:
            if result_handler is not None:
                result_handler(result)
        except Exception:
            with self._condition:
                task = self._tasks.get(task_id)
                if task is not None:
                    task.committing = False
            self.mark_error(task_id, traceback.format_exc())
            return

        with self._condition:
            task = self._tasks.get(task_id)
            if task is None:
                return
            task.committing = False
            if task.status != TaskStatus.RUNNING:
                self._condition.notify_all()
                return
            task.result = result
            task.result_ready = True
            task.status = TaskStatus.SUCCEEDED
            task.stage = "finished"
            task.progress = self._completed_progress(task.progress)
            task.finished_at = datetime.now(timezone.utc)
            self._publish_locked(task)
            self._condition.notify_all()

    def _apply_progress(self, task: Task, data: object) -> None:
        """把经过约束的子进程进度应用到任务快照。"""

        if not isinstance(data, dict):
            raise ValueError("任务进度必须是对象")
        stage = str(data.get("stage") or "").strip()
        if not stage or len(stage) > 64:
            raise ValueError("任务进度阶段非法")
        completed = self._progress_number(data.get("completed"), "completed")
        total = self._progress_number(data.get("total"), "total")
        if completed is not None and total is not None and completed > total:
            raise ValueError("任务进度 completed 不能超过 total")
        unit_value = data.get("unit")
        unit = None if unit_value is None else str(unit_value).strip()
        metrics = data.get("metrics")
        if not isinstance(metrics, dict):
            metrics = {}
        task.stage = stage
        # 仅阶段变化不应清空上一阶段的确定进度和指标，终态仍可展示 100%。
        if completed is not None or total is not None:
            task.progress = {"completed": completed, "total": total, "unit": unit}
        if metrics:
            task.metrics = dict(metrics)
        message = data.get("message")
        if message is not None:
            task.message = str(message)

    @staticmethod
    def _progress_number(value: object, name: str) -> int | float | None:
        """校验非负有限进度数值。"""

        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"任务进度 {name} 必须是数字")
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"任务进度 {name} 必须是非负有限值")
        return value

    @staticmethod
    def _completed_progress(
        progress: dict[str, object] | None,
    ) -> dict[str, object] | None:
        """让已知总量的成功任务精确落在完成点。"""

        if progress is None or progress.get("total") is None:
            return progress
        return {**progress, "completed": progress["total"]}

    def _refresh_all(self) -> None:
        """发现没有正常终态消息的异常退出进程。"""

        with self._condition:
            for task in self._tasks.values():
                self._refresh_locked(task)

    def _refresh_locked(self, task: Task) -> None:
        """在消息宽限期后把无终态消息的退出进程标记为失败。"""

        if (
            task.status != TaskStatus.RUNNING
            or task.process.is_alive()
            or task.committing
        ):
            task.exit_observed_at = None
            return
        now = monotonic()
        if task.exit_observed_at is None:
            task.exit_observed_at = now
            return
        if now - task.exit_observed_at < PROCESS_EXIT_MESSAGE_GRACE_SECONDS:
            return
        task.error = f"任务进程退出但没有返回终态消息，exitcode={task.process.exitcode}"
        task.status = TaskStatus.FAILED
        task.stage = "finished"
        task.finished_at = datetime.now(timezone.utc)
        self._publish_locked(task)
        self._condition.notify_all()

    def _publish_locked(self, task: Task) -> None:
        """递增 revision，并把完整快照放入 EventEngine。"""

        task.revision = self._revisions.get(task.task_id, 0) + 1
        self._revisions[task.task_id] = task.revision
        self.event_engine.put(
            Event(
                type=EVENT_TASK_UPDATED,
                key=task.task_id,
                revision=task.revision,
                data=task.snapshot(),
            )
        )
