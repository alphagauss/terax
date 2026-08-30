"""测试 Alpha API 容器的统一运行对象组装和关闭顺序。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from alpha.api.container import create_alpha_service_container
from alpha.config import AlphaConfig
from alpha.runtime.event import EventEngine


class FakeDatabase:
    """记录数据库关闭动作。"""

    def __init__(
        self,
        _data_dir: Path | None = None,
        close_order: list[str] | None = None,
    ) -> None:
        self.closed = False
        self.close_order = close_order

    async def close(self) -> None:
        """关闭测试数据库。"""

        self.closed = True
        if self.close_order is not None:
            self.close_order.append("database")


class FakeStrategyManager:
    """延迟初始化策略管理器替身。"""

    def get_strategy_class(self) -> dict[str, dict[str, object]]:
        """返回固定策略元数据。"""

        return {"DemoStrategy": {"class_name": "DemoStrategy"}}


class FakeTaskManager:
    """记录统一 TaskManager 的关闭动作。"""

    def __init__(
        self,
        _event_engine: EventEngine,
        close_order: list[str] | None = None,
    ) -> None:
        self.closed = False
        self.close_order = close_order

    def list_snapshots(self) -> list[dict[str, object]]:
        """返回空任务列表。"""

        return []

    def close(self, stop_running: bool = False) -> None:
        """记录关闭参数。"""

        assert stop_running is True
        self.closed = True
        if self.close_order is not None:
            self.close_order.append("tasks")


class FakeMarketFeed:
    """记录行情 Provider 关闭动作。"""

    def __init__(self, _event_engine: EventEngine) -> None:
        self.closed = False

    async def close(self) -> None:
        """关闭测试行情引擎。"""

        self.closed = True


class FakeEventGateway:
    """记录 EventEngine loop 绑定和关闭动作。"""

    def __init__(
        self, _event_engine: EventEngine, _market_feed: FakeMarketFeed
    ) -> None:
        self.started = False
        self.closed = False

    def start(self, _loop: asyncio.AbstractEventLoop) -> None:
        """记录启动。"""

        self.started = True

    async def close(self) -> None:
        """记录关闭。"""

        self.closed = True


def test_api_container_initializes_strategy_manager_lazily() -> None:
    """容器立即组装核心运行对象，但访问策略能力前不扫描策略。"""

    created_managers: list[FakeStrategyManager] = []

    def create_strategy_manager(
        _event_engine: EventEngine,
        _task_manager: FakeTaskManager,
        _database_dir: Path,
    ) -> FakeStrategyManager:
        manager = FakeStrategyManager()
        created_managers.append(manager)
        return manager

    container = create_alpha_service_container(
        AlphaConfig(data_dir=Path.cwd()),
        database_factory=FakeDatabase,
        task_manager_factory=FakeTaskManager,  # type: ignore[arg-type]
        market_feed_factory=FakeMarketFeed,  # type: ignore[arg-type]
        event_gateway_factory=FakeEventGateway,  # type: ignore[arg-type]
        strategy_manager_factory=create_strategy_manager,  # type: ignore[arg-type]
    )

    assert isinstance(container.database, FakeDatabase)
    assert isinstance(container.task_manager, FakeTaskManager)
    assert created_managers == []
    assert container.strategy_manager.get_strategy_class() == {
        "DemoStrategy": {"class_name": "DemoStrategy"}
    }
    assert len(created_managers) == 1


def test_api_container_starts_and_closes_runtime_objects() -> None:
    """lifespan 启停同一 EventEngine、Gateway、MarketFeed 和 TaskManager。"""

    async def scenario() -> None:
        close_order: list[str] = []
        database = FakeDatabase(close_order=close_order)
        container = create_alpha_service_container(
            AlphaConfig(data_dir=Path.cwd()),
            database_factory=lambda _data_dir: database,
            task_manager_factory=lambda event_engine: FakeTaskManager(
                event_engine,
                close_order,
            ),
            market_feed_factory=FakeMarketFeed,  # type: ignore[arg-type]
            event_gateway_factory=FakeEventGateway,  # type: ignore[arg-type]
            strategy_manager_factory=(
                lambda _event_engine, _task_manager, _database_dir: FakeStrategyManager()
            ),
        )

        await container.start()
        assert container.event_engine.active
        assert container.event_gateway.started  # type: ignore[attr-defined]
        await container.close()

        assert database.closed
        assert container.market_feed.closed  # type: ignore[attr-defined]
        assert container.task_manager.closed  # type: ignore[attr-defined]
        assert container.event_gateway.closed  # type: ignore[attr-defined]
        assert not container.event_engine.active
        assert close_order == ["tasks", "database"]

    asyncio.run(scenario())
