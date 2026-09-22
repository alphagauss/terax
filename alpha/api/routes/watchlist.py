"""页面与 Agent 共用的自选查询和幂等成员修改接口。"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services

router = APIRouter()


class WatchlistChange(BaseModel):
    vt_symbol: str = Field(max_length=100, pattern=r"^[^.\s]+\.[^.\s]+$")
    included: bool


@router.get("/watchlist", response_model=list[dict[str, str]])
async def list_watchlist(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> list[dict[str, str]]:
    """读取业务存储中的权威自选列表。"""
    return await services.database.list_watchlist()


@router.post("/watchlist", response_model=list[dict[str, str]])
async def change_watchlist(
    change: WatchlistChange,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> list[dict[str, str]]:
    """只允许添加已有证券；移除失效证券不要求目录仍然存在。"""
    symbol = change.vt_symbol.upper()
    if (
        change.included
        and await services.database.get_security_catalog_item(symbol) is None
    ):
        raise HTTPException(404, "证券不存在")
    await services.database.set_watchlist_symbol(symbol, change.included)
    return await services.database.list_watchlist()
