from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from time import monotonic, sleep
from typing import Callable

import pytest

import alpha.strategy.manager as manager_module
from alpha.backtest.runner import BacktestJobSpec
from alpha.backtest.template import StrategyTemplate
from alpha.common.enums import Interval, Product
from alpha.common.schema_backtest import BacktestReq
from alpha.runtime.event import EventEngine
from alpha.strategy.loader import StrategyLoader
from alpha.strategy.manager import StrategyManager


class ManagerTestStrategy(StrategyTemplate):
    """用于验证策略管理器调度路径的最小策略类。"""

    class_name = "ManagerTestStrategy"
    parameters: list[str] = []
    variables: list[str] = []


@dataclass
class FakeProcess:
    """进程任务测试用进程快照。"""

    pid: int | None = 1001
    exitcode: int | None = 0

    def is_alive(self) -> bool:
        """返回测试进程是否存活。

        Args:
            无。

        Returns:
            测试进程始终视为已结束。
        """

        return False


@dataclass
class FakeProcessTask:
    """进程任务测试用任务快照。"""

    process: FakeProcess = field(default_factory=FakeProcess)


class FakeTaskManager:
    """避免单元测试启动真实子进程的任务管理器。"""

    def __init__(self, result: object | None = None) -> None:
        self.result = result
        self.started: dict[str, object] | None = None
        self.error: str | None = None
        self.task = FakeProcessTask()

    def start(
        self,
        task_id: str,
        task_type: str,
        target: Callable[..., object],
        args: tuple[object, ...] = (),
        kwargs: dict[str, object] | None = None,
        name: str = "",
        metadata: dict[str, object] | None = None,
        with_publisher: bool = True,
    ) -> FakeProcessTask:
        """记录进程任务启动参数。

        Args:
            task_id: 任务标识。
            task_type: 任务类型。
            target: 任务入口。
            args: 任务位置参数。
            kwargs: 任务关键字参数。
            name: 任务名称。
            metadata: 任务元数据。
            with_publisher: 是否注入 publisher。

        Returns:
            测试任务对象。
        """

        self.started = {
            "task_id": task_id,
            "task_type": task_type,
            "target": target,
            "args": args,
            "kwargs": kwargs or {},
            "name": name,
            "metadata": metadata or {},
            "with_publisher": with_publisher,
        }
        return self.task

    def wait_result(self, task_id: str, timeout: float | None = None) -> object:
        """返回预设任务结果。

        Args:
            task_id: 任务标识。
            timeout: 等待超时时间。

        Returns:
            预设任务结果。
        """

        return self.result

    def get(self, task_id: str) -> FakeProcessTask | None:
        """返回测试任务对象。

        Args:
            task_id: 任务标识。

        Returns:
            测试任务对象或空值。
        """

        return self.task

    def mark_error(self, task_id: str, error: str) -> None:
        """记录任务错误。

        Args:
            task_id: 任务标识。
            error: 错误文本。

        Returns:
            无返回值。
        """

        self.error = error

    def list_snapshots(self) -> list[dict[str, object]]:
        """返回进程任务快照。

        Args:
            无。

        Returns:
            进程任务快照列表。
        """

        if not self.started:
            return []
        return [
            {
                "task_id": self.started["task_id"],
                "task_type": self.started["task_type"],
                "name": self.started["name"],
                "metadata": self.started["metadata"],
                "status": "running",
                "pid": self.task.process.pid,
                "exitcode": self.task.process.exitcode,
                "error": self.error,
                "logs": [],
                "created_at": datetime.now().isoformat(),
                "finished_at": None,
            }
        ]


@pytest.fixture(autouse=True)
def disable_strategy_scan(monkeypatch: pytest.MonkeyPatch) -> None:
    """关闭默认策略目录扫描，让测试只使用注入的策略类。"""

    def load_empty(self: StrategyLoader) -> bool:
        """清空策略加载结果。

        Args:
            self: 策略加载器。

        Returns:
            始终返回成功。
        """

        self.classes.clear()
        self.class_info.clear()
        return True

    monkeypatch.setattr(StrategyLoader, "load_from_default_folder", load_empty)


def _make_request() -> BacktestReq:
    """构造策略管理器测试请求。

    Args:
        无。

    Returns:
        回测请求。
    """

    return BacktestReq(
        class_name=ManagerTestStrategy.class_name,
        vt_symbols=["000001.SZSE"],
        product=Product.ASHARE,
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 30),
        capital=1_000_000,
        param_setting={"window": 5},
    )


def _make_manager(task_manager: FakeTaskManager | None = None) -> StrategyManager:
    """构造注入测试策略类的策略管理器。

    Args:
        task_manager: 测试任务管理器。

    Returns:
        策略管理器。
    """

    manager = StrategyManager(
        EventEngine(),
        task_manager=task_manager or FakeTaskManager(),
    )
    manager.classes[ManagerTestStrategy.class_name] = ManagerTestStrategy
    return manager


def _patch_result_saving(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, dict[str, object]]:
    """替换结果保存函数并返回内存保存区。

    Args:
        monkeypatch: pytest monkeypatch。

    Returns:
        内存保存结果。
    """

    saved: dict[str, dict[str, object]] = {}

    def save_result(key: str, result: dict[str, object]) -> None:
        """保存回测结果到内存字典。"""

        saved[key] = result

    monkeypatch.setattr(
        manager_module.StrategyResult,
        "save_strategy_result",
        save_result,
    )
    return saved


