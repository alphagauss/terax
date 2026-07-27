from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Literal

from alpha.common.enums import Interval, Product
from alpha.common.schema_market import (
    BarDataQuery,
    SecurityDailyInfoQuery,
    SecurityProfileQuery,
)
from alpha.common.schema_trade import ContractData
from alpha.storage.database import DataBase
from alpha.strategy.models import SecurityDailyStateData, SecurityProfileData
from alpha.utils import get_contract_setting, save_contract_setting


@dataclass(frozen=True)
class BacktestDataScope:
    """回测任务所需的数据范围。

    Args:
        vt_symbols: 回测证券代码列表，使用项目内部 ``vt_symbol`` 格式。
        product: 本次回测统一使用的产品类型。
        interval: K 线周期。
        start: 回测开始时间。
        end: 回测结束时间。
        price_adjust: 行情价格口径，支持前复权、后复权和不复权。
    """

    vt_symbols: list[str]
    product: Product
    interval: Interval
    start: datetime
    end: datetime
    price_adjust: Literal["pre", "post", "non"] = "pre"


@dataclass
class BacktestInput:
    """回测引擎消费的已归一化输入。

    Args:
        contracts: 回测使用的合约配置，键为 ``vt_symbol``。
        history_data: 按时间切片聚合的行情数据。
        security_profiles: 证券静态资料，键为 ``vt_symbol``。
        security_states_by_date: 按交易日聚合的逐日证券状态。
        universe_by_date: 按交易日聚合的可交易证券集合。
    """

    contracts: dict[str, ContractData]
    history_data: dict[datetime, dict[str, dict[str, object]]]
    security_profiles: dict[str, SecurityProfileData] = field(default_factory=dict)
    security_states_by_date: dict[date, dict[str, SecurityDailyStateData]] = field(
        default_factory=dict
    )
    universe_by_date: dict[date, set[str]] = field(default_factory=dict)


async def load_backtest_input(
    db: DataBase,
    scope: BacktestDataScope,
) -> BacktestInput:
    """从数据库加载并组装回测输入。

    Args:
        db: 项目数据库门面。
        scope: 回测数据范围。

    Returns:
        可直接装入 ``BackTesting`` 的回测输入。

    Raises:
        ValueError: 当时间范围非法或行情数据为空时抛出。
    """

    if scope.start >= scope.end:
        raise ValueError("起始日期必须小于结束日期")

    bar_queries = [
        BarDataQuery(
            vt_symbol=vt_symbol,
            interval=scope.interval.value,
            adjust=scope.price_adjust,
            start=scope.start,
            end=scope.end,
        )
        for vt_symbol in scope.vt_symbols
    ]
    profile_query = SecurityProfileQuery(vt_symbols=scope.vt_symbols)
    daily_info_query = SecurityDailyInfoQuery(
        vt_symbols=scope.vt_symbols,
        start=scope.start,
        end=scope.end,
    )

    # 并发加载回测所需的行情、静态资料和逐日证券状态。
    bar_rows, profile_rows, daily_info_rows = await asyncio.gather(
        db.load_bars_data(bar_queries),
        db.load_security_profiles(profile_query),
        db.load_security_daily_info(daily_info_query),
    )

    history_data = build_history_data(bar_rows)
    if not history_data:
        raise ValueError("历史数据加载失败，无法开始回测")

    security_profiles = build_security_profiles(profile_rows)
    contracts = build_contracts(scope, security_profiles)
    security_states_by_date = build_security_states_by_date(
        history_data,
        daily_info_rows,
    )
    universe_by_date = build_universe_by_date(history_data)

    return BacktestInput(
        contracts=contracts,
        history_data=history_data,
        security_profiles=security_profiles,
        security_states_by_date=security_states_by_date,
        universe_by_date=universe_by_date,
    )


