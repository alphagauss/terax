"""Alpha 业务 API 的 Pydantic 响应模型。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from alpha.common.schema_core import split_vt_symbol


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


class SyncBarsRequest(BaseModel):
    """启动日线增量同步的可选定向标的。"""

    vt_symbols: list[str] | None = Field(default=None, min_length=1, max_length=500)

    @field_validator("vt_symbols")
    @classmethod
    def normalize_vt_symbols(cls, values: list[str] | None) -> list[str] | None:
        """校验证券代码并按首次出现顺序去重。"""
        if values is None:
            return None
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            text = value.strip().upper()
            split_vt_symbol(text)
            if text not in seen:
                seen.add(text)
                normalized.append(text)
        return normalized


class SyncStartResponse(BaseModel):
    """启动日线同步后的任务标识。"""

    task_id: str
    status: str = "running"


class SyncTaskSummary(BaseModel):
    """数据页轮询所需的轻量同步任务状态。"""

    task_id: str
    status: str
    created_at: str | None = None
    finished_at: str | None = None
    message: str | None = None


class SyncQualityIssue(BaseModel):
    """有界日线质量异常明细。"""

    vt_symbol: str
    trade_date: str
    field: str
    kind: str
    message: str
    db_value: float | None = None
    fetched_value: float | None = None


class SyncQualitySnapshot(BaseModel):
    """最近一次日线同步的结构化质量摘要。"""

    schema_version: int = 1
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    latest_trade_date: str | None = None
    planned_symbol_count: int = 0
    fetched_rows: int = 0
    saved_rows: int = 0
    failed_batch_count: int = 0
    validation_issue_count: int = 0
    failed_vt_symbols: list[str] = Field(default_factory=list, max_length=500)
    failed_vt_symbol_count: int = 0
    issues: list[SyncQualityIssue] = Field(default_factory=list, max_length=100)
    message: str | None = None


class SyncOverviewResponse(BaseModel):
    """同步运行状态和最近质量快照。"""

    tasks: list[SyncTaskSummary] = Field(default_factory=list)
    latest: SyncQualitySnapshot | None = None
