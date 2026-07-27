from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from multiprocessing import get_context
from multiprocessing.context import BaseContext
from queue import Empty
from threading import Condition, Thread
from typing import Callable


ProcessTarget = Callable[..., object]


class TaskStatus(str, Enum):
    """进程任务状态。"""

    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


@dataclass
class ProcessTask:
    """进程任务运行态。"""

    task_id: str
    task_type: str
    process: object
    name: str = ""
    metadata: dict[str, object] = field(default_factory=dict)
    status: TaskStatus = TaskStatus.RUNNING
    result: object | None = None
    result_ready: bool = False
    error: str | None = None
    logs: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    finished_at: datetime | None = None

    def snapshot(self) -> dict[str, object]:
        """返回接口展示所需的任务快照。

        Returns:
            任务运行态字典。
        """

        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "name": self.name,
            "metadata": self.metadata,
            "status": self.status.value,
            "pid": getattr(self.process, "pid", None),
            "exitcode": getattr(self.process, "exitcode", None),
            "error": self.error,
            "logs": self.logs[-20:],
            "created_at": self.created_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


@dataclass(frozen=True)
class ProcessMessagePublisher:
    """子进程消息发布器。"""

    task_id: str
    queue: object

    def put(self, kind: str, data: object | None = None) -> None:
        """发布一条任务消息。

        Args:
            kind: 消息类型。
            data: 消息数据。
        """

        self.queue.put({"task_id": self.task_id, "kind": kind, "data": data})

    def log(self, msg: object) -> None:
        """发布日志消息。"""

        self.put("log", str(msg))

    def result(self, result: object) -> None:
        """发布结果消息。"""

        self.put("result", result)

    def error(self, error: str) -> None:
        """发布错误消息。"""

        self.put("error", error)


def _run_child(
    task_id: str,
    queue: object,
    target: ProcessTarget,
    args: tuple[object, ...],
    kwargs: dict[str, object],
    with_publisher: bool,
) -> None:
    """执行子进程任务并把结果写入共享队列。"""

    publisher = ProcessMessagePublisher(task_id, queue)
    try:
        if with_publisher:
            kwargs = {**kwargs, "publisher": publisher}
        publisher.result(target(*args, **kwargs))
    except Exception:
        error = traceback.format_exc()
        publisher.error(error)
        raise