def build_history_data(
    bar_rows: list[dict[str, object]],
) -> dict[datetime, dict[str, dict[str, object]]]:
    """把 K 线列表整理为回测时间切片。

    Args:
        bar_rows: 数据库或测试夹具返回的 K 线字典列表。

    Returns:
        ``{datetime: {vt_symbol: bar_dict}}`` 形式的时间切片。

    Raises:
        ValueError: 当行情行缺少必要字段或时间格式非法时抛出。
    """

    history_data: defaultdict[datetime, dict[str, dict[str, object]]] = defaultdict(dict)
    for row in bar_rows:
        raw_datetime = row.get("datetime")
        raw_vt_symbol = row.get("vt_symbol")
        if raw_datetime is None or raw_vt_symbol is None:
            raise ValueError("K 线数据缺少 datetime 或 vt_symbol 字段")

        current_datetime = datetime.fromisoformat(str(raw_datetime))
        vt_symbol = str(raw_vt_symbol)
        history_data[current_datetime][vt_symbol] = row

    return dict(sorted(history_data.items(), key=lambda item: item[0]))


def build_security_profiles(
    profile_rows: list[dict[str, object]],
) -> dict[str, SecurityProfileData]:
    """把证券静态资料字典整理为显式模型。

    Args:
        profile_rows: 数据库返回的证券静态资料字典列表。

    Returns:
        以 ``vt_symbol`` 为键的证券静态资料映射。
    """

    profiles: dict[str, SecurityProfileData] = {}
    for row in profile_rows:
        raw_vt_symbol = row.get("vt_symbol")
        if raw_vt_symbol is None:
            continue

        vt_symbol = str(raw_vt_symbol)
        profiles[vt_symbol] = SecurityProfileData(
            vt_symbol=vt_symbol,
            sec_name=_to_optional_text(row.get("sec_name")),
            sec_abbr=_to_optional_text(row.get("sec_abbr")),
            asset_type=_to_optional_text(row.get("asset_type")),
            board=_to_optional_int(row.get("board")),
            pricetick=_to_optional_float(row.get("price_tick")),
            trade_n=_to_optional_int(row.get("trade_n")),
            listed_date=_to_optional_date(row.get("listed_date")),
            delisted_date=_to_optional_date(row.get("delisted_date")),
        )

    return profiles


def build_security_states_by_date(
    history_data: dict[datetime, dict[str, dict[str, object]]],
    daily_info_rows: list[dict[str, object]],
) -> dict[date, dict[str, SecurityDailyStateData]]:
    """按交易日组装证券逐日状态。

    Args:
        history_data: 已按时间切片整理好的回测行情。
        daily_info_rows: 数据库返回的逐日证券状态。

    Returns:
        ``{trade_date: {vt_symbol: SecurityDailyStateData}}`` 形式的映射。
    """

    states_by_date: defaultdict[date, dict[str, SecurityDailyStateData]] = defaultdict(dict)

    # 先装配停牌/ST 这类交易日状态，确保无 K 线的交易日也能保留状态快照。
    for row in daily_info_rows:
        raw_vt_symbol = row.get("vt_symbol")
        raw_trade_date = row.get("trade_date")
        if raw_vt_symbol is None or raw_trade_date is None:
            continue

        vt_symbol = str(raw_vt_symbol)
        trade_date = date.fromisoformat(str(raw_trade_date))
        states_by_date[trade_date][vt_symbol] = SecurityDailyStateData(
            vt_symbol=vt_symbol,
            trade_date=trade_date,
            is_suspended=bool(row.get("is_suspended", False)),
            is_st=bool(row.get("is_st", False)),
        )

    # 再补充当日涨跌停价，价格口径与本次回测加载的行情保持一致。
    for current_datetime, bars in history_data.items():
        trade_date = current_datetime.date()
        for vt_symbol, bar in bars.items():
            existing_state = states_by_date[trade_date].get(vt_symbol)
            upper_limit = _to_optional_limit(bar.get("upper_limit"))
            lower_limit = _to_optional_limit(bar.get("lower_limit"))

            if existing_state is None:
                states_by_date[trade_date][vt_symbol] = SecurityDailyStateData(
                    vt_symbol=vt_symbol,
                    trade_date=trade_date,
                    upper_limit=upper_limit,
                    lower_limit=lower_limit,
                )
                continue

            states_by_date[trade_date][vt_symbol] = SecurityDailyStateData(
                vt_symbol=existing_state.vt_symbol,
                trade_date=existing_state.trade_date,
                is_suspended=existing_state.is_suspended,
                is_st=existing_state.is_st,
                upper_limit=(
                    upper_limit
                    if upper_limit is not None
                    else existing_state.upper_limit
                ),
                lower_limit=(
                    lower_limit
                    if lower_limit is not None
                    else existing_state.lower_limit
                ),
            )

    return {
        trade_date: state_map
        for trade_date, state_map in sorted(states_by_date.items(), key=lambda item: item[0])
    }


