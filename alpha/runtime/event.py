"""多线程事件驱动引擎。"""

from __future__ import annotations

import asyncio
import inspect
from collections import defaultdict
from concurrent.futures import Future
from queue import Empty, Queue
from threading import RLock, Thread, current_thread
from time import sleep
from typing import Any, Awaitable, Callable, TypeAlias

from loguru import logger
from pydantic import BaseModel

from alpha.common.schema_core import EVENT_TIMER
from alpha.utils import SingletonMeta


class Event(BaseModel):
    """
    使用BaseModel的目的是方便数据序列json
    """

    type: str
    data: Any = None


HandlerType: TypeAlias = Callable[[Event], Awaitable[None] | None]


class EventEngine(metaclass=SingletonMeta):
    """
    Event engine distributes event object based on its type to those handlers
    registered. It also generates timer event by every interval seconds, which
    can be used for timing purpose.

    事件监听函数必须定义为输入参数仅为一个 event 对象。处理器可以是同步函数，
    也可以是异步函数；异步函数会被调度到绑定的 asyncio 事件循环执行。
    """

    def __init__(self, interval: int = 1) -> None:
        """初始化事件引擎。

        Args:
            interval: 定时器事件投递间隔，单位为秒。
        """

        self._interval: int = interval
        self._queue: Queue[Event] = Queue()
        self.active: bool = False
        self._thread: Thread | None = None
        self._timer: Thread | None = None
        self._handlers: defaultdict[str, list[HandlerType]] = defaultdict(list)
        self._general_handlers: list[HandlerType] = []
        self._async_loop: asyncio.AbstractEventLoop | None = None
        self._lock = RLock()

    def bind_async_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """绑定异步处理器使用的事件循环。

        Args:
            loop: FastAPI、WebSocket 或其他 asyncio 服务所在事件循环。
        """

        self._async_loop = loop

    def _run(self) -> None:
        """持续处理事件队列中的事件。"""
        while self.active:
            try:
                event: Event = self._queue.get(block=True, timeout=1)
                self._process(event)
            except Empty:
                pass

    def _process(self, event: Event) -> None:
        """分发单个事件到已注册处理器。"""
        with self._lock:
            handlers = [
                *self._handlers.get(event.type, []),
                *self._general_handlers,
            ]

        for handler in handlers:
            try:
                result = handler(event)
                if inspect.isawaitable(result):
                    self._dispatch_awaitable(result, event, handler)
            except Exception as exc:
                logger.exception(
                    f"Error processing event {event.type} with handler {handler}: {exc}"
                )

    def _dispatch_awaitable(
        self,
        awaitable: Awaitable[None],
        event: Event,
        handler: HandlerType,
    ) -> None:
        """调度异步事件处理器。

        Args:
            awaitable: 事件处理器返回的可等待对象。
            event: 当前正在分发的事件。
            handler: 当前事件处理器，用于异常日志定位。
        """

        loop = self._async_loop
        if loop is not None and loop.is_running():
            future = asyncio.run_coroutine_threadsafe(
                self._await_result(awaitable),
                loop,
            )
            future.add_done_callback(
                lambda done: self._log_async_exception(done, event, handler)
            )
            return

        try:
            asyncio.run(self._await_result(awaitable))
        except Exception as exc:
            logger.exception(
                f"Error processing async event {event.type} with handler {handler}: {exc}"
            )

    @staticmethod
    async def _await_result(awaitable: Awaitable[None]) -> None:
        """等待异步处理器执行完成。

        Args:
            awaitable: 事件处理器返回的可等待对象。
        """

        await awaitable

    def _log_async_exception(
        self,
        future: Future[None],
        event: Event,
        handler: HandlerType,
    ) -> None:
        """记录异步处理器异常。

        Args:
            future: asyncio 调度返回的线程安全 Future。
            event: 当前正在分发的事件。
            handler: 当前事件处理器，用于异常日志定位。
        """

        try:
            future.result()
        except Exception as exc:
            logger.exception(
                f"Error processing async event {event.type} with handler {handler}: {exc}"
            )

    def _run_timer(self) -> None:
        """按固定间隔投递计时器事件。"""
        while self.active:
            sleep(self._interval)
            event: Event = Event(type=EVENT_TIMER)
            self.put(event)

    def start(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """启动事件引擎。

        Args:
            loop: 可选的 asyncio 事件循环，用于执行异步事件处理器。
        """

        if loop is not None:
            self.bind_async_loop(loop)

        with self._lock:
            if self.active:
                return

            self.active = True
            self._thread = Thread(target=self._run, daemon=True)
            self._timer = Thread(target=self._run_timer, daemon=True)
            self._thread.start()
            self._timer.start()

    def stop(self) -> None:
        """停止事件引擎。"""
        with self._lock:
            if not self.active:
                return

            self.active = False
            timer = self._timer
            thread = self._thread

        if timer is not None and timer.is_alive() and current_thread() is not timer:
            timer.join()
        if thread is not None and thread.is_alive() and current_thread() is not thread:
            thread.join()
        logger.info("事件引擎关闭")

    def put(self, event: Event) -> None:
        """向队列投递事件。

        Args:
            event: 待分发事件。
        """

        self._queue.put(event)

    def sub(self, type: str, handler: HandlerType) -> None:
        """订阅指定类型事件。

        Args:
            type: 事件类型。
            handler: 事件处理器。
        """

        with self._lock:
            handler_list = self._handlers[type]
            if handler not in handler_list:
                handler_list.append(handler)

    def unsub(self, type: str, handler: HandlerType) -> None:
        """取消订阅指定类型事件。

        Args:
            type: 事件类型。
            handler: 事件处理器。
        """

        with self._lock:
            handler_list = self._handlers[type]
            if handler in handler_list:
                handler_list.remove(handler)

            if not handler_list:
                self._handlers.pop(type, None)

    def sub_general(self, handler: HandlerType) -> None:
        """订阅所有事件。

        Args:
            handler: 事件处理器。
        """

        with self._lock:
            if handler not in self._general_handlers:
                self._general_handlers.append(handler)

    def unsub_general(self, handler: HandlerType) -> None:
        """取消订阅所有事件。

        Args:
            handler: 事件处理器。
        """

        with self._lock:
            if handler in self._general_handlers:
                self._general_handlers.remove(handler)