def _patch_run_backtest_job(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[BacktestJobSpec, dict[str, object]]]:
    """替换同步回测业务函数并记录调用。

    Args:
        monkeypatch: pytest monkeypatch。

    Returns:
        回测业务函数调用记录。
    """

    calls: list[tuple[BacktestJobSpec, dict[str, object]]] = []

    def run_job(
        spec: BacktestJobSpec,
        param_setting: dict[str, object],
        output: Callable[[object], None] | None = None,
    ) -> dict[str, object]:
        """返回固定回测结果。"""

        calls.append((spec, param_setting))
        if output:
            output("测试回测日志")
        return {
            "param_settings": param_setting,
            "trades": [],
            "orders": [],
            "daily_results": [],
            "statistics": {"total_return": 1.0},
        }

    monkeypatch.setattr(manager_module, "run_backtest_job", run_job)
    return calls


def _wait_status(
    manager: StrategyManager,
    task_id: str,
    status: str,
) -> dict[str, object]:
    """等待本地任务进入指定状态。

    Args:
        manager: 策略管理器。
        task_id: 任务标识。
        status: 目标状态。

    Returns:
        任务状态快照。

    Raises:
        AssertionError: 等待超时。
    """

    deadline = monotonic() + 2
    while monotonic() < deadline:
        snapshot = manager.get_status_dict().get(task_id)
        if snapshot and snapshot["status"] == status:
            return snapshot
        sleep(0.01)
    raise AssertionError(f"任务未进入目标状态: {status}")


def test_strategy_manager_should_run_backtest_inline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证 inline 模式直接同步执行同一条回测业务函数。"""

    saved = _patch_result_saving(monkeypatch)
    calls = _patch_run_backtest_job(monkeypatch)
    manager = _make_manager()
    req = _make_request()

    task_id = manager.start_backtesting(req, run_mode="inline")
    snapshot = manager.get_status_dict()[task_id]

    assert task_id == req.hash_name
    assert snapshot["status"] == "succeeded"
    assert snapshot["run_mode"] == "inline"
    assert snapshot["logs"] == ["测试回测日志"]
    assert calls[0][0].strategy_class is ManagerTestStrategy
    assert saved[task_id]["result"]["statistics"] == {"total_return": 1.0}


def test_strategy_manager_should_run_backtest_in_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证 thread 模式不阻塞调用方且复用同一条回测业务函数。"""

    saved = _patch_result_saving(monkeypatch)
    calls = _patch_run_backtest_job(monkeypatch)
    manager = _make_manager()
    req = _make_request()

    task_id = manager.start_backtesting(req, run_mode="thread")
    snapshot = _wait_status(manager, task_id, "succeeded")

    assert snapshot["run_mode"] == "thread"
    assert snapshot["logs"] == ["测试回测日志"]
    assert calls[0][1] == {"window": 5}
    assert saved[task_id]["result"]["param_settings"] == {"window": 5}


def test_strategy_manager_should_start_backtest_in_process_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证 process 模式只通过进程适配入口启动任务。"""

    result = {
        "param_settings": {"window": 5},
        "trades": [],
        "orders": [],
        "daily_results": [],
        "statistics": {"total_return": 1.0},
    }
    task_manager = FakeTaskManager(result=result)
    saved = _patch_result_saving(monkeypatch)
    manager = _make_manager(task_manager)
    req = _make_request()

    task_id = manager.start_backtesting(req)
    deadline = monotonic() + 2
    while task_id not in saved and monotonic() < deadline:
        sleep(0.01)

    assert task_manager.started is not None
    assert task_manager.started["target"] is manager_module.run_backtest_task
    assert task_manager.started["task_type"] == "backtest"
    assert task_manager.started["metadata"]["strategy_name"] == "ManagerTestStrategy"
    assert saved[task_id]["result"] == result


def test_strategy_manager_should_start_optimization_in_process_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证参数优化默认使用进程任务入口而不是旧线程包装。"""

    result = [
        {
            "param_settings": {"window": 5},
            "trades": [],
            "orders": [],
            "daily_results": [],
            "statistics": {"total_return": 1.0},
        }
    ]
    task_manager = FakeTaskManager(result=result)
    manager = _make_manager(task_manager)
    req = _make_request()
    req.optimization_setting = {"window": {"start": 5, "end": 5, "step": 1}}
    req.target_name = "total_return"
    req.bt_type = "bf_optimization"

    task_id = manager.start_optimization(req)
    deadline = monotonic() + 2
    while task_manager.started is None and monotonic() < deadline:
        sleep(0.01)

    assert task_id == req.hash_name
    assert task_manager.started is not None
    assert task_manager.started["target"] is manager_module.run_optimization_task
    assert task_manager.started["task_type"] == "optimization"
    assert task_manager.started["metadata"]["target_name"] == "total_return"


def test_strategy_manager_should_reject_unknown_run_mode() -> None:
    """验证非法运行模式会被拒绝。"""

    manager = _make_manager()

    with pytest.raises(ValueError, match="不支持的回测运行模式"):
        manager.start_backtesting(_make_request(), run_mode="bad")  # type: ignore[arg-type]


def test_strategy_manager_should_keep_paper_and_live_placeholders() -> None:
    """验证模拟盘和实盘入口当前仅作为占位。"""

    manager = _make_manager()

    with pytest.raises(NotImplementedError, match="模拟盘"):
        manager.start_paper_trading()
    with pytest.raises(NotImplementedError, match="实盘"):
        manager.start_live_trading()
