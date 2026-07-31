"""Alpha 回测与参数优化任务的可序列化执行入口。"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from functools import partial
from pathlib import Path
from typing import Callable, Literal

from pandas import DataFrame

from alpha.backtest.analysis import Analysis
from alpha.backtest.backtesting import BackTesting
from alpha.backtest.data import BacktestDataScope, BacktestInput, load_backtest_input
from alpha.backtest.optimize import (
    OptimizationSetting,
    run_bf_optimization,
    run_ga_optimization,
)
from alpha.backtest.template import StrategyTemplate
from alpha.common.schema_trade import OrderData, TradeData
from alpha.runtime.processes import ProcessMessagePublisher
from alpha.storage.database import DataBase


OUTPUT_FUNC = Callable[[object], None]


@dataclass(frozen=True)
class BacktestJobSpec:
    """单次回测任务配置。

    Args:
        instance_name: 策略实例名称。
        strategy_class: 策略类，必须是可被 multiprocessing spawn 序列化的顶层类。
        data_scope: 本次任务需要的数据范围。
        capital: 初始资金。
        database_dir: 子进程读取的数据库目录。
        risk_free: 年化无风险利率。
        annual_days: 年化交易日数量。
    """

    instance_name: str
    strategy_class: type[StrategyTemplate]
    data_scope: BacktestDataScope
    capital: int
    database_dir: Path
    risk_free: float = 0
    annual_days: int = 240


async def load_backtest_input_for_job(spec: BacktestJobSpec) -> BacktestInput:
    """按任务配置创建数据库并加载回测输入。

    Args:
        spec: 回测任务配置。

    Returns:
        已归一化的回测输入。
    """

    db = DataBase(spec.database_dir)
    try:
        return await load_backtest_input(db, spec.data_scope)
    finally:
        await db.close()


def run_backtest_with_input(
    spec: BacktestJobSpec,
    backtest_input: BacktestInput,
    param_setting: dict[str, object],
    output: OUTPUT_FUNC | None = None,
) -> dict[str, object]:
    """使用已加载输入同步执行一次回测。

    Args:
        spec: 回测任务配置。
        backtest_input: 已归一化的回测输入。
        param_setting: 策略参数。
        output: 日志输出函数。

    Returns:
        包含参数、成交、订单、每日结果和统计指标的回测结果。

    Raises:
        RuntimeError: 回测引擎记录到策略执行失败。
    """

    output_func = output or (lambda _msg: None)

    engine = BackTesting()
    engine.output = output_func
    engine.set_parameters(
        interval=spec.data_scope.interval,
        start=spec.data_scope.start,
        end=spec.data_scope.end,
        capital=spec.capital,
        price_adjust=spec.data_scope.price_adjust,
        risk_free=spec.risk_free,
        annual_days=spec.annual_days,
    )
    engine.load_input(backtest_input)
    engine.add_strategy(spec.strategy_class, spec.instance_name)

    engine.run_backtesting(param_setting)
    if engine.failed:
        raise RuntimeError(engine.error or "回测执行失败")

    daily_results = engine.get_daily_result()
    trades: list[TradeData] = engine.get_all_trades()
    orders: list[OrderData] = engine.get_all_orders()

    analysis = Analysis(
        daily_results,
        output=output_func,
        capital=spec.capital,
        annual_days=spec.annual_days,
        risk_free=spec.risk_free,
    )
    daily_with_statistics = analysis.calculate_dalily(returns=True)
    statistics = analysis.calculate_statistics()

    return {
        "param_settings": param_setting,
        "trades": [asdict(trade) for trade in trades],
        "orders": [asdict(order) for order in orders],
        "daily_results": _to_records(daily_with_statistics),
        "statistics": statistics,
    }


def run_backtest_job(
    spec: BacktestJobSpec,
    param_setting: dict[str, object],
    output: OUTPUT_FUNC | None = None,
) -> dict[str, object]:
    """按任务配置加载数据并同步执行一次回测。

    Args:
        spec: 回测任务配置。
        param_setting: 策略参数。
        output: 日志输出函数。

    Returns:
        回测结果字典。
    """

    backtest_input = asyncio.run(load_backtest_input_for_job(spec))
    return run_backtest_with_input(spec, backtest_input, param_setting, output=output)


def run_optimization_with_input(
    spec: BacktestJobSpec,
    backtest_input: BacktestInput,
    optimization_setting: OptimizationSetting,
    optimization_mode: Literal["bf", "ga"],
    max_workers: int | None = None,
    population_size: int = 100,
    ngen_size: int = 30,
    output: OUTPUT_FUNC | None = None,
) -> list[dict[str, object]]:
    """使用已加载输入同步执行参数优化。

    Args:
        spec: 回测任务配置。
        backtest_input: 已归一化的回测输入。
        optimization_setting: 参数优化配置。
        optimization_mode: 优化模式，bf 表示穷举，ga 表示遗传算法。
        max_workers: 优化内部最大工作进程数。
        population_size: 遗传算法每代族群数量。
        ngen_size: 遗传算法迭代代数。
        output: 日志输出函数。

    Returns:
        按优化目标降序排列的回测结果列表。
    """

    output_func = output or (lambda _msg: None)
    evaluate_func = partial(run_backtest_with_input, spec, backtest_input)
    target_value_getter = wrap_get_target_value(optimization_setting.target_name)

    if optimization_mode == "ga":
        return run_ga_optimization(
            evaluate_func,
            optimization_setting,
            target_value_getter,
            max_workers=max_workers,
            population_size=population_size,
            ngen_size=ngen_size,
            output=output_func,
        )

    return run_bf_optimization(
        evaluate_func,
        optimization_setting,
        target_value_getter,
        max_workers=max_workers,
        output=output_func,
    )


def run_optimization_job(
    spec: BacktestJobSpec,
    optimization_setting: OptimizationSetting,
    optimization_mode: Literal["bf", "ga"],
    max_workers: int | None = None,
    population_size: int = 100,
    ngen_size: int = 30,
    output: OUTPUT_FUNC | None = None,
) -> list[dict[str, object]]:
    """按任务配置加载数据并同步执行参数优化。

    Args:
        spec: 回测任务配置。
        optimization_setting: 参数优化配置。
        optimization_mode: 优化模式。
        max_workers: 优化内部最大工作进程数。
        population_size: 遗传算法每代族群数量。
        ngen_size: 遗传算法迭代代数。
        output: 日志输出函数。

    Returns:
        参数优化结果列表。
    """

    backtest_input = asyncio.run(load_backtest_input_for_job(spec))
    return run_optimization_with_input(
        spec,
        backtest_input,
        optimization_setting,
        optimization_mode,
        max_workers=max_workers,
        population_size=population_size,
        ngen_size=ngen_size,
        output=output,
    )


def run_backtest_task(
    spec: BacktestJobSpec,
    param_setting: dict[str, object],
    publisher: ProcessMessagePublisher | None = None,
) -> dict[str, object]:
    """进程任务入口：执行单次回测。

    Args:
        spec: 回测任务配置。
        param_setting: 策略参数。
        publisher: 子进程消息发布器。

    Returns:
        回测结果。
    """

    output = publisher.log if publisher else None
    return run_backtest_job(spec, param_setting, output=output)


def run_optimization_task(
    spec: BacktestJobSpec,
    optimization_setting: OptimizationSetting,
    optimization_mode: Literal["bf", "ga"],
    max_workers: int | None = None,
    population_size: int = 100,
    ngen_size: int = 30,
    publisher: ProcessMessagePublisher | None = None,
) -> list[dict[str, object]]:
    """进程任务入口：执行参数优化。

    Args:
        spec: 回测任务配置。
        optimization_setting: 参数优化配置。
        optimization_mode: 优化模式。
        max_workers: 优化内部最大工作进程数。
        population_size: 遗传算法每代族群数量。
        ngen_size: 遗传算法迭代代数。
        publisher: 子进程消息发布器。

    Returns:
        优化结果列表。
    """

    output = publisher.log if publisher else None
    return run_optimization_job(
        spec,
        optimization_setting,
        optimization_mode,
        max_workers=max_workers,
        population_size=population_size,
        ngen_size=ngen_size,
        output=output,
    )


def build_common_task_metadata(spec: BacktestJobSpec) -> dict[str, object]:
    """构建回测类任务公共元数据。

    Args:
        spec: 回测任务配置。

    Returns:
        公共任务元数据。
    """

    scope = spec.data_scope
    return {
        "vt_symbols": list(scope.vt_symbols),
        "interval": scope.interval.value,
        "start": scope.start.isoformat(),
        "end": scope.end.isoformat(),
        "capital": spec.capital,
        "price_adjust": scope.price_adjust,
        "risk_free": spec.risk_free,
        "annual_days": spec.annual_days,
    }


def wrap_get_target_value(target_name: str) -> Callable[[dict[str, object]], float]:
    """包装优化目标提取函数。

    Args:
        target_name: 统计指标中的优化目标字段名。

    Returns:
        从回测结果中提取目标值的函数。

    Raises:
        KeyError: 回测结果中不存在目标字段。
    """

    def get_target_value(result: dict[str, object]) -> float:
        """从回测结果中提取优化目标值。"""

        statistics = result.get("statistics", {})
        if not isinstance(statistics, dict):
            raise KeyError(f"回测结果中缺少优化目标: {target_name}")
        value = statistics.get(target_name)
        if value is None:
            raise KeyError(f"回测结果中缺少优化目标: {target_name}")
        return float(value)

    return get_target_value


def _to_records(data: DataFrame | list[dict] | None) -> list[dict]:
    """将分析结果转换为可序列化列表。

    Args:
        data: DataFrame、记录列表或空值。

    Returns:
        可 JSON 序列化的记录列表。
    """

    if isinstance(data, DataFrame):
        return data.to_dict("records")
    if isinstance(data, list):
        return data
    return []
