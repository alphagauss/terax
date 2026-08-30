"""Alpha 回测创建与结果接口。"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.models import BacktestStartResponse
from alpha.api.routes._utils import (
    clamp_limit,
    clamp_offset,
    date_text,
    first_number,
    normalize_adjust,
    normalize_interval,
    normalize_product,
    parse_datetime,
    task_status,
)
from alpha.common.enums import Interval
from alpha.common.schema_backtest import BacktestReq

router = APIRouter()


def _dict_value(data: dict[str, object], key: str) -> dict[str, object]:
    """读取嵌套字典字段。

    Args:
        data: 原始字典。
        key: 字段名。

    Returns:
        字典字段；缺失或类型不符时返回空字典。
    """

    value = data.get(key)
    if isinstance(value, dict):
        return {str(k): v for k, v in value.items()}
    return {}


def _list_value(data: dict[str, object], key: str) -> list[str]:
    """读取字符串列表字段。

    Args:
        data: 原始字典。
        key: 字段名。

    Returns:
        字符串列表。
    """

    value = data.get(key)
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _numeric_value(
    data: dict[str, object],
    key: str,
    *,
    default: float,
) -> float:
    """读取数字字段。

    Args:
        data: 原始字典。
        key: 字段名。
        default: 缺失时默认值。

    Returns:
        浮点数。

    Raises:
        HTTPException: 字段不是数字。
    """

    value = data.get(key, default)
    if isinstance(value, int | float):
        return float(value)
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{key} 必须是数字")


def _build_backtest_req(data: dict[str, object]) -> BacktestReq:
    """把 Web 表单请求转换为现有回测请求模型。

    Args:
        data: 前端请求体。

    Returns:
        Alpha 现有 ``BacktestReq``。

    Raises:
        HTTPException: 请求字段不合法。
    """

    if "class_name" in data:
        return BacktestReq.model_validate(data)

    strategy_id = str(data.get("strategy_id") or "").strip()
    universe = _dict_value(data, "universe")
    symbols = _list_value(universe, "symbols")
    if not strategy_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "策略不能为空")
    if not symbols:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "标的池不能为空")

    start = parse_datetime(str(data.get("start") or ""))
    end = parse_datetime(str(data.get("end") or ""), end_of_day=True)
    if start is None or end is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "开始和结束日期不能为空"
        )
    if start > end:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "开始日期不能晚于结束日期"
        )

    capital = _numeric_value(data, "capital", default=1_000_000)
    commission = _numeric_value(data, "commission", default=0)
    slippage = _numeric_value(data, "slippage", default=0)
    if capital <= 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "初始资金必须大于 0")
    if commission < 0 or slippage < 0:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "手续费和滑点不能为负"
        )

    interval = normalize_interval(str(data.get("interval") or "d"))
    adjust = normalize_adjust(str(data.get("adjust") or "forward"))

    return BacktestReq(
        class_name=strategy_id,
        vt_symbols=symbols,
        product=normalize_product(str(data.get("product") or "stock")),
        interval=Interval(interval),
        start=start,
        end=end,
        capital=int(capital),
        price_adjust=adjust,
        param_setting=_dict_value(data, "params"),
    )


def _result_payload(result: dict[str, object]) -> dict[str, object]:
    """读取回测结果主体。

    Args:
        result: 保存的策略结果文件内容。

    Returns:
        结果主体字典。
    """

    payload = result.get("result")
    if isinstance(payload, dict):
        return {str(k): v for k, v in payload.items()}
    return {}


def _statistics(result: dict[str, object]) -> dict[str, object]:
    """读取回测统计指标。

    Args:
        result: 保存的策略结果文件内容。

    Returns:
        指标字典。
    """

    payload = _result_payload(result)
    statistics = payload.get("statistics")
    if isinstance(statistics, dict):
        return {str(k): v for k, v in statistics.items()}
    return {}


def _backtest_req(result: dict[str, object]) -> dict[str, object]:
    """读取保存的回测配置。

    Args:
        result: 保存的策略结果文件内容。

    Returns:
        回测配置字典。
    """

    request = result.get("backtest_req")
    if isinstance(request, dict):
        return {str(k): v for k, v in request.items()}
    return {}


def _percent(value: object) -> float | None:
    """把百分比口径指标转成小数口径。

    Args:
        value: 原始指标。

    Returns:
        小数口径指标；缺失时返回 ``None``。
    """

    if isinstance(value, int | float):
        return float(value) / 100
    return None


def _number(value: object) -> float | None:
    """把数字指标转成浮点数。

    Args:
        value: 原始指标。

    Returns:
        浮点数或 ``None``。
    """

    if isinstance(value, int | float):
        return float(value)
    return None


def _summary_from_statistics(statistics: dict[str, object]) -> dict[str, object]:
    """构造指标卡片响应。

    Args:
        statistics: 回测统计指标。

    Returns:
        前端指标字典。
    """

    return {
        "total_return": _percent(statistics.get("total_return")),
        "annual_return": _percent(statistics.get("annual_return")),
        "max_drawdown": _percent(statistics.get("max_ddpercent")),
        "sharpe": _number(statistics.get("sharpe_ratio")),
        "win_rate": None,
        "profit_loss_ratio": None,
        "trade_count": _number(statistics.get("total_trade_count")),
        "commission": _number(statistics.get("total_commission")),
    }


def _backtest_item(
    backtest_id: str, request: dict[str, object], result: dict[str, object]
) -> dict[str, object]:
    """构造回测列表项。

    Args:
        backtest_id: 回测结果标识。
        request: 保存的回测配置。
        result: 保存的回测结果。

    Returns:
        回测摘要。
    """

    statistics = _statistics(result)
    summary = _summary_from_statistics(statistics)
    return {
        "id": backtest_id,
        "name": str(request.get("name") or request.get("class_name") or backtest_id),
        "strategy_name": str(request.get("class_name") or ""),
        "status": "completed",
        "start": date_text(request.get("start")),
        "end": date_text(request.get("end")),
        "total_return": summary["total_return"],
        "annual_return": summary["annual_return"],
        "max_drawdown": summary["max_drawdown"],
        "sharpe": summary["sharpe"],
        "trade_count": summary["trade_count"],
        "created_at": date_text(request.get("req_date")),
        "stage": None,
        "progress": None,
        "metrics": {},
        "revision": 0,
    }


def _saved_results(services: AlphaServiceContainer) -> dict[str, dict[str, object]]:
    """读取已保存回测结果概要。

    Args:
        services: Alpha 业务服务容器。

    Returns:
        结果标识到请求概要的映射。
    """

    if not hasattr(services.strategy_manager, "get_all_strategy_result_info"):
        return {}
    return services.strategy_manager.get_all_strategy_result_info()


def _load_result(
    services: AlphaServiceContainer,
    backtest_id: str,
) -> dict[str, object]:
    """读取指定回测结果。

    Args:
        services: Alpha 业务服务容器。
        backtest_id: 回测结果标识。

    Returns:
        回测结果文件内容。

    Raises:
        HTTPException: 回测结果不存在。
    """

    if not hasattr(services.strategy_manager, "get_strategy_result"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "回测结果不存在")
    result = services.strategy_manager.get_strategy_result(backtest_id)
    if not result:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "回测结果不存在")
    return result


def _daily_rows(result: dict[str, object]) -> list[dict[str, object]]:
    """读取逐日结果行。

    Args:
        result: 保存的策略结果文件内容。

    Returns:
        逐日结果列表。
    """

    rows = _result_payload(result).get("daily_results")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def _value_text(value: object) -> str:
    """把枚举或普通值转成字符串。

    Args:
        value: 原始值。

    Returns:
        字符串。
    """

    enum_value = getattr(value, "value", None)
    if enum_value is not None:
        return str(enum_value)
    return str(value or "")


def _trade_item(index: int, row: dict[str, object]) -> dict[str, object]:
    """构造交易列表项。

    Args:
        index: 交易序号。
        row: 原始交易行。

    Returns:
        前端交易行。
    """

    return {
        "id": str(row.get("vt_tradeid") or row.get("tradeid") or f"trade_{index + 1}"),
        "vt_symbol": str(row.get("vt_symbol") or ""),
        "direction": _value_text(row.get("direction")),
        "open_time": date_text(row.get("datetime") or row.get("open_time")),
        "open_price": first_number(row, ("price", "open_price")),
        "close_time": date_text(row.get("close_time")),
        "close_price": first_number(row, ("close_price",)),
        "volume": first_number(row, ("volume",)),
        "pnl": first_number(row, ("pnl", "net_pnl")),
        "return_rate": first_number(row, ("return_rate",)),
        "holding_days": first_number(row, ("holding_days",)),
    }


@router.get("/backtests", response_model=dict[str, object])
async def list_backtests(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    strategy_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, object]:
    """列出 Alpha 回测结果和运行中任务。

    Args:
        services: Alpha 业务服务容器。
        status_filter: 状态过滤。
        strategy_id: 策略过滤。
        limit: 页大小。
        offset: 偏移量。

    Returns:
        回测摘要分页响应。
    """

    items_by_id: dict[str, dict[str, object]] = {}
    for backtest_id, request in _saved_results(services).items():
        result = services.strategy_manager.get_strategy_result(backtest_id)
        items_by_id[backtest_id] = _backtest_item(backtest_id, request, result)

    for snapshot in services.strategy_manager.get_status_dict().values():
        if snapshot.get("kind") != "backtest":
            continue
        metadata = snapshot.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        current_status = task_status(snapshot.get("status"))
        backtest_id = str(snapshot.get("task_id") or "")
        if current_status == "completed" and backtest_id in items_by_id:
            items_by_id[backtest_id].update(
                {
                    "stage": snapshot.get("stage"),
                    "progress": snapshot.get("progress"),
                    "metrics": snapshot.get("metrics") or {},
                    "revision": snapshot.get("revision") or 0,
                }
            )
            continue
        items_by_id[backtest_id] = {
            "id": backtest_id,
            "name": str(snapshot.get("name") or snapshot.get("task_id") or ""),
            "strategy_name": str(metadata.get("strategy_name") or ""),
            "status": current_status,
            "start": date_text(metadata.get("start")),
            "end": date_text(metadata.get("end")),
            "total_return": None,
            "annual_return": None,
            "max_drawdown": None,
            "sharpe": None,
            "trade_count": None,
            "created_at": date_text(snapshot.get("created_at")),
            "stage": snapshot.get("stage"),
            "progress": snapshot.get("progress"),
            "metrics": snapshot.get("metrics") or {},
            "revision": snapshot.get("revision") or 0,
        }

    items = [
        item
        for item in items_by_id.values()
        if (not status_filter or item["status"] == status_filter)
        and (not strategy_id or item["strategy_name"] == strategy_id)
    ]

    normalized_limit = clamp_limit(limit, default=50)
    normalized_offset = clamp_offset(offset)
    return {
        "items": items[normalized_offset : normalized_offset + normalized_limit],
        "total": len(items),
    }


@router.post("/backtests", response_model=BacktestStartResponse)
async def start_backtest(
    request: Annotated[dict[str, object], Body()],
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> BacktestStartResponse:
    """启动 Alpha 回测任务。

    Args:
        request: 回测请求；兼容旧 ``BacktestReq`` 和 Web 表单请求。
        services: Alpha 业务服务容器。

    Returns:
        回测任务标识。

    Raises:
        HTTPException: 策略不存在或请求不合法。
    """

    strategy_id = str(request.get("strategy_id") or request.get("class_name") or "")
    if strategy_id:
        strategy_classes = services.strategy_manager.get_strategy_class()
        if strategy_id not in strategy_classes:
            services.strategy_manager.load_strategy_class()
            strategy_classes = services.strategy_manager.get_strategy_class()
        if strategy_id not in strategy_classes:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "策略不存在")

    backtest_req = _build_backtest_req(request)
    task_id = services.strategy_manager.start_backtesting(backtest_req)
    return BacktestStartResponse(
        backtest_id=backtest_req.hash_name,
        task_id=task_id,
        status="running",
    )


@router.get("/backtests/{backtest_id}", response_model=dict[str, object])
async def get_backtest(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取回测基础信息。

    Args:
        backtest_id: 回测结果标识。
        services: Alpha 业务服务容器。

    Returns:
        回测基础信息。
    """

    result = _load_result(services, backtest_id)
    request = _backtest_req(result)
    return {
        "id": backtest_id,
        "name": str(request.get("name") or request.get("class_name") or backtest_id),
        "strategy_id": str(request.get("class_name") or ""),
        "strategy_name": str(request.get("class_name") or ""),
        "status": "completed",
        "start": date_text(request.get("start")),
        "end": date_text(request.get("end")),
        "interval": request.get("interval"),
        "adjust": request.get("price_adjust"),
        "created_at": date_text(request.get("req_date")),
        "finished_at": None,
        "task_id": backtest_id,
    }


