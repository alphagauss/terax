from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True, slots=True)
class SecurityProfileData:
    """策略运行时使用的证券静态资料。"""

    vt_symbol: str
    sec_name: str | None = None
    sec_abbr: str | None = None
    asset_type: str | None = None
    board: int | None = None
    pricetick: float | None = None
    trade_n: int | None = None
    listed_date: date | None = None
    delisted_date: date | None = None


@dataclass(frozen=True, slots=True)
class SecurityDailyStateData:
    """策略运行时使用的逐日证券状态。"""

    vt_symbol: str
    trade_date: date
    is_suspended: bool = False
    is_st: bool = False
    upper_limit: float | None = None
    lower_limit: float | None = None


@dataclass(frozen=True, slots=True)
class SecuritySnapshotData:
    """策略运行时使用的证券状态快照。"""

    profile: SecurityProfileData | None
    daily_state: SecurityDailyStateData | None
    in_universe: bool | None = None
