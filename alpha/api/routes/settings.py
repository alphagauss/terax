"""Alpha 持久配置查询与更新接口。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.config import AlphaConfig, save_config

router = APIRouter()


@router.get("/settings", response_model=AlphaConfig)
async def get_settings(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> AlphaConfig:
    """返回当前 Alpha 持久配置。"""

    return services.config


@router.post("/settings", response_model=AlphaConfig)
async def update_settings(
    config: AlphaConfig,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> AlphaConfig:
    """验证并保存 Alpha 配置，运行任务存在时拒绝切换数据目录。"""

    if config == services.config:
        return config
    if services.has_running_tasks():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="存在运行中的 Alpha 任务，请先结束任务再修改数据目录",
        )
    try:
        save_config(config)
    except OSError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"无法使用数据目录: {error}",
        ) from error
    services.config = config
    return config
