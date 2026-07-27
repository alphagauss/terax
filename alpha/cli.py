"""Alpha 业务命令行工具。"""

from __future__ import annotations

import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Annotated, Literal

import typer

from alpha.common.schema_backtest import BacktestReq


app = typer.Typer(
    name="alpha",
    context_settings={"help_option_names": ["-h", "--help"]},
    help="alpha 量化业务工具",
    no_args_is_help=True,
)


def _json_default(value: object) -> str:
    """将非 JSON 原生对象转换为字符串。

    Args:
        value: 待序列化对象。

    Returns:
        对象的字符串表示。
    """

    return str(value)


def _echo_payload(payload: object) -> None:
    """以 JSON 形式输出命令结果。

    Args:
        payload: 命令结果对象。

    Returns:
        无返回值。
    """

    typer.echo(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            default=_json_default,
        )
    )


def _build_data_overview(rows: list[dict[str, object]]) -> dict[str, object]:
    """构建命令行行情概览输出。

    Args:
        rows: `DataBase.get_bar_overview()` 返回的 K 线概览行。

    Returns:
        包含 K 线总行数和原始概览行的输出字典。
    """

    total_bar_count = 0
    for row in rows:
        count = row.get("count", 0)
        if isinstance(count, int):
            total_bar_count += count
    return {"total_bar_count": total_bar_count, "bar_overview": rows}


def _build_strategy_list(
    strategy_classes: dict[str, dict[str, object]],
) -> list[dict[str, object]]:
    """构建命令行策略列表输出。

    Args:
        strategy_classes: 策略管理器返回的策略类元数据映射。

    Returns:
        已过滤加载错误条目的策略信息列表。
    """

    strategies: list[dict[str, object]] = []
    for name, metadata in sorted(strategy_classes.items()):
        if name.startswith("load_error::"):
            continue
        strategies.append({"name": name, "metadata": metadata})
    return strategies


def _parse_trade_date(value: str | None) -> date | None:
    """解析可选交易日参数。

    Args:
        value: ``YYYY-MM-DD`` 格式交易日字符串；为空表示自动推导。

    Returns:
        解析后的日期或 None。
    """

    if value is None:
        return None
    return date.fromisoformat(value)


@app.command("list-strategies")
def list_strategies() -> None:
    """列出已加载策略。"""

    from alpha.api.container import create_alpha_service_container

    container = create_alpha_service_container()
    try:
        _echo_payload(
            _build_strategy_list(container.strategy_manager.get_strategy_class())
        )
    finally:
        asyncio.run(container.close())


@app.command("run-backtest")
def run_backtest(
    request_file: Annotated[
        Path,
        typer.Argument(
            exists=True,
            file_okay=True,
            dir_okay=False,
            readable=True,
            help="包含 BacktestReq JSON 的文件路径。",
        ),
    ],
) -> None:
    """按 JSON 请求启动回测任务。"""

    from alpha.api.container import create_alpha_service_container

    request = BacktestReq.model_validate_json(
        request_file.read_text(encoding="utf-8")
    )
    container = create_alpha_service_container()
    try:
        task_id = container.strategy_manager.start_backtesting(request)
        _echo_payload({"task_id": task_id})
    finally:
        asyncio.run(container.close())


@app.command("check-db")
def check_db() -> None:
    """检查本地行情数据库概览。"""

    from alpha.storage.database import DataBase

    async def run() -> None:
        """执行数据库检查并输出结果。

        Args:
            无。

        Returns:
            无返回值。
        """

        database = DataBase()
        try:
            _echo_payload(_build_data_overview(await database.get_bar_overview()))
        finally:
            await database.close()

    asyncio.run(run())


@app.command("sync-security")
def sync_security(
    mode: Annotated[
        Literal[
            "by-symbol",
            "by-date",
            "refresh-symbol-infos",
            "refresh-symbols-snapshot",
        ],
        typer.Option("--mode", help="证券状态同步模式。"),
    ] = "by-symbol",
    target_trade_date: Annotated[
        str | None,
        typer.Option("--target-trade-date", help="目标交易日，格式 YYYY-MM-DD。"),
    ] = None,
) -> None:
    """执行证券资料与逐日状态同步。"""

    from alpha.sync_tasks.gm_async import GmAsyncProvider
    from alpha.sync_tasks.tasks.security_sync import SecuritySyncTask

    async def run() -> None:
        """执行证券同步任务。

        Args:
            无。

        Returns:
            无返回值。
        """

        task = SecuritySyncTask(GmAsyncProvider())
        trade_date = _parse_trade_date(target_trade_date)

        if mode == "by-symbol":
            result = await task.run_by_symbol(target_trade_date=trade_date)
        elif mode == "by-date":
            result = await task.run_by_date(target_trade_date=trade_date)
        elif mode == "refresh-symbol-infos":
            result = await task.run_refresh_symbol_infos_csv()
        else:
            result = await task.run_refresh_symbols_snapshot_csv(
                target_trade_date=trade_date
            )
        _echo_payload(result)

    asyncio.run(run())


@app.command("sync-bars")
def sync_bars(
    overlap_validation_days: Annotated[
        int,
        typer.Option("--overlap-validation-days", min=0, help="重叠校验天数。"),
    ] = 30,
    rebuild_overview_before_update: Annotated[
        bool,
        typer.Option("--rebuild-overview-before-update", help="同步前重建 bar_overview。"),
    ] = False,
) -> None:
    """执行日线行情增量同步。"""

    from alpha.sync_tasks.gm_async import GmAsyncProvider
    from alpha.sync_tasks.tasks.bar_sync import BarSyncTask

    async def run() -> None:
        """执行日线同步任务。

        Args:
            无。

        Returns:
            无返回值。
        """

        task = BarSyncTask(GmAsyncProvider())
        result = await task.run_incremental(
            overlap_validation_days=overlap_validation_days,
            rebuild_overview_before_update=rebuild_overview_before_update,
        )
        _echo_payload(result)

    asyncio.run(run())


def run_alpha() -> None:
    """运行 Alpha 业务 CLI。

    Args:
        无。

    Returns:
        无返回值。
    """

    app()
