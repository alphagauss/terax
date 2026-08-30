"""Alpha 进程内同步事件总线。

事件引擎只负责按类型和可选业务键顺序分发不可变事件，不管理行情连接、
任务状态、持久化或 WebSocket。所有处理器必须快速返回，异步和跨进程边界
由各自适配器转换为普通同步回调。
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from queue import Queue
from threading import Event as ThreadEvent
from threading import RLock, Thread, current_thread
from typing import Any

from loguru import logger

from alpha.runtime.event_types import EVENT_TIMER


@dataclass(frozen=True, slots=True)
class Event:
    """一条不可变领域事件。

    ``type`` 定义稳定事件族，``key`` 用于路由到具体任务、行情键或账户；
    ``revision`` 只在具有权威快照的事件中使用。
    """

    type: str
    data: Any = None
    key: str | None = None
    revision: int | None = None
    occurred_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


HandlerType = Callable[[Event], None]


class EventEngine:
    """在单独线程中按入队顺序分发事件。"""

    def __init__(self, interval: float = 1.0) -> None:
        """创建尚未启动的事件引擎。"""

        if interval <= 0:
            raise ValueError("事件定时器间隔必须大于零")
        self._interval = interval
        self._queue: Queue[Event | None] = Queue()
        self._handlers: defaultdict[tuple[str, str | None], list[HandlerType]] = (
            defaultdict(list)
        )
        self._general_handlers: list[HandlerType] = []
        self._lock = RLock()
        self._stop_signal = ThreadEvent()
        self._thread: Thread | None = None
        self._timer: Thread | None = None
        self.active = False

    def start(self) -> None:
        """启动分发线程和 timer 线程，重复调用保持幂等。"""

        with self._lock:
            if self.active:
                return
            self.active = True
            self._stop_signal.clear()
            self._thread = Thread(target=self._run, name="alpha-events", daemon=True)
            self._timer = Thread(
                target=self._run_timer,
                name="alpha-events-timer",
                daemon=True,
            )
            self._thread.start()
            self._timer.start()

    def stop(self) -> None:
        """停止事件分发，不等待完整 timer 间隔。"""

        with self._lock:
            if not self.active:
                return
            self.active = False
            thread = self._thread
            timer = self._timer
            self._thread = None
            self._timer = None
            self._stop_signal.set()
            self._queue.put(None)

        if timer is not None and timer.is_alive() and current_thread() is not timer:
            timer.join()
        if thread is not None and thread.is_alive() and current_thread() is not thread:
            thread.join()

    def put(self, event: Event) -> None:
        """把事件放入顺序分发队列。"""

        self._queue.put(event)

    def sub(
        self,
        event_type: str,
        handler: HandlerType,
        *,
        key: str | None = None,
    ) -> None:
        """订阅一种事件，可选限制到单个业务键。"""

        with self._lock:
            handlers = self._handlers[(event_type, key)]
            if handler not in handlers:
                handlers.append(handler)

    def unsub(
        self,
        event_type: str,
        handler: HandlerType,
        *,
        key: str | None = None,
    ) -> None:
        """取消一个精确的类型和业务键订阅。"""

        selector = (event_type, key)
        with self._lock:
            handlers = self._handlers.get(selector)
            if not handlers:
                return
            if handler in handlers:
                handlers.remove(handler)
            if not handlers:
                self._handlers.pop(selector, None)

    def sub_general(self, handler: HandlerType) -> None:
        """订阅全部内部事件，仅供进程内基础设施使用。"""

        with self._lock:
            if handler not in self._general_handlers:
                self._general_handlers.append(handler)

    def unsub_general(self, handler: HandlerType) -> None:
        """取消全部事件订阅。"""

        with self._lock:
            if handler in self._general_handlers:
                self._general_handlers.remove(handler)

    def _run(self) -> None:
        """持续消费队列，停止哨兵之后退出。"""

        while True:
            event = self._queue.get()
            if event is None:
                return
            self._process(event)

    def _process(self, event: Event) -> None:
        """按通用类型、精确键和全局订阅的顺序调用处理器。"""

        with self._lock:
            handlers = list(self._handlers.get((event.type, None), []))
            if event.key is not None:
                handlers.extend(self._handlers.get((event.type, event.key), []))
            handlers.extend(self._general_handlers)

        for handler in handlers:
            try:
                handler(event)
            except Exception:
                logger.exception(
                    "事件处理器异常 type={} key={} handler={}",
                    event.type,
                    event.key,
                    handler,
                )

    def _run_timer(self) -> None:
        """按固定间隔发布 timer 事件。"""

        while not self._stop_signal.wait(self._interval):
            self.put(Event(type=EVENT_TIMER))
