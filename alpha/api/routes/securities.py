"""Alpha 证券数据目录的搜索、分页与详情接口。"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.models import (
    SecurityCatalogDetail,
    SecurityCatalogPage,
    SecuritySnapshot,
)
from alpha.api.routes._utils import clamp_limit, clamp_offset, date_text, first_number
from alpha.common.market_metadata import get_market_metadata
from alpha.common.schema_market import BarHistoryQuery, SecurityCatalogQuery

router = APIRouter()


@router.get("/securities", response_model=SecurityCatalogPage)
async def list_securities(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    q: str | None = None,
    exchange: str | None = None,
    asset_type: str | None = None,
    data_state: Literal["complete", "profile_only", "bars_only"] | None = None,
    interval: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, object]:
    """搜索和分页读取 union 证券数据目录。

    搜索匹配完整代码、裸代码、证券名称和简称。所有过滤及分页均在 SQLite
    主库内完成，不读取真实行情分片。
    """

    return await services.database.query_security_catalog(
        SecurityCatalogQuery(
            keyword=q,
            exchange=exchange,
            asset_type=asset_type,
            data_state=data_state,
            interval=interval,
            limit=clamp_limit(limit, default=50, maximum=100),
            offset=clamp_offset(offset),
        )
    )


@router.get("/securities/{vt_symbol}", response_model=SecurityCatalogDetail)
async def get_security(
    vt_symbol: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取单个证券的资料、行情覆盖和少量附属信息。"""

    item = await services.database.get_security_catalog_item(vt_symbol)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "证券不存在")

    latest_daily_info = await services.database.load_security_status_meta(vt_symbol)
    share_capital = await services.database.load_share_capital_changes(
        vt_symbol,
        date(1900, 1, 1),
        date.today(),
    )
    market_metadata = get_market_metadata(vt_symbol)
    return {
        **item,
        "timezone": market_metadata.timezone.key,
        "price_color_convention": market_metadata.price_color_convention,
        "volume_unit": market_metadata.volume_unit,
        "latest_daily_info": latest_daily_info or {},
        "share_capital": list(share_capital)[-50:],
    }


@router.get("/securities/{vt_symbol}/snapshot", response_model=SecuritySnapshot)
async def get_security_snapshot(
    vt_symbol: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """仅从数据库读取最近一条原始日线，不拉取外部行情或计算指标。"""
    detail = await services.database.get_security_catalog_item(vt_symbol)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "证券不存在")
    metadata = get_market_metadata(vt_symbol)
    page = await services.database.load_bar_history(
        BarHistoryQuery(vt_symbol=vt_symbol, interval="d", adjust="non", limit=1)
    )
    daily = None
    if page["items"]:
        row = page["items"][-1]
        daily = {
            "trade_date": (date_text(row.get("datetime")) or "")[:10],
            **{
                field: first_number(row, (field,))
                for field in ("open", "high", "low", "close", "volume", "turnover")
            },
        }
        # 存储中的零限价是未提供的占位值，不能展示为真实价格。
        for field in ("upper_limit", "lower_limit"):
            value = first_number(row, (field,))
            daily[field] = value if value is not None and value > 0 else None
    return {
        **detail,
        "timezone": metadata.timezone.key,
        "price_color_convention": metadata.price_color_convention,
        "volume_unit": metadata.volume_unit,
        "latest_daily": daily,
    }