def build_universe_by_date(
    history_data: dict[datetime, dict[str, dict[str, object]]],
) -> dict[date, set[str]]:
    """从回测行情构造逐日证券池。

    Args:
        history_data: 已按时间切片整理好的回测行情。

    Returns:
        ``{trade_date: {vt_symbol, ...}}`` 形式的逐日证券池。
    """

    universe_by_date: defaultdict[date, set[str]] = defaultdict(set)
    for current_datetime, bars in history_data.items():
        universe_by_date[current_datetime.date()].update(bars.keys())

    return {
        trade_date: set(sorted(vt_symbols))
        for trade_date, vt_symbols in sorted(universe_by_date.items(), key=lambda item: item[0])
    }


def build_contracts(
    scope: BacktestDataScope,
    security_profiles: dict[str, SecurityProfileData],
) -> dict[str, ContractData]:
    """根据证券静态资料和合约默认配置构造回测合约。

    Args:
        scope: 回测任务的数据范围。
        security_profiles: 已归一化的证券静态资料映射。

    Returns:
        以 ``vt_symbol`` 为键的回测合约映射。
    """

    contract_setting = _load_contract_setting(scope.product)
    contracts: dict[str, ContractData] = {}

    for vt_symbol in scope.vt_symbols:
        profile = security_profiles.get(vt_symbol)
        name = profile.sec_name if profile and profile.sec_name else vt_symbol
        pricetick = (
            profile.pricetick
            if profile and profile.pricetick is not None
            else float(contract_setting["pricetick"])
        )

        contracts[vt_symbol] = ContractData(
            gateway_name="backtest",
            vt_symbol=vt_symbol,
            name=name,
            product=scope.product,
            pricetick=float(pricetick),
            size=int(contract_setting["size"]),
            rate=float(contract_setting["rate"]),
            slippage=float(contract_setting["slippage"]),
            min_commission=float(contract_setting["min_commission"]),
        )

    return contracts


def _to_optional_text(value: object) -> str | None:
    """把可选文本值标准化为空或去首尾空白的字符串。"""

    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_optional_int(value: object) -> int | None:
    """把可选整数值标准化为 ``int``。"""

    if value is None or value == "":
        return None
    return int(value)


def _to_optional_float(value: object) -> float | None:
    """把可选浮点值标准化为 ``float``。"""

    if value is None or value == "":
        return None
    return float(value)


def _to_optional_limit(value: object) -> float | None:
    """把涨跌停价标准化为有效价格或 ``None``。"""

    normalized = _to_optional_float(value)
    if normalized is None or normalized <= 0:
        return None
    return normalized


def _to_optional_date(value: object) -> date | None:
    """把可选日期值标准化为 ``date``。"""

    if value is None or value == "":
        return None
    return date.fromisoformat(str(value))


def _load_contract_setting(product: Product) -> dict[str, float | int]:
    """加载产品合约默认配置，缺失时写入项目默认值。

    Args:
        product: 产品类型。

    Returns:
        合约默认配置字典。
    """

    contract_setting = get_contract_setting(product)
    if contract_setting:
        return {
            "pricetick": contract_setting["pricetick"],
            "size": contract_setting["size"],
            "rate": contract_setting["rate"],
            "slippage": contract_setting["slippage"],
            "min_commission": contract_setting["min_commission"],
        }

    default_setting: dict[str, float | int] = {
        "pricetick": 0.01,
        "size": 100,
        "rate": 1.1 / 10_000,
        "slippage": 0.01,
        "min_commission": 1,
    }
    save_contract_setting(product, default_setting)
    return default_setting
