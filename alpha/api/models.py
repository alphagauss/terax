"""Alpha 业务 API 的 Pydantic 响应模型。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Alpha 服务健康检查响应。"""

    status: Literal["ok"]
    ready: bool
    service: Literal["terax-alpha"] = "terax-alpha"
    protocol_version: Literal[2] = 2
    runtime_revision: str
    started_at: datetime


class ShutdownResponse(BaseModel):
    """Alpha 服务停止请求响应。"""

    status: Literal["stopping"] = "stopping"


class FacetCount(BaseModel):
    """普通 Facet 的值与证券数量。"""

    value: str
    count: int


class IntervalFacet(BaseModel):
    """行情周期 Facet 的证券数量与总行数。"""

    value: str
    security_count: int
    row_count: int


class DataOverviewSummary(BaseModel):
    """union 证券目录的全局数据摘要。"""

    security_count: int = 0
    profile_count: int = 0
    bar_security_count: int = 0
    total_bar_count: int = 0
    data_start: str | None = None
    data_end: str | None = None
    latest_updated_at: str | None = None


class DataFacets(BaseModel):
    """数据目录可用的全局过滤维度。"""

    exchanges: list[FacetCount] = Field(default_factory=list)
    asset_types: list[FacetCount] = Field(default_factory=list)
    data_states: list[FacetCount] = Field(default_factory=list)
    intervals: list[IntervalFacet] = Field(default_factory=list)


class DataOverviewResponse(BaseModel):
    """可缓存的数据目录摘要与全局 Facets。"""

    summary: DataOverviewSummary
    facets: DataFacets


class BarCoverageResponse(BaseModel):
    """单证券、单周期的行情覆盖摘要。"""

    start: str
    end: str
    rows: int
    updated_at: str


class SecurityCatalogItem(BaseModel):
    """证券数据目录列表项。"""

    vt_symbol: str
    symbol: str
    exchange: str
    name: str
    asset_type: str | None = None
    board: int | None = None
    listed_date: str | None = None
    delisted_date: str | None = None
    status: Literal["active", "delisted"]
    data_state: Literal["complete", "profile_only", "bars_only"]
    total_bar_count: int = 0
    data_start: str | None = None
    data_end: str | None = None
    latest_updated_at: str | None = None
    intervals: list[str] = Field(default_factory=list)
    coverage: dict[str, BarCoverageResponse] = Field(default_factory=dict)


class SecurityCatalogPage(BaseModel):
    """证券数据目录分页响应。"""

    items: list[SecurityCatalogItem] = Field(default_factory=list)
    total: int
    limit: int
    offset: int


class SecurityCatalogDetail(SecurityCatalogItem):
    """证券数据目录详情响应。"""

    timezone: str
    price_color_convention: Literal["up-red", "up-green"]
    volume_unit: str | None = None
    sec_name: str | None = None
    sec_abbr: str | None = None
    price_tick: float | None = None
    trade_n: int | None = None
    latest_daily_info: dict[str, object] = Field(default_factory=dict)
    share_capital: list[dict[str, object]] = Field(default_factory=list)


class StrategyInfo(BaseModel):
    """策略信息响应。"""

    name: str
    metadata: dict[str, object] = Field(default_factory=dict)


class BacktestStartResponse(BaseModel):
    """启动回测后的响应。"""

    backtest_id: str | None = None
    task_id: str
    status: str = "running"
