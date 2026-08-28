"""Alpha API 容器组装和资源关闭不变量测试。"""

from __future__ import annotations

from pathlib import Path

from alpha.api.container import create_alpha_service_container
from alpha.config import AlphaConfig
from alpha.runtime.event import EventEngine


class FakeDatabase:
    """测试用数据库门面。"""

    def __init__(self, _data_dir: Path | None = None) -> None:
        self.closed = False

    async def close(self) -> None:
        """记录关闭动作。

        Args:
            无。

        Returns:
            无返回值。
        """

        self.closed = True


class FakeStrategyManager:
    """测试用策略管理器。"""

    def get_strategy_class(self) -> dict[str, dict[str, object]]:
        """返回固定策略元数据。

        Args:
            无。

        Returns:
            固定策略映射。
        """

        return {"DemoStrategy": {"class_name": "DemoStrategy"}}


class FakeTaskManager:
    """测试用任务管理器。"""

    def __init__(self) -> None:
        self.closed = False

    def close(self, stop_running: bool = False) -> None:
        """记录关闭动作。

        Args:
            stop_running: 是否停止运行中的任务。

        Returns:
            无返回值。
        """

        assert stop_running is True
        self.closed = True


class FakeMarketData:
    """测试用实时行情服务。"""

    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        """记录实时连接资源已经关闭。"""

        self.closed = True


def test_api_container_initializes_runtime_objects_lazily() -> None:
    """验证 API 容器只组装运行对象并延迟初始化策略管理器。"""

    created_managers: list[FakeStrategyManager] = []

    def create_strategy_manager(
        event_engine: EventEngine,
        process_manager: FakeTaskManager,
        _database_dir: Path,
    ) -> FakeStrategyManager:
        """创建测试策略管理器。

        Args:
            event_engine: Alpha 事件引擎。
            process_manager: 测试任务管理器。
            _database_dir: 测试不使用的数据库目录。

        Returns:
            测试策略管理器。
        """

        manager = FakeStrategyManager()
        created_managers.append(manager)
        return manager

    container = create_alpha_service_container(
        AlphaConfig(data_dir=Path.cwd()),
        database_factory=FakeDatabase,
        event_engine_factory=EventEngine,
        task_manager_factory=FakeTaskManager,
        market_data_factory=FakeMarketData,
        strategy_manager_factory=create_strategy_manager,
    )

    assert isinstance(container.database, FakeDatabase)
    assert isinstance(container.process_manager, FakeTaskManager)
    assert created_managers == []

    assert container.strategy_manager.get_strategy_class() == {
        "DemoStrategy": {"class_name": "DemoStrategy"}
    }
    assert len(created_managers) == 1


async def test_api_container_closes_runtime_objects() -> None:
    """验证 API 容器能关闭持有的运行对象。"""

    database = FakeDatabase()
    task_manager = FakeTaskManager()
    market_data = FakeMarketData()

    container = create_alpha_service_container(
        AlphaConfig(data_dir=Path.cwd()),
        database_factory=lambda _data_dir: database,
        event_engine_factory=EventEngine,
        task_manager_factory=lambda: task_manager,
        market_data_factory=lambda: market_data,
        strategy_manager_factory=lambda _event_engine, _process_manager, _database_dir: FakeStrategyManager(),
    )

    await container.close()

    assert database.closed
    assert market_data.closed
    assert task_manager.closed
