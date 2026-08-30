"""测试 StrategyManager 只通过统一 TaskManager 调度回测和优化。"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Callable

import pytest

import alpha.strategy.manager as manager_module
from alpha.backtest.template import StrategyTemplate
from alpha.common.enums import Interval, Product
from alpha.common.schema_backtest import BacktestReq
from alpha.runtime.event import EventEngine
from alpha.strategy.loader import StrategyLoader
from alpha.strategy.manager import StrategyManager


class ManagerTestStrategy(StrategyTemplate):
    """任务调度测试使用的最小策略。"""

    class_name = "ManagerTestStrategy"
    parameters: list[str] = []
    variables: list[str] = []


class FakeTaskManager:
    """记录任务启动并同步执行父进程 result handler。"""

    def __init__(self, result: object | None = None) -> None:
        self.result = result
        self.started: dict[str, object] | None = None

    def start(
        self,
        task_id: str,
        kind: str,
        target: Callable[..., object],
        args: tuple[object, ...] = (),
        kwargs: dict[str, object] | None = None,
        name: str = "",
        metadata: dict[str, object] | None = None,
        with_publisher: bool = True,
        result_handler: Callable[[object], None] | None = None,
    ) -> object:
        """记录统一任务参数并模拟结果提交。"""

        self.started = {
            "task_id": task_id,
            "kind": kind,
            "target": target,
            "args": args,
            "kwargs": kwargs or {},
            "name": name,
            "metadata": metadata or {},
            "with_publisher": with_publisher,
            "result_handler": result_handler,
        }
        if result_handler is not None and self.result is not None:
            result_handler(self.result)
        return object()

    def list_snapshots(self) -> list[dict[str, object]]:
        """返回已经启动任务的统一快照。"""

        if self.started is None:
            return []
        return [
            {
                "task_id": self.started["task_id"],
                "kind": self.started["kind"],
                "status": "running",
            }
        ]

    def get(self, _task_id: str) -> None:
        """测试不提供实际任务对象。"""

        return None

    def mark_error(self, _task_id: str, _error: str) -> None:
        """测试路径不记录启动失败。"""


@pytest.fixture(autouse=True)
def disable_strategy_scan(monkeypatch: pytest.MonkeyPatch) -> None:
    """关闭默认目录扫描并注入确定策略类。"""

    def load(self: StrategyLoader) -> bool:
        self.classes = {"ManagerTestStrategy": ManagerTestStrategy}
        self.class_info = {
            "ManagerTestStrategy": {
                "class_name": "ManagerTestStrategy",
                "author": "test",
            }
        }
        return True

    monkeypatch.setattr(StrategyLoader, "load_from_default_folder", load)


def _make_request() -> BacktestReq:
    """构造确定的回测请求。"""

    return BacktestReq(
        class_name="ManagerTestStrategy",
        vt_symbols=["000001.SZSE"],
        product=Product.EQUITY,
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 31),
        capital=1_000_000,
        param_setting={"window": 5},
    )


def _make_manager(task_manager: FakeTaskManager) -> StrategyManager:
    """创建使用测试任务管理器的策略服务。"""

    return StrategyManager(
        EventEngine(),
        Path.cwd(),
        task_manager=task_manager,  # type: ignore[arg-type]
    )


def test_strategy_manager_starts_backtest_and_commits_result_before_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """回测只走进程入口，result handler 负责持久化最终结果。"""

    result = {
        "param_settings": {"window": 5},
        "trades": [],
        "orders": [],
        "daily_results": [],
        "statistics": {"total_return": 1.0},
    }
    saved: dict[str, object] = {}
    monkeypatch.setattr(
        manager_module.StrategyResult,
        "save_strategy_result",
        lambda name, payload: saved.update({name: payload}),
    )
    task_manager = FakeTaskManager(result)
    manager = _make_manager(task_manager)
    request = _make_request()

    task_id = manager.start_backtesting(request)

    assert task_manager.started is not None
    assert task_manager.started["target"] is manager_module.run_backtest_task
    assert task_manager.started["kind"] == "backtest"
    assert task_manager.started["metadata"]["strategy_name"] == "ManagerTestStrategy"
    assert saved[task_id]["result"] == result


def test_strategy_manager_starts_optimization_with_unified_task() -> None:
    """参数优化复用 TaskManager，不再保留 inline 或 thread 分支。"""

    result = [
        {
            "param_settings": {"window": 5},
            "statistics": {"total_return": 1.0},
        }
    ]
    task_manager = FakeTaskManager(result)
    manager = _make_manager(task_manager)
    request = _make_request()
    request.optimization_setting = {"window": {"start": 5, "end": 5, "step": 1}}
    request.target_name = "total_return"
    request.bt_type = "bf_optimization"

    task_id = manager.start_optimization(request)

    assert task_id == request.hash_name
    assert task_manager.started is not None
    assert task_manager.started["target"] is manager_module.run_optimization_task
    assert task_manager.started["kind"] == "optimization"
    assert task_manager.started["metadata"]["target_name"] == "total_return"


def test_strategy_manager_keeps_domain_runtime_placeholders() -> None:
    """长期模拟盘和实盘仍由未来领域 Engine 实现，不进入 TaskManager。"""

    manager = _make_manager(FakeTaskManager())

    with pytest.raises(NotImplementedError, match="模拟盘"):
        manager.start_paper_trading()
    with pytest.raises(NotImplementedError, match="实盘"):
        manager.start_live_trading()
