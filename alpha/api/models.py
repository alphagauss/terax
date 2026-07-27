"""Alpha 业务 API 的 Pydantic 响应模型。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Alpha 服务健康检查响应。"""

    status: Literal["ok"]
    services_ready: bool


class DataOverviewResponse(BaseModel):
    """行情数据概览响应。"""

    total_bar_count: int = 0
    bar_overview: list[dict[str, object]] = Field(default_factory=list)
    bars: dict[str, dict[str, object]] = Field(default_factory=dict)
    security_profile: dict[str, object] = Field(default_factory=dict)
    index_constituents: dict[str, object] = Field(default_factory=dict)


class StrategyInfo(BaseModel):
    """策略信息响应。"""

    name: str
    metadata: dict[str, object] = Field(default_factory=dict)


class BacktestStartResponse(BaseModel):
    """启动回测后的响应。"""

    backtest_id: str | None = None
    task_id: str
    status: str = "running"
