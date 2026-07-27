from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from time import perf_counter


@dataclass(slots=True)
class SecurityInfo:
    """统一的证券基础信息。"""

    asset_type: str
    gm_symbol: str
    gm_exchange: str
    sec_id: str
    db_exchange: str
    vt_symbol: str
    listed_date: date
    delisted_date: date | None


@dataclass(slots=True)
class SecuritySyncPlan:
    """单个证券信息同步计划。"""

    security: SecurityInfo
    start_date: date
    end_date: date


@dataclass(slots=True)
class IndexConstituentSyncPlan:
    """单个指数成分股同步计划。"""

    security: SecurityInfo
    start_date: date
    end_date: date


@dataclass(slots=True)
class BarSyncPlan:
    """单个标的的日线同步计划。"""

    asset_type: str
    gm_symbol: str
    vt_symbol: str
    sec_id: str
    db_exchange: str
    start_date: date
    end_date: date
    expected_rows: int
    existing_start: date | None
    existing_end: date | None
    overlap_start: date | None


@dataclass(slots=True)
class ValidationIssue:
    """重叠区校验异常。"""

    vt_symbol: str
    trade_date: str
    field: str
    db_value: float
    fetched_value: float


@dataclass(slots=True)
class YearPlan:
    """按年份切分后的单标的更新计划。"""

    year: int
    asset_type: str
    gm_symbol: str
    vt_symbol: str
    sec_id: str
    db_exchange: str
    start_date: date
    end_date: date
    expected_rows: int
    existing_start: date | None
    existing_end: date | None
    overlap_start: date | None


@dataclass(slots=True)
class BatchResult:
    """单个批次的执行结果。"""

    batch_index: int
    batch_total: int
    request_start: str
    request_end: str
    symbol_count: int
    fetched_rows: int
    saved_rows: int
    validation_issue_count: int
    status: str
    message: str


@dataclass(slots=True)
class StageProfiler:
    """统计各阶段累计耗时。"""

    enabled: bool = False
    stats: dict[str, float] | None = None

    def __post_init__(self) -> None:
        if self.stats is None:
            self.stats = {}

    def measure(self) -> float:
        """返回当前计时起点。"""
        return perf_counter()

    def add(self, stage: str, started_at: float) -> None:
        """累计阶段耗时。"""
        if not self.enabled:
            return
        elapsed = perf_counter() - started_at
        current = self.stats.get(stage, 0.0)
        self.stats[stage] = current + elapsed

    def export(self) -> dict[str, float]:
        """导出阶段耗时秒数。"""
        return {key: round(value, 6) for key, value in sorted(self.stats.items())}
