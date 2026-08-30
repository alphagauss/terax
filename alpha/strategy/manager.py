"""Alpha 策略发现、回测调度和任务结果管理。"""

from pathlib import Path
from typing import Literal

from loguru import logger

from alpha.backtest.data import BacktestDataScope
from alpha.backtest.runner import (
    BacktestJobSpec,
    build_common_task_metadata,
    run_backtest_task,
    run_optimization_task,
    wrap_get_target_value,
)
from alpha.backtest.optimize import (
    OptimizationSetting,
    check_optimization_setting,
)
from alpha.common.schema_backtest import BacktestReq
from alpha.common.schema_trade import LogData
from alpha.runtime.event import Event, EventEngine
from alpha.runtime.event_types import EVENT_LOG
from alpha.runtime.processes import TaskManager
from alpha.strategy.loader import StrategyLoader
from alpha.utils import StrategyResult


class StrategyManager:
    """管理策略加载、回测调度和结果查询。"""

    def __init__(
        self,
        event_engine: EventEngine,
        database_dir: Path,
        task_manager: TaskManager,
    ) -> None:
        """初始化策略管理器。

        Args:
            event_engine: 事件引擎
            database_dir: 回测任务读取的数据库目录。
            task_manager: 全局有限任务管理器。
        """
        self.event_engine = event_engine
        self.database_dir = database_dir
        self.loader = StrategyLoader()
        self.task_manager = task_manager
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
        return {
            str(snapshot["task_id"]): snapshot
            for snapshot in self.task_manager.list_snapshots()
            if snapshot.get("kind") in {"backtest", "optimization"}
        }

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
                result_handler=lambda result: self._commit_backtesting_result(
                    bt_req,
                    result,
                ),
            )
            return task_id
        except Exception as exc:
            task = self.task_manager.get(bt_req.hash_name)
            if task and not task.process.is_alive():
                self.task_manager.mark_error(bt_req.hash_name, str(exc))
            self.write_log(f"回测任务执行失败: {exc}")
            raise

    def _commit_backtesting_result(
        self,
        bt_req: BacktestReq,
        result: object,
    ) -> None:
        """校验并持久化子进程结果，成功事件只会在本方法返回后发布。"""

        if not isinstance(result, dict):
            raise RuntimeError("回测任务返回结果格式错误")
        self._save_backtesting_result(bt_req, result)

    def start_backtesting(
        self,
        bt_req: BacktestReq,
    ) -> str:
        """启动回测任务。

        Args:
            bt_req: 回测请求。
        Returns:
            任务标识。
        """

        spec = self._build_job_spec(bt_req)
        metadata = self._build_backtesting_metadata(spec, bt_req.param_setting)

        return self._start_backtesting_process(bt_req, spec, metadata)

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
                result_handler=lambda result: self._commit_optimization_result(
                    optimization_setting,
                    result,
                ),
            )
            return task_id
        except Exception as exc:
            task = self.task_manager.get(bt_req.hash_name)
            if task and not task.process.is_alive():
                self.task_manager.mark_error(bt_req.hash_name, str(exc))
            self.write_log(f"参数优化任务执行失败: {exc}")
            raise

    def _commit_optimization_result(
        self,
        optimization_setting: OptimizationSetting,
        result: object,
    ) -> None:
        """校验并提交参数优化结果摘要。"""

        if not isinstance(result, list):
            raise RuntimeError("参数优化任务返回结果格式错误")
        self._write_optimization_results(optimization_setting, result)

    def start_optimization(
        self,
        bt_req: BacktestReq,
    ) -> str:
        """启动参数优化任务。

        Args:
            bt_req: 回测请求。
        Returns:
            任务标识。

        Raises:
            ValueError: 参数优化配置无效。
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

        return self._start_optimization_process(
            bt_req,
            spec,
            optimization_setting,
            optimization_mode,
            max_workers,
            metadata,
        )

    def get_all_strategy_result_info(self) -> dict[str, dict]:
        """获取全部策略结果概要。"""
        return StrategyResult.get_strategy_result_info()

    def get_strategy_result(self, hash_name: str) -> dict:
        """获取指定策略结果。"""
        return StrategyResult.get_strategy_result(hash_name)

    def delete_strategy_result(self, hash_name: str) -> bool:
        """删除指定策略结果。"""
        return StrategyResult.delete_strategy_result(hash_name)
