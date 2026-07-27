"""Alpha 策略接口路由。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.deps import get_alpha_services
from alpha.api.models import StrategyInfo
from alpha.api.container import AlphaServiceContainer

router = APIRouter()


def _parameter_items(raw_parameters: object) -> list[dict[str, object]]:
    """构建策略参数列表。

    Args:
        raw_parameters: 策略类元数据中的参数定义。

    Returns:
        前端展示用参数列表。
    """

    if not isinstance(raw_parameters, dict):
        return []

    parameters: list[dict[str, object]] = []
    for name, default in raw_parameters.items():
        parameters.append(
            {
                "name": str(name),
                "type": type(default).__name__ if default is not None else None,
                "default": default,
                "description": None,
            }
        )
    return parameters


def _strategy_item(name: str, metadata: dict[str, object]) -> dict[str, object]:
    """构造策略响应项。

    Args:
        name: 策略标识。
        metadata: 策略管理器返回的元数据。

    Returns:
        前端策略响应项。
    """

    raw_parameters = metadata.get("parameters", metadata.get("paramaters", {}))
    class_name = str(metadata.get("class_name") or name)
    return {
        "id": name,
        "name": name,
        "class_name": class_name,
        "module": metadata.get("module"),
        "file_path": metadata.get("file_path") or metadata.get("filepath"),
        "description": metadata.get("description") or metadata.get("desc"),
        "parameters": _parameter_items(raw_parameters),
        "last_backtest_id": None,
        "metadata": metadata,
    }


def _build_strategy_list(
    strategy_classes: dict[str, dict[str, object]],
) -> list[dict[str, object]]:
    """构建可展示策略列表。

    Args:
        strategy_classes: 策略管理器返回的策略类元数据映射。

    Returns:
        已过滤加载错误条目的策略信息列表。
    """

    strategies: list[dict[str, object]] = []
    for name, metadata in sorted(strategy_classes.items()):
        if name.startswith("load_error::"):
            continue
        strategies.append(_strategy_item(name, metadata))
    return strategies


@router.get("/strategies", response_model=dict[str, object])
async def list_strategies(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """列出 Alpha 策略。

    Args:
        services: Alpha 业务服务容器。

    Returns:
        策略信息分页结构。
    """

    items = _build_strategy_list(services.strategy_manager.get_strategy_class())
    return {"items": items, "total": len(items)}


@router.get("/strategies/{strategy_id}", response_model=dict[str, object])
async def get_strategy(
    strategy_id: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取策略详情。

    Args:
        strategy_id: 策略标识。
        services: Alpha 业务服务容器。

    Returns:
        策略详情。

    Raises:
        HTTPException: 策略不存在。
    """

    strategy_classes = services.strategy_manager.get_strategy_class()
    metadata = strategy_classes.get(strategy_id)
    if metadata is None or strategy_id.startswith("load_error::"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "策略不存在")

    return {
        **_strategy_item(strategy_id, metadata),
        "recent_backtests": [],
    }


@router.post("/strategies/reload", response_model=list[StrategyInfo])
async def reload_strategies(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> list[dict[str, object]]:
    """刷新并列出 Alpha 策略。

    Args:
        services: Alpha 业务服务容器。

    Returns:
        刷新后的策略信息列表。
    """

    services.strategy_manager.load_strategy_class()
    return _build_strategy_list(services.strategy_manager.get_strategy_class())
