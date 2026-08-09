"""Alpha 数据目录概览接口。

概览只聚合主库中的证券资料与 K 线摘要，并通过服务进程内 TTL 缓存减少重复
读库。用户手动刷新时可以绕过缓存，接口不会读取真实行情分片。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.models import DataOverviewResponse

router = APIRouter()


@router.get("/data/overview", response_model=DataOverviewResponse)
async def data_overview(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    force_refresh: bool = False,
) -> dict[str, object]:
    """返回可缓存的数据目录摘要和全局 Facets。

    Args:
        services: Alpha 业务服务容器。
        force_refresh: 是否忽略有效缓存并重新聚合数据库。

    Returns:
        union 证券目录的全局概览。
    """

    return await services.data_overview_cache.get(
        services.database.get_data_catalog_overview,
        force_refresh=force_refresh,
    )
