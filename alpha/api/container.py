"""Alpha API 运行容器。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from alpha.api.cache import AsyncTtlCache
from alpha.api.events import WebSocketEventGateway
from alpha.common.schema_backtest import BacktestReq
from alpha.config import AlphaConfig
from alpha.realtime.feed import MarketFeed
from alpha.runtime.event import EventEngine
from alpha.runtime.processes import TaskManager

if TYPE_CHECKING:
    from alpha.storage.database import DataBase
    from alpha.strategy.manager import StrategyManager


class _LazyStrategyManager:
    """按需初始化策略核心管理器。"""

    def __init__(
        self,
        event_engine: EventEngine,
        task_manager: TaskManager,
        database_dir: Path,
        factory: Callable[[EventEngine, TaskManager, Path], "StrategyManager"] | None,
    ) -> None:
        """初始化懒加载代理。

        Args:
            event_engine: Alpha 事件引擎。
            task_manager: Alpha 有限任务管理器。
            database_dir: 回测任务读取的数据库目录。
            factory: 可选策略管理器工厂。
        """

        self._event_engine = event_engine
        self._task_manager = task_manager
        self._database_dir = database_dir
        self._factory = factory
        self._manager: StrategyManager | None = None

    def _get_manager(self) -> "StrategyManager":
        """返回实际策略管理器。

        Args:
            无。

        Returns:
            已初始化的策略管理器。
        """

        if self._manager is None:
            if self._factory is None:
                from alpha.strategy.manager import StrategyManager

                self._manager = StrategyManager(
                    self._event_engine,
                    self._database_dir,
                    task_manager=self._task_manager,
                )
            else:
                self._manager = self._factory(
                    self._event_engine,
                    self._task_manager,
                    self._database_dir,
                )
        return self._manager

    def get_strategy_class(self) -> dict[str, dict[str, object]]:
        """返回策略类元数据。

        Args:
            无。

        Returns:
            策略类元数据映射。
        """

        return self._get_manager().get_strategy_class()

    def load_strategy_class(self) -> bool:
        """刷新策略类。

        Args:
            无。

        Returns:
            刷新是否成功。
        """

        return self._get_manager().load_strategy_class()

    def get_status_dict(self) -> dict[str, dict[str, object]]:
        """返回任务状态映射。

        Args:
            无。

        Returns:
            任务状态映射。
        """

        return self._get_manager().get_status_dict()

    def start_backtesting(self, request: BacktestReq) -> str:
        """启动回测任务。

        Args:
            request: 回测请求。

        Returns:
            任务标识。
        """

        return self._get_manager().start_backtesting(request)

    def get_all_strategy_result_info(self) -> dict[str, dict[str, object]]:
        """返回全部策略结果概要。

        Args:
            无。

        Returns:
            策略结果概要映射。
        """

        return self._get_manager().get_all_strategy_result_info()

    def get_strategy_result(self, hash_name: str) -> dict[str, object]:
        """返回指定策略结果。

        Args:
            hash_name: 策略结果文件名。

        Returns:
            策略结果字典。
        """

        return self._get_manager().get_strategy_result(hash_name)


@dataclass
class AlphaServiceContainer:
    """Alpha API 共享的运行对象容器。"""

    config: AlphaConfig
    database: "DataBase"
    strategy_manager: _LazyStrategyManager
    event_engine: EventEngine
    task_manager: TaskManager
    market_feed: MarketFeed
    event_gateway: WebSocketEventGateway
    data_overview_cache: AsyncTtlCache[dict[str, object]]

    async def start(self) -> None:
        """启动事件总线并把 WebSocket Gateway 绑定到当前 FastAPI loop。"""

        self.event_gateway.start(asyncio.get_running_loop())
        self.event_engine.start()

    async def close(self) -> None:
        """关闭容器持有的运行对象。

        Args:
            无。

        Returns:
            无返回值。
        """

        await self.event_gateway.close()
        self.task_manager.close(stop_running=True)
        await self.market_feed.close()
        await self.database.close()
        self.event_engine.stop()

    def has_running_tasks(self) -> bool:
        """返回当前容器是否仍有运行中的任务。"""

        process_running = any(
            snapshot.get("status") == "running"
            for snapshot in self.task_manager.list_snapshots()
        )
        return process_running


def create_alpha_service_container(
    config: AlphaConfig,
    *,
    database_factory: Callable[[Path], "DataBase"] | None = None,
    event_engine_factory: Callable[[], EventEngine] = EventEngine,
    task_manager_factory: Callable[[EventEngine], TaskManager] = TaskManager,
    market_feed_factory: Callable[[EventEngine], MarketFeed] = MarketFeed,
    event_gateway_factory: Callable[
        [EventEngine, MarketFeed], WebSocketEventGateway
    ] = WebSocketEventGateway,
    strategy_manager_factory: (
        Callable[
            [EventEngine, TaskManager, Path],
            "StrategyManager",
        ]
        | None
    ) = None,
) -> AlphaServiceContainer:
    """创建 Alpha API 运行对象容器。

    Args:
        config: 当前进程使用的 Alpha 配置。
        database_factory: 数据库门面工厂，测试可注入替身。
        event_engine_factory: 事件引擎工厂，测试可注入替身。
        task_manager_factory: 有限任务管理器工厂，测试可注入替身。
        market_feed_factory: 行情租约引擎工厂，测试可注入替身。
        event_gateway_factory: 公共事件 WebSocket Gateway 工厂。
        strategy_manager_factory: 策略管理器工厂，测试可注入替身。

    Returns:
        已组装好的 Alpha API 运行容器。
    """

    if database_factory is None:
        from alpha.storage.database import DataBase

        database = DataBase(config.database_dir)
    else:
        database = database_factory(config.database_dir)

    event_engine = event_engine_factory()
    task_manager = task_manager_factory(event_engine)
    market_feed = market_feed_factory(event_engine)
    event_gateway = event_gateway_factory(event_engine, market_feed)

    # 策略管理器访问策略/回测接口时再初始化，避免健康检查挂载时拉起重依赖。
    strategy_manager = _LazyStrategyManager(
        event_engine,
        task_manager,
        config.database_dir,
        strategy_manager_factory,
    )

    return AlphaServiceContainer(
        config=config,
        database=database,
        strategy_manager=strategy_manager,
        event_engine=event_engine,
        task_manager=task_manager,
        market_feed=market_feed,
        event_gateway=event_gateway,
        data_overview_cache=AsyncTtlCache(ttl_seconds=60),
    )