@router.get("/backtests/{backtest_id}/summary", response_model=dict[str, object])
async def get_backtest_summary(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取回测指标摘要。"""

    return _summary_from_statistics(_statistics(_load_result(services, backtest_id)))


@router.get("/backtests/{backtest_id}/equity", response_model=dict[str, object])
async def get_backtest_equity(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取回测净值曲线。"""

    items = [
        {
            "date": date_text(row.get("date")),
            "equity": first_number(row, ("balance",)),
            "benchmark": None,
            "cash": None,
            "market_value": None,
        }
        for row in _daily_rows(_load_result(services, backtest_id))
    ]
    return {"items": items}


@router.get("/backtests/{backtest_id}/drawdown", response_model=dict[str, object])
async def get_backtest_drawdown(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取回测回撤曲线。"""

    items = [
        {
            "date": date_text(row.get("date")),
            "drawdown": _percent(row.get("ddpercent")),
        }
        for row in _daily_rows(_load_result(services, backtest_id))
    ]
    return {"items": items}


@router.get("/backtests/{backtest_id}/daily-returns", response_model=dict[str, object])
async def get_backtest_daily_returns(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取回测每日收益。"""

    items = [
        {
            "date": date_text(row.get("date")),
            "return": _number(row.get("return")),
        }
        for row in _daily_rows(_load_result(services, backtest_id))
    ]
    return {"items": items}


@router.get("/backtests/{backtest_id}/trades", response_model=dict[str, object])
async def get_backtest_trades(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    vt_symbol: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, object]:
    """读取回测交易列表。"""

    raw_trades = _result_payload(_load_result(services, backtest_id)).get("trades")
    trades = raw_trades if isinstance(raw_trades, list) else []
    items = [
        _trade_item(index, row)
        for index, row in enumerate(trades)
        if isinstance(row, dict)
        and (not vt_symbol or row.get("vt_symbol") == vt_symbol)
    ]
    normalized_limit = clamp_limit(limit, default=50)
    normalized_offset = clamp_offset(offset)
    return {
        "items": items[normalized_offset : normalized_offset + normalized_limit],
        "total": len(items),
    }


@router.get("/backtests/{backtest_id}/config", response_model=dict[str, object])
async def get_backtest_config(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取回测可复现配置。"""

    request = _backtest_req(_load_result(services, backtest_id))
    return {
        "name": request.get("name") or request.get("class_name") or backtest_id,
        "strategy_id": request.get("class_name"),
        "params": request.get("param_setting") or {},
        "universe": {
            "type": "symbols",
            "symbols": request.get("vt_symbols") or [],
        },
        "benchmark": request.get("benchmark"),
        "start": date_text(request.get("start")),
        "end": date_text(request.get("end")),
        "interval": request.get("interval"),
        "adjust": request.get("price_adjust"),
        "capital": request.get("capital"),
        "commission": request.get("commission"),
        "slippage": request.get("slippage"),
        "raw": request,
    }


@router.get("/backtests/{backtest_id}/logs", response_model=dict[str, object])
async def get_backtest_logs(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    limit: int = 100,
    offset: int = 0,
) -> dict[str, object]:
    """读取回测日志。"""

    snapshots = services.strategy_manager.get_status_dict()
    snapshot = snapshots.get(backtest_id, {})
    raw_logs = snapshot.get("logs") if isinstance(snapshot, dict) else []
    logs = raw_logs if isinstance(raw_logs, list) else []
    items = [
        {
            "time": datetime.now().isoformat(),
            "level": "info",
            "message": str(message),
        }
        for message in logs
    ]
    normalized_limit = clamp_limit(limit, default=100)
    normalized_offset = clamp_offset(offset)
    return {
        "items": items[normalized_offset : normalized_offset + normalized_limit],
        "total": len(items),
    }


@router.get("/backtests/{backtest_id}/replay", response_model=dict[str, object])
async def get_backtest_replay(
    backtest_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    vt_symbol: str,
) -> dict[str, object]:
    """读取 K 线复盘标记。

    第一版只返回交易标记，K 线仍由前端按需调用 `/bars` 获取。
    """

    trades = await get_backtest_trades(backtest_id, services, vt_symbol=vt_symbol)
    markers = [
        {
            "time": trade.get("open_time"),
            "type": "buy" if str(trade.get("direction")) in {"多", "long"} else "sell",
            "price": trade.get("open_price"),
            "trade_id": trade.get("id"),
        }
        for trade in trades["items"]
        if isinstance(trade, dict) and trade.get("open_time")
    ]
    return {
        "vt_symbol": vt_symbol,
        "bars": [],
        "markers": markers,
        "position_ranges": [],
    }