class ProcessTaskManager:
    """全局子进程任务管理器。"""

    def __init__(self, stop_timeout: float = 5.0) -> None:
        """初始化管理器。

        Args:
            stop_timeout: terminate 后等待退出的秒数。
        """

        self.stop_timeout = stop_timeout
        self._ctx: BaseContext = get_context("spawn")
        self._queue = self._ctx.Queue()
        self._tasks: dict[str, ProcessTask] = {}
        self._condition = Condition()
        self._active = True
        self._thread = Thread(target=self._consume_messages, daemon=True)
        self._thread.start()

    def start(
        self,
        task_id: str,
        task_type: str,
        target: ProcessTarget,
        args: tuple[object, ...] = (),
        kwargs: dict[str, object] | None = None,
        name: str = "",
        metadata: dict[str, object] | None = None,
        with_publisher: bool = True,
    ) -> ProcessTask:
        """启动一个子进程任务。

        Args:
            task_id: 任务唯一标识。
            task_type: 任务类型。
            target: 子进程入口函数。
            args: 入口函数位置参数。
            kwargs: 入口函数关键字参数。
            name: 展示名称。
            metadata: 展示用业务元数据。
            with_publisher: 是否注入 publisher 参数。

        Returns:
            任务运行态。

        Raises:
            ValueError: 任务标识重复。
        """

        self.cleanup(task_id)
        with self._condition:
            if task_id in self._tasks:
                raise ValueError(f"任务仍在运行: {task_id}")
            process = self._ctx.Process(
                target=_run_child,
                args=(task_id, self._queue, target, args, kwargs or {}, with_publisher),
            )
            task = ProcessTask(
                task_id=task_id,
                task_type=task_type,
                process=process,
                name=name,
                metadata=metadata or {},
            )
            self._tasks[task_id] = task

        process.start()
        return task

    def wait_result(self, task_id: str, timeout: float | None = None) -> object:
        """等待任务结果。

        Args:
            task_id: 任务唯一标识。
            timeout: 最长等待秒数。

        Returns:
            子进程返回值。

        Raises:
            RuntimeError: 子进程失败或任务不存在。
            TimeoutError: 等待超时。
        """

        deadline = None if timeout is None else datetime.now().timestamp() + timeout
        with self._condition:
            while True:
                task = self._tasks.get(task_id)
                if not task:
                    raise RuntimeError(f"任务不存在: {task_id}")
                self._refresh(task)

                if task.result_ready:
                    result = task.result
                    process = task.process
                    break
                if task.error:
                    raise RuntimeError(task.error)
                if task.status in {TaskStatus.CANCELLED, TaskStatus.TIMEOUT, TaskStatus.FAILED}:
                    raise RuntimeError(f"任务未返回结果: {task.snapshot()}")
                if deadline is not None and datetime.now().timestamp() >= deadline:
                    raise TimeoutError(f"等待任务超时: {task_id}")

                self._condition.wait(timeout=0.2)

        process.join()
        self.refresh(task_id)
        return result

    def get(self, task_id: str) -> ProcessTask | None:
        """获取单个任务。"""

        with self._condition:
            task = self._tasks.get(task_id)
            if task:
                self._refresh(task)
            return task

    def list_snapshots(self) -> list[dict[str, object]]:
        """返回全部任务快照。"""

        with self._condition:
            for task in self._tasks.values():
                self._refresh(task)
            return [task.snapshot() for task in self._tasks.values()]

    def refresh(self, task_id: str | None = None) -> None:
        """刷新任务状态。"""

        with self._condition:
            tasks = [self._tasks[task_id]] if task_id else list(self._tasks.values())
            for task in tasks:
                self._refresh(task)
            self._condition.notify_all()

    def stop(self, task_id: str, timeout_status: bool = False) -> ProcessTask | None:
        """停止任务。

        Args:
            task_id: 任务唯一标识。
            timeout_status: 是否标记为超时。

        Returns:
            停止后的任务；不存在时返回 None。
        """

        task = self.get(task_id)
        if not task:
            return None

        if task.process.is_alive():
            task.process.terminate()
            task.process.join(self.stop_timeout)
        if task.process.is_alive():
            task.process.kill()
            task.process.join()

        with self._condition:
            task.status = TaskStatus.TIMEOUT if timeout_status else TaskStatus.CANCELLED
            task.finished_at = task.finished_at or datetime.now()
            self._condition.notify_all()
            return task

    def mark_error(self, task_id: str, error: str) -> None:
        """标记任务失败。"""

        with self._condition:
            task = self._tasks.get(task_id)
            if task:
                task.error = error
                task.status = TaskStatus.FAILED
                task.finished_at = task.finished_at or datetime.now()
                self._condition.notify_all()

    def cleanup(self, task_id: str) -> None:
        """清理已结束任务。"""

        task = self.get(task_id)
        if task and not task.process.is_alive():
            with self._condition:
                self._tasks.pop(task_id, None)

    def close(self, stop_running: bool = False) -> None:
        """关闭管理器。"""

        if stop_running:
            for task_id in list(self._tasks):
                self.stop(task_id)
        self._active = False
        self._thread.join(timeout=1)

    def _consume_messages(self) -> None:
        """消费共享队列消息。"""

        while self._active:
            try:
                message = self._queue.get(timeout=0.2)
            except Empty:
                continue
            except (EOFError, OSError):
                break
            self._handle_message(message)

    def _handle_message(self, message: dict[str, object]) -> None:
        """处理一条子进程消息。"""

        task_id = str(message.get("task_id", ""))
        kind = str(message.get("kind", ""))
        with self._condition:
            task = self._tasks.get(task_id)
            if not task:
                return
            if kind == "log":
                task.logs.append(str(message.get("data", "")))
            elif kind == "result":
                task.result = message.get("data")
                task.result_ready = True
            elif kind == "error":
                task.error = str(message.get("data", "子进程执行失败"))
                task.status = TaskStatus.FAILED
                task.finished_at = datetime.now()
            self._refresh(task)
            self._condition.notify_all()

    def _refresh(self, task: ProcessTask) -> None:
        """根据进程退出码刷新任务状态。"""

        if task.process.is_alive() or task.status in {
            TaskStatus.SUCCEEDED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
            TaskStatus.TIMEOUT,
        }:
            return

        task.finished_at = task.finished_at or datetime.now()
        if task.error:
            task.status = TaskStatus.FAILED
        elif task.result_ready or task.process.exitcode == 0:
            task.status = TaskStatus.SUCCEEDED
        else:
            task.status = TaskStatus.FAILED
