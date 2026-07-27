from __future__ import annotations

from alpha.api.container import create_alpha_service_container
from alpha.runtime.event import EventEngine


class FakeDatabase:
    """测试用数据库门面。"""

    def __init__(self) -> None:
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


def test_api_container_initializes_runtime_objects_lazily() -> None:
    """验证 API 容器只组装运行对象并延迟初始化策略管理器。"""

    created_managers: list[FakeStrategyManager] = []

    def create_strategy_manager(
        event_engine: EventEngine,
        process_manager: FakeTaskManager,
    ) -> FakeStrategyManager:
        """创建测试策略管理器。

        Args:
            event_engine: Alpha 事件引擎。
            process_manager: 测试任务管理器。

        Returns:
            测试策略管理器。
        """

        manager = FakeStrategyManager()
        created_managers.append(manager)
        return manager

    container = create_alpha_service_container(
        database_factory=FakeDatabase,
        event_engine_factory=EventEngine,
        task_manager_factory=FakeTaskManager,
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

    container = create_alpha_service_container(
        database_factory=lambda: database,
        event_engine_factory=EventEngine,
        task_manager_factory=lambda: task_manager,
        strategy_manager_factory=lambda event_engine, process_manager: FakeStrategyManager(),
    )

    await container.close()

    assert database.closed
    assert task_manager.closed
