from __future__ import annotations

from datetime import date as _date
from datetime import datetime as _datetime
from typing import Any, Literal, TypedDict

from pydantic import BaseModel, Field, model_validator
from typing_extensions import NotRequired, Self

from alpha.common.enums import Exchange, Interval
from alpha.common.schema_core import (
    build_vt_symbol,
    normalize_exchange_text,
    split_vt_symbol,
)


class BarDataPayload(TypedDict):
    """
    标准化 K 线写入载荷。

    入库主键字段 ``vt_symbol``、``datetime`` 为必填，``interval`` 作为分片
    与上游周期语义字段同样必填，但不再写入 K 线分片表。
    其余字段允许按来源分批缺失：

    - 主行情批次通常提供 ``volume``、``open``、``high``、``low``、``close``，
      并可按需附带 ``turnover``、``open_interest``；
    - 日线限价补写批次可仅提供 ``upper_limit``、``lower_limit``；
    - 同一次 ``save_bar_data`` 调用要求字段集合一致。
    """
    vt_symbol: str
    datetime: str
    interval: str
    volume: NotRequired[float]
    open: NotRequired[float]
    high: NotRequired[float]
    low: NotRequired[float]
    close: NotRequired[float]
    turnover: NotRequired[float | None]
    open_interest: NotRequired[float | None]
    upper_limit: NotRequired[float | None]
    lower_limit: NotRequired[float | None]


class AdjustFactorPayload(TypedDict):
    """标准化复权因子写入载荷。"""

    vt_symbol: str
    trade_date: str
    adj_factor: float


class ShareCapitalPayload(TypedDict):
    """标准化股本变化写入载荷。"""

    vt_symbol: str
    trade_date: str
    total_share: float | None
    float_share: float | None
    free_share: float | None
    updated_at: str


class SecurityProfilePayload(TypedDict, total=False):
    """标准化证券静态资料写入载荷。"""

    vt_symbol: str
    asset_type: str
    board: int | None
    sec_name: str | None
    sec_abbr: str | None
    price_tick: float | None
    trade_n: int | None
    listed_date: str | None
    delisted_date: str | None


class SecurityStatusEventPayload(TypedDict):
    """标准化证券状态事件写入载荷。"""

    vt_symbol: str
    trade_date: str


class SecurityStatusMetaPayload(TypedDict, total=False):
    """标准化证券状态同步游标写入载荷。

    该载荷显式区分“已检查到哪里”和“最后一次拿到真实数据到哪里”：

    - ``latest_checked_trade_date`` 表示同步任务已经检查完成的最新交易日，
      即使该日无数据也要推进；
    - ``latest_data_trade_date`` 表示最后一次拿到有效证券状态数据的交易日，
      允许为空；
    - ``is_terminal`` 表示该证券是否已经进入终态，例如退市后无需再继续探测；
    - ``updated_at`` 为本次游标更新时间，允许调用方省略，由仓储层补齐。
    """

    vt_symbol: str
    latest_checked_trade_date: str
    latest_data_trade_date: str | None
    is_terminal: bool
    updated_at: str


class SecurityDailyInfoRecord(TypedDict):
    """证券逐日状态读取结果。"""

    vt_symbol: str
    trade_date: str
    is_suspended: bool
    is_st: bool


class BarDataQuery(BaseModel):
    """单标的 K 线查询条件。"""

    vt_symbol: str
    interval: Literal["1m","1h", "d", "w", "tick"]
    adjust: Literal["pre", "post", "non"] = "non"
    start: _datetime
    end: _datetime = _datetime.now()

    def model_post_init(self, __context: Any) -> None:
        """校验输入值。"""
        symbol, exchange = split_vt_symbol(self.vt_symbol)
        if not Interval.is_valid(self.interval):
            raise ValueError(f"{self.interval} is not a valid interval")


