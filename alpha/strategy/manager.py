"""Alpha 策略发现、回测调度和任务结果管理。"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from threading import RLock, Thread
from typing import Callable, Literal

from loguru import logger

from alpha.backtest.data import BacktestDataScope
from alpha.backtest.runner import (
    BacktestJobSpec,
    build_common_task_metadata,
    run_backtest_job,
    run_backtest_task,
    run_optimization_job,
    run_optimization_task,
    wrap_get_target_value,
)
from alpha.backtest.optimize import (
    OptimizationSetting,
    check_optimization_setting,
)
from alpha.common.schema_backtest import BacktestReq
from alpha.common.schema_core import (
    EVENT_BACKTESTER_BACKTESTING_FINISHED,
    EVENT_BACKTESTER_OPTIMIZATION_FINISHED,
    EVENT_LOG,
)
from alpha.common.schema_trade import LogData
from alpha.runtime.event import Event, EventEngine
from alpha.runtime.processes import ProcessTaskManager, TaskStatus
from alpha.strategy.loader import StrategyLoader
from alpha.utils import StrategyResult


RunMode = Literal["inline", "thread", "process"]
OUTPUT_FUNC = Callable[[object], None]


@dataclass
class LocalStrategyTask:
    """本地线程或同步任务运行态。"""

    task_id: str
    task_type: str
    run_mode: RunMode
    name: str = ""
    metadata: dict[str, object] = field(default_factory=dict)
    status: TaskStatus = TaskStatus.RUNNING
    result: object | None = None
    error: str | None = None
    logs: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    finished_at: datetime | None = None

    def snapshot(self) -> dict[str, object]:
        """返回接口展示所需的任务快照。

        Args:
            无。

        Returns:
            任务运行态字典。
        """

        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "run_mode": self.run_mode,
            "name": self.name,
            "metadata": self.metadata,
            "status": self.status.value,
            "pid": None,
            "exitcode": None,
            "error": self.error,
            "logs": self.logs[-20:],
            "created_at": self.created_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


class StrategyManager:
    """管理策略加载、回测调度和结果查询。"""

    def __init__(
        self,
        event_engine: EventEngine,
        database_dir: Path,
        task_manager: ProcessTaskManager | None = None,
    ) -> None:
        """初始化策略管理器。

        Args:
            event_engine: 事件引擎
            database_dir: 回测任务读取的数据库目录。
            task_manager: 全局进程任务管理器
        """
        self.event_engine = event_engine
        self.database_dir = database_dir
        self.loader = StrategyLoader()
        self.task_manager = task_manager or ProcessTaskManager()
        self._local_tasks: dict[str, LocalStrategyTask] = {}
        self._local_task_lock = RLock()
        self.load_strategy_class()

    @property
    def classes(self) -> dict:
        """返回已加载策略类映射。"""
        return self.loader.classes

    @property
    def class_info(self) -> dict:
        """返回策略类说明信息。"""
        return self.loader.class_info

    def load_strategy_class(self) -> bool:
        """刷新并加载策略类。"""
        result = self.loader.load_from_default_folder()
        self.write_log("策略文件刷新完成")
        self._log_loader_errors()
        return result

    def _log_loader_errors(self) -> None:
        """输出策略加载失败日志。"""
        for key, info in self.class_info.items():
            if not key.startswith("load_error::"):
                continue
            error_message = info.get("error", "未知错误")
            self.write_log(f"策略模块加载失败: {error_message}")

    def put_event(self, event_type: str, data: object | None = None) -> None:
        """投递事件。

        Args:
            event_type: 事件类型
            data: 事件数据
        """
        event = Event(type=event_type, data=data)
        self.event_engine.put(event)
        logger.info(f"event_type: {event_type}, data: {data}")

    def write_log(self, msg: str) -> None:
        """写入策略模块日志。

        Args:
            msg: 日志文本
        """
        log = LogData(msg=msg, gateway_name="策略引擎")
        self.put_event(EVENT_LOG, log)

    def get_strategy_class(self) -> dict:
        """获取策略类信息。"""
        return self.class_info

    def get_status_dict(self) -> dict:
        """获取所有策略任务状态。"""
        process_snapshots = self.task_manager.list_snapshots()
        status = {str(snapshot["task_id"]): snapshot for snapshot in process_snapshots}

        with self._local_task_lock:
            for task in self._local_tasks.values():
                status[task.task_id] = task.snapshot()

        return status

    def _build_job_spec(self, bt_req: BacktestReq) -> BacktestJobSpec:
        """构建回测任务配置。

        Args:
            bt_req: 回测请求

        Returns:
            回测任务配置。
        """
        if bt_req.class_name not in self.classes:
            self.load_strategy_class()

        strategy_class = self.classes[bt_req.class_name]
        data_scope = BacktestDataScope(
            vt_symbols=bt_req.vt_symbols,
            product=bt_req.product,
            interval=bt_req.interval,
            start=bt_req.start,
            end=bt_req.end,
            price_adjust=bt_req.price_adjust,
        )
        return BacktestJobSpec(
            instance_name=bt_req.hash_name,
            strategy_class=strategy_class,
            data_scope=data_scope,
            capital=bt_req.capital,
            database_dir=self.database_dir,
        )

    def _build_backtesting_metadata(
        self,
        spec: BacktestJobSpec,
        param_setting: dict[str, object],
    ) -> dict[str, object]:
        """构建单次回测任务元数据。

        Args:
            spec: 回测任务配置。
            param_setting: 策略参数。

        Returns:
            任务元数据。
        """

        return {
            **build_common_task_metadata(spec),
            "strategy_name": spec.strategy_class.__name__,
            "parameters": param_setting,
        }

    def _save_backtesting_result(
        self,
        bt_req: BacktestReq,
        result: dict[str, object],
    ) -> None:
        """保存单次回测结果。

        Args:
            bt_req: 回测请求。
            result: 回测结果。

        Returns:
            无返回值。
        """

        backtest_req_dict = bt_req.model_dump(mode="json")
        backtest_req_dict["hash_name"] = bt_req.hash_name

        StrategyResult.save_strategy_result(
            bt_req.hash_name,
            {
                "backtest_req": backtest_req_dict,
                "status": None,
                "result": result,
            },
        )

    def _execute_backtesting(
        self,
        bt_req: BacktestReq,
        spec: BacktestJobSpec,
        output: OUTPUT_FUNC | None = None,
    ) -> dict[str, object]:
        """同步执行一次回测并保存结果。

        Args:
            bt_req: 回测请求。
            spec: 回测任务配置。
            output: 回测日志输出函数。

        Returns:
            回测结果。
        """

        result = run_backtest_job(spec, bt_req.param_setting, output=output)
        self._save_backtesting_result(bt_req, result)
        self.put_event(EVENT_BACKTESTER_BACKTESTING_FINISHED, bt_req.hash_name)
        return result

    def _start_backtesting_process(
        self,
        bt_req: BacktestReq,
        spec: BacktestJobSpec,
        metadata: dict[str, object],
    ) -> str:
        """使用子进程启动回测任务。

        Args:
            bt_req: 回测请求。
            spec: 回测任务配置。
            metadata: 任务元数据。

        Returns:
            任务标识。
        """

        try:
            task_id = bt_req.hash_name
            self.task_manager.start(
                task_id,
                "backtest",
                run_backtest_task,
                args=(
                    spec,
                    bt_req.param_setting,
                ),
                name=f"回测-{spec.instance_name}",
                metadata=metadata,
            )
            Thread(
                target=self._watch_backtesting_process,
                args=(bt_req,),
                daemon=True,
            ).start()
            return task_id
        except Exception as exc:
            task = self.task_manager.get(bt_req.hash_name)
            if task and not task.process.is_alive():
                self.task_manager.mark_error(bt_req.hash_name, str(exc))
            self.write_log(f"回测任务执行失败: {exc}")
            raise

    def _watch_backtesting_process(self, bt_req: BacktestReq) -> None:
        """等待子进程回测结果并保存。

        Args:
            bt_req: 回测请求。

        Returns:
            无返回值。
        """

        try:
            result = self.task_manager.wait_result(bt_req.hash_name)
            if not isinstance(result, dict):
                raise RuntimeError("回测任务返回结果格式错误")

            self._save_backtesting_result(bt_req, result)
            self.put_event(EVENT_BACKTESTER_BACKTESTING_FINISHED, bt_req.hash_name)
        except Exception as exc:
            task = self.task_manager.get(bt_req.hash_name)
            if task and not task.process.is_alive():
                self.task_manager.mark_error(bt_req.hash_name, str(exc))
            self.write_log(f"回测任务执行失败: {exc}")

    def _register_local_task(
        self,
        task_id: str,
        task_type: str,
        run_mode: RunMode,
        name: str,
        metadata: dict[str, object],
    ) -> LocalStrategyTask:
        """登记本地任务状态。

        Args:
            task_id: 任务标识。
            task_type: 任务类型。
            run_mode: 运行模式。
            name: 展示名称。
            metadata: 任务元数据。

        Returns:
            本地任务运行态。

        Raises:
            ValueError: 任务标识重复。
        """

        with self._local_task_lock:
            task = self._local_tasks.get(task_id)
            if task and task.status == TaskStatus.RUNNING:
                raise ValueError(f"任务仍在运行: {task_id}")

            task = LocalStrategyTask(
                task_id=task_id,
                task_type=task_type,
                run_mode=run_mode,
                name=name,
                metadata=metadata,
            )
            self._local_tasks[task_id] = task
            return task

    def _build_local_output(self, task_id: str) -> OUTPUT_FUNC:
        """构建本地任务日志收集函数。

        Args:
            task_id: 任务标识。

        Returns:
            日志输出函数。
        """

        def output(msg: object) -> None:
            """记录本地任务日志。"""

            with self._local_task_lock:
                task = self._local_tasks.get(task_id)
                if task:
                    task.logs.append(str(msg))

        return output

    def _finish_local_task_success(self, task_id: str, result: object) -> None:
        """标记本地任务成功。

        Args:
            task_id: 任务标识。
            result: 任务结果。

        Returns:
            无返回值。
        """

        with self._local_task_lock:
            task = self._local_tasks.get(task_id)
            if task:
                task.result = result
                task.status = TaskStatus.SUCCEEDED
                task.finished_at = datetime.now()

    def _finish_local_task_error(self, task_id: str, exc: Exception) -> None:
        """标记本地任务失败。

        Args:
            task_id: 任务标识。
            exc: 任务异常。

        Returns:
            无返回值。
        """

        with self._local_task_lock:
            task = self._local_tasks.get(task_id)
            if task:
                task.error = str(exc)
                task.status = TaskStatus.FAILED
                task.finished_at = datetime.now()

    def _execute_local_task(
        self,
        task_id: str,
        run_func: Callable[[OUTPUT_FUNC], object],
        error_prefix: str,
    ) -> object:
        """执行本地任务并更新状态。

        Args:
            task_id: 任务标识。
            run_func: 接收日志输出函数并返回任务结果的同步业务函数。
            error_prefix: 失败日志前缀。

        Returns:
            任务结果。

        Raises:
            Exception: 原样抛出业务函数异常，便于 inline 模式调试。
        """

        try:
            result = run_func(self._build_local_output(task_id))
            self._finish_local_task_success(task_id, result)
            return result
        except Exception as exc:
            self._finish_local_task_error(task_id, exc)
            self.write_log(f"{error_prefix}: {exc}")
            raise

    def _run_local_task(
        self,
        task_id: str,
        run_func: Callable[[OUTPUT_FUNC], object],
        error_prefix: str,
    ) -> None:
        """在线程中执行本地任务。

        Args:
            task_id: 任务标识。
            run_func: 接收日志输出函数并返回任务结果的同步业务函数。
            error_prefix: 失败日志前缀。

        Returns:
            无返回值。
        """

        try:
            self._execute_local_task(task_id, run_func, error_prefix)
        except Exception:
            return

    def _start_local_task(
        self,
        task_id: str,
        task_type: str,
        run_mode: RunMode,
        name: str,
        metadata: dict[str, object],
        run_func: Callable[[OUTPUT_FUNC], object],
        error_prefix: str,
    ) -> str:
        """使用 inline 或 thread 模式启动本地任务。

        Args:
            task_id: 任务标识。
            task_type: 任务类型。
            run_mode: 运行模式。
            name: 展示名称。
            metadata: 任务元数据。
            run_func: 接收日志输出函数并返回任务结果的同步业务函数。
            error_prefix: 失败日志前缀。

        Returns:
            任务标识。
        """

        self._register_local_task(
            task_id,
            task_type,
            run_mode,
            name,
            metadata,
        )

        if run_mode == "thread":
            Thread(
                target=self._run_local_task,
                args=(task_id, run_func, error_prefix),
                daemon=True,
            ).start()
            return task_id

        self._execute_local_task(task_id, run_func, error_prefix)
        return task_id

    def start_backtesting(
        self,
        bt_req: BacktestReq,
        run_mode: RunMode = "process",
    ) -> str:
        """启动回测任务。

        Args:
            bt_req: 回测请求。
            run_mode: 运行模式，inline 用于调试，thread 用于轻量异步，
                process 用于正式长任务。

        Returns:
            任务标识。

        Raises:
            ValueError: 运行模式非法。
        """

        spec = self._build_job_spec(bt_req)
        metadata = self._build_backtesting_metadata(spec, bt_req.param_setting)

        if run_mode == "process":
            return self._start_backtesting_process(bt_req, spec, metadata)
        if run_mode in {"inline", "thread"}:
            return self._start_local_task(
                bt_req.hash_name,
                "backtest",
                run_mode,
                f"回测-{spec.instance_name}",
                metadata,
                lambda output: self._execute_backtesting(bt_req, spec, output=output),
                "回测任务执行失败",
            )

        raise ValueError(f"不支持的回测运行模式: {run_mode}")

    def start_paper_trading(self) -> str:
        """预留模拟盘启动入口。

        Args:
            无。

        Returns:
            任务标识。

        Raises:
            NotImplementedError: 模拟盘尚未接入。
        """

        raise NotImplementedError("模拟盘运行入口尚未实现")

    def start_live_trading(self) -> str:
        """预留实盘启动入口。

        Args:
            无。

        Returns:
            任务标识。

        Raises:
            NotImplementedError: 实盘尚未接入。
        """

        raise NotImplementedError("实盘运行入口尚未实现")

    def _build_optimization_setting(
        self,
        bt_req: BacktestReq,
    ) -> OptimizationSetting:
        """构建参数优化配置。

        Args:
            bt_req: 回测请求

        Returns:
            参数优化配置对象
        """
        optimization_setting = OptimizationSetting()
        for name, paras in bt_req.optimization_setting.items():
            start_value = paras.get("start")
            step_value = paras.get("step")
            end_value = paras.get("end")

            if start_value == end_value:
                optimization_setting.add_parameter(name, start_value)
            else:
                optimization_setting.add_parameter(
                    name,
                    start_value,
                    end_value,
                    step_value,
                )
        optimization_setting.set_target(bt_req.target_name or "total_return")
        return optimization_setting

    def _build_optimization_metadata(
        self,
        spec: BacktestJobSpec,
        optimization_setting: OptimizationSetting,
        optimization_mode: Literal["bf", "ga"],
        max_workers: int | None,
    ) -> dict[str, object]:
        """构建参数优化任务元数据。

        Args:
            spec: 回测任务配置。
            optimization_setting: 参数优化配置。
            optimization_mode: 优化模式。
            max_workers: 最大工作进程数。

        Returns:
            任务元数据。
        """

        return {
            **build_common_task_metadata(spec),
            "strategy_name": spec.strategy_class.__name__,
            "optimization_mode": optimization_mode,
            "target_name": optimization_setting.target_name,
            "settings_count": len(optimization_setting.generate_settings()),
            "max_workers": max_workers,
        }

    def _write_optimization_results(
        self,
        optimization_setting: OptimizationSetting,
        results: list[dict[str, object]],
    ) -> None:
        """输出参数优化结果摘要。

        Args:
            optimization_setting: 参数优化配置。
            results: 参数优化结果。

        Returns:
            无返回值。
        """

        target_value_getter = wrap_get_target_value(optimization_setting.target_name)
        for result in results:
            self.write_log(
                "Parameters: "
                f"{result['param_settings']}, "
                f"Target Value: {target_value_getter(result)}"
            )

    def _execute_optimization(
        self,
        spec: BacktestJobSpec,
        optimization_setting: OptimizationSetting,
        optimization_mode: Literal["bf", "ga"],
        max_workers: int | None,
        output: OUTPUT_FUNC | None = None,
    ) -> list[dict[str, object]]:
        """同步执行参数优化并发布完成事件。

        Args:
            spec: 回测任务配置。
            optimization_setting: 参数优化配置。
            optimization_mode: 优化模式。
            max_workers: 最大工作进程数。
            output: 日志输出函数。

        Returns:
            参数优化结果列表。
        """

        results = run_optimization_job(
            spec,
            optimization_setting,
            optimization_mode,
            max_workers=max_workers,
            output=output,
        )
        self._write_optimization_results(optimization_setting, results)
        self.put_event(EVENT_BACKTESTER_OPTIMIZATION_FINISHED)
        return results

    def _start_optimization_process(
        self,
        bt_req: BacktestReq,
        spec: BacktestJobSpec,
        optimization_setting: OptimizationSetting,
        optimization_mode: Literal["bf", "ga"],
        max_workers: int | None,
        metadata: dict[str, object],
    ) -> str:
        """使用子进程启动参数优化任务。

        Args:
            bt_req: 回测请求。
            spec: 回测任务配置。
            optimization_setting: 参数优化配置。
            optimization_mode: 优化模式。
            max_workers: 最大工作进程数。
            metadata: 任务元数据。

        Returns:
            任务标识。
        """

        try:
            task_id = bt_req.hash_name
            self.task_manager.start(
                task_id,
                "optimization",
                run_optimization_task,
                args=(
                    spec,
                    optimization_setting,
                    optimization_mode,
                    max_workers,
                ),
                name=f"参数优化-{spec.instance_name}",
                metadata=metadata,
            )
            Thread(
                target=self._watch_optimization_process,
                args=(bt_req, optimization_setting),
                daemon=True,
            ).start()
            return task_id
        except Exception as exc:
            task = self.task_manager.get(bt_req.hash_name)
            if task and not task.process.is_alive():
                self.task_manager.mark_error(bt_req.hash_name, str(exc))
            self.write_log(f"参数优化任务执行失败: {exc}")
            raise

    def _watch_optimization_process(
        self,
        bt_req: BacktestReq,
        optimization_setting: OptimizationSetting,
    ) -> None:
        """等待子进程参数优化结果并发布完成事件。

        Args:
            bt_req: 回测请求。
            optimization_setting: 参数优化配置。

        Returns:
            无返回值。
        """

        try:
            results = self.task_manager.wait_result(bt_req.hash_name)
            if not isinstance(results, list):
                raise RuntimeError("参数优化任务返回结果格式错误")

            self._write_optimization_results(optimization_setting, results)
            self.put_event(EVENT_BACKTESTER_OPTIMIZATION_FINISHED)
        except Exception as exc:
            task = self.task_manager.get(bt_req.hash_name)
            if task and not task.process.is_alive():
                self.task_manager.mark_error(bt_req.hash_name, str(exc))
            self.write_log(f"参数优化任务执行失败: {exc}")

    def start_optimization(
        self,
        bt_req: BacktestReq,
        run_mode: RunMode = "process",
    ) -> str:
        """启动参数优化任务。

        Args:
            bt_req: 回测请求。
            run_mode: 运行模式，inline 用于调试，thread 用于轻量异步，
                process 用于正式长任务。

        Returns:
            任务标识。

        Raises:
            ValueError: 参数优化配置无效或运行模式非法。
        """

        spec = self._build_job_spec(bt_req)
        optimization_setting = self._build_optimization_setting(bt_req)
        if not check_optimization_setting(optimization_setting, self.write_log):
            raise ValueError("参数优化配置无效")

        max_workers = None if bt_req.max_workers == 0 else bt_req.max_workers
        optimization_mode: Literal["bf", "ga"] = (
            "ga" if bt_req.bt_type == "ga_optimization" else "bf"
        )
        metadata = self._build_optimization_metadata(
            spec,
            optimization_setting,
            optimization_mode,
            max_workers,
        )

        if run_mode == "process":
            return self._start_optimization_process(
                bt_req,
                spec,
                optimization_setting,
                optimization_mode,
                max_workers,
                metadata,
            )

        if run_mode in {"inline", "thread"}:
            return self._start_local_task(
                bt_req.hash_name,
                "optimization",
                run_mode,
                f"参数优化-{spec.instance_name}",
                metadata,
                lambda output: self._execute_optimization(
                    spec,
                    optimization_setting,
                    optimization_mode,
                    max_workers,
                    output=output,
                ),
                "参数优化任务执行失败",
            )

        raise ValueError(f"不支持的参数优化运行模式: {run_mode}")

    def get_all_strategy_result_info(self) -> dict[str, dict]:
        """获取全部策略结果概要。"""
        return StrategyResult.get_strategy_result_info()

    def get_strategy_result(self, hash_name: str) -> dict:
        """获取指定策略结果。"""
        return StrategyResult.get_strategy_result(hash_name)

    def delete_strategy_result(self, hash_name: str) -> bool:
        """删除指定策略结果。"""
        return StrategyResult.delete_strategy_result(hash_name)
