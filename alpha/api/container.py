"""Alpha API 运行容器。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from alpha.api.cache import AsyncTtlCache
from alpha.common.schema_backtest import BacktestReq
from alpha.config import AlphaConfig
from alpha.runtime.event import EventEngine
from alpha.runtime.processes import ProcessTaskManager

if TYPE_CHECKING:
    from alpha.storage.database import DataBase
    from alpha.strategy.manager import StrategyManager


class _LazyStrategyManager:
    """按需初始化策略核心管理器。"""

    def __init__(
        self,
        event_engine: EventEngine,
        process_manager: ProcessTaskManager,
        database_dir: Path,
        factory: Callable[
            [EventEngine, ProcessTaskManager, Path], "StrategyManager"
        ]
        | None,
    ) -> None:
        """初始化懒加载代理。

        Args:
            event_engine: Alpha 事件引擎。
            process_manager: Alpha 进程任务管理器。
            database_dir: 回测任务读取的数据库目录。
            factory: 可选策略管理器工厂。
        """

        self._event_engine = event_engine
        self._process_manager = process_manager
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
                    task_manager=self._process_manager,
                )
            else:
                self._manager = self._factory(
                    self._event_engine,
                    self._process_manager,
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

    def has_running_tasks(self) -> bool:
        """返回已初始化策略管理器中是否存在运行任务。"""

        if self._manager is None:
            return False
        return any(
            snapshot.get("status") == "running"
            for snapshot in self._manager.get_status_dict().values()
        )


@dataclass
class AlphaServiceContainer:
    """Alpha API 共享的运行对象容器。"""

    config: AlphaConfig
    database: "DataBase"
    strategy_manager: _LazyStrategyManager
    event_engine: EventEngine
    process_manager: ProcessTaskManager
    data_overview_cache: AsyncTtlCache[dict[str, object]]

    async def close(self) -> None:
        """关闭容器持有的运行对象。

        Args:
            无。

        Returns:
            无返回值。
        """

        await self.database.close()
        self.event_engine.stop()
        self.process_manager.close(stop_running=True)

    def has_running_tasks(self) -> bool:
        """返回当前容器是否仍有运行中的任务。"""

        process_running = any(
            snapshot.get("status") == "running"
            for snapshot in self.process_manager.list_snapshots()
        )
        return process_running or self.strategy_manager.has_running_tasks()


def create_alpha_service_container(
    config: AlphaConfig,
    *,
    database_factory: Callable[[Path], "DataBase"] | None = None,
    event_engine_factory: Callable[[], EventEngine] = EventEngine,
    task_manager_factory: Callable[[], ProcessTaskManager] = ProcessTaskManager,
    strategy_manager_factory: Callable[
        [EventEngine, ProcessTaskManager, Path],
        "StrategyManager",
    ]
    | None = None,
) -> AlphaServiceContainer:
    """创建 Alpha API 运行对象容器。

    Args:
        config: 当前进程使用的 Alpha 配置。
        database_factory: 数据库门面工厂，测试可注入替身。
        event_engine_factory: 事件引擎工厂，测试可注入替身。
        task_manager_factory: 进程任务管理器工厂，测试可注入替身。
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
    process_manager = task_manager_factory()

    # 策略管理器访问策略/回测接口时再初始化，避免健康检查挂载时拉起重依赖。
    strategy_manager = _LazyStrategyManager(
        event_engine,
        process_manager,
        config.database_dir,
        strategy_manager_factory,
    )

    return AlphaServiceContainer(
        config=config,
        database=database,
        strategy_manager=strategy_manager,
        event_engine=event_engine,
        process_manager=process_manager,
        data_overview_cache=AsyncTtlCache(ttl_seconds=60),
    )