class BarHistoryQuery(BaseModel):
    """单标的 K 线倒序限量查询条件。

    ``before`` 是排他游标。仓储层按时间倒序读取，但最终结果恢复为升序，
    便于图表直接合并。复权锚点固定到完整数据覆盖范围，不随页边界变化。
    """

    vt_symbol: str
    interval: Literal["1m", "1h", "d", "w", "tick"]
    adjust: Literal["pre", "post", "non"] = "non"
    before: _datetime | None = None
    limit: int = Field(default=500, ge=1, le=5000)

    def model_post_init(self, __context: Any) -> None:
        """校验证券代码和周期。"""
        split_vt_symbol(self.vt_symbol)
        if not Interval.is_valid(self.interval):
            raise ValueError(f"{self.interval} is not a valid interval")


class BarHistoryPage(TypedDict):
    """仓储层返回的有界 K 线历史页。"""

    items: list[dict[str, object]]
    has_more_before: bool
    next_before: str | None
    actual_start: str | None
    actual_end: str | None


class SecurityDailyInfoQuery(BaseModel):
    """证券逐日状态查询条件。

    Args:
        vt_symbols: 项目内部标准证券代码列表，重复项由仓储层按首次出现顺序去重。
        start: 查询开始交易日。
        end: 查询结束交易日。
    """

    vt_symbols: list[str]
    start: str | _date | _datetime
    end: str | _date | _datetime


class SecurityProfileQuery(BaseModel):
    """证券基本信息查询条件。

    Args:
        vt_symbols: 项目内部标准证券代码列表。``None`` 表示不过滤证券代码，
            空列表表示直接返回空结果。
        asset_type: 资产类型过滤条件，例如 ``stock``、``etf``、``index``。
    """

    vt_symbols: list[str] | None = None
    asset_type: str | None = None


class SecurityCatalogQuery(BaseModel):
    """union 证券数据目录的搜索、Facet 过滤和分页条件。"""

    keyword: str | None = None
    exchange: str | None = None
    asset_type: str | None = None
    data_state: Literal["complete", "profile_only", "bars_only"] | None = None
    interval: str | None = None
    limit: int = 50
    offset: int = 0


class IndexConstituentQuery(BaseModel):
    """指数成分股查询条件。

    Args:
        index_code: 指数代码，沿用数据库内部 ``vt_symbol`` 语义。
        trade_date: 目标交易日。
    """

    index_code: str
    trade_date: str | _date | _datetime


class TickData(BaseModel):
    """Tick 数据。"""

    vt_symbol: str
    datetime: _datetime

    volume: float
    turnover: float
    open_interest: float | None = None

    bid_price_1: float | None = None
    bid_price_2: float | None = None
    bid_price_3: float | None = None
    bid_price_4: float | None = None
    bid_price_5: float | None = None

    bid_volume_1: float | None = None
    bid_volume_2: float | None = None
    bid_volume_3: float | None = None
    bid_volume_4: float | None = None
    bid_volume_5: float | None = None

    ask_price_1: float | None = None
    ask_price_2: float | None = None
    ask_price_3: float | None = None
    ask_price_4: float | None = None
    ask_price_5: float | None = None

    ask_volume_1: float | None = None
    ask_volume_2: float | None = None
    ask_volume_3: float | None = None
    ask_volume_4: float | None = None
    ask_volume_5: float | None = None

    @model_validator(mode="after")
    def _validate_datetime(self) -> Self:
        """确保交易所字段始终归一化为枚举值。"""
        symbol, exchange = split_vt_symbol(self.vt_symbol)
        normalized_exchange = normalize_exchange_text(exchange)
        exchange = Exchange(normalized_exchange)
        if not Exchange.is_valid(exchange):
            raise ValueError(f"{exchange} is not a valid exchange")
        return self


class BarOverview(BaseModel):
    """K 线概览信息。"""
    vt_symbol: str = ""
    interval: Interval

    count: int | None = None
    start: _datetime
    end: _datetime


    def create_bar_query(
        self,
        start: _datetime | None = None,
        end: _datetime | None = None,
        adjust: Literal["pre", "post", "non"] = "non",
    ) -> BarDataQuery:
        """根据概览对象快速生成查询条件。"""
        return BarDataQuery(
            vt_symbol=self.vt_symbol,
            interval=self.interval.value,
            adjust=adjust,
            start=start or self.start,
            end=end or self.end,
        )


class TickOverview(BaseModel):
    """Tick 数据概览。"""

    vt_symbol: str
    count: int | None = None
    start: _datetime
    end: _datetime
