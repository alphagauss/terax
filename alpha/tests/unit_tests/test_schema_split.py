from datetime import datetime
from typing import NotRequired, get_origin, get_type_hints

from alpha.common import schema
from alpha.common.schema_backtest import AccountData, BacktestReq, HoldData
from alpha.common.schema_core import (
    build_vt_symbol,
    datetime_to_timestr,
    normalize_exchange_text,
    split_vt_symbol,
)
from alpha.common.schema_market import (
    AdjustFactorPayload,
    BarDataPayload,
    BarDataQuery,
    SecurityProfilePayload,
    SecurityStatusEventPayload,
    SecurityStatusMetaPayload,
    ShareCapitalPayload,
)
from alpha.common.schema_trade import CancelRequest, OrderData, OrderRequest


def _not_required_fields(payload_type: type) -> set[str]:
    """从 TypedDict 注解中提取显式 NotRequired 字段。"""
    hints = get_type_hints(payload_type, include_extras=True)
    return {name for name, hint in hints.items() if get_origin(hint) is NotRequired}


def test_schema_compat_exports_keep_existing_symbols() -> None:
    """兼容出口应继续暴露常用符号。"""
    assert schema.BarDataPayload is BarDataPayload
    assert schema.BarDataQuery is BarDataQuery
    assert schema.AdjustFactorPayload is AdjustFactorPayload
    assert schema.ShareCapitalPayload is ShareCapitalPayload
    assert schema.SecurityProfilePayload is SecurityProfilePayload
    assert schema.SecurityStatusEventPayload is SecurityStatusEventPayload
    assert schema.SecurityStatusMetaPayload is SecurityStatusMetaPayload
    assert schema.OrderData is OrderData
    assert schema.OrderRequest is OrderRequest
    assert schema.CancelRequest is CancelRequest
    assert schema.BacktestReq is BacktestReq
    assert schema.AccountData is AccountData
    assert schema.HoldData is HoldData
    assert schema.build_vt_symbol is build_vt_symbol
    assert schema.split_vt_symbol is split_vt_symbol
    assert schema.normalize_exchange_text is normalize_exchange_text
    assert schema.datetime_to_timestr is datetime_to_timestr


def test_market_schema_typed_dicts_keep_required_and_optional_fields() -> None:
    """市场写入载荷类型应清晰表达字段结构。"""
    query = BarDataQuery(
        vt_symbol="000001.SZSE",
        interval="d",
        adjust="non",
        start=datetime(2025, 1, 1),
        end=datetime(2025, 1, 31),
    )

    bar_fields = set(get_type_hints(BarDataPayload, include_extras=True))
    bar_optional_fields = _not_required_fields(BarDataPayload)

    assert bar_fields - bar_optional_fields == {"vt_symbol", "datetime", "interval"}
    assert {
        "volume",
        "open",
        "high",
        "low",
        "close",
        "turnover",
        "open_interest",
        "upper_limit",
        "lower_limit",
    } == bar_optional_fields
    assert AdjustFactorPayload.__required_keys__ == frozenset(
        {"vt_symbol", "trade_date", "adj_factor"}
    )
    assert ShareCapitalPayload.__required_keys__ == frozenset(
        {
            "vt_symbol",
            "trade_date",
            "total_share",
            "float_share",
            "free_share",
            "updated_at",
        }
    )
    assert SecurityProfilePayload.__required_keys__ == frozenset()
    assert {
        "vt_symbol",
        "asset_type",
        "board",
        "sec_name",
        "sec_abbr",
        "price_tick",
        "trade_n",
        "listed_date",
        "delisted_date",
    } == SecurityProfilePayload.__optional_keys__
    assert SecurityStatusEventPayload.__required_keys__ == frozenset(
        {"vt_symbol", "trade_date"}
    )
    assert {
        "vt_symbol",
        "latest_checked_trade_date",
        "latest_data_trade_date",
        "is_terminal",
        "updated_at",
    } == SecurityStatusMetaPayload.__optional_keys__
    assert query.vt_symbol == "000001.SZSE"


def test_trade_schema_models_keep_request_linkage() -> None:
    """交易对象拆分后仍应保留请求与订单之间的关联行为。"""
    request = OrderRequest(
        vt_symbol="rb2501.SSE",
        direction=schema.Direction.LONG,
        order_type=schema.OrderType.LIMIT,
        volume=2,
        price=3500,
    )

    order = request.create_order_data(orderid="1", gateway_name="sim")
    cancel_request = order.create_cancel_request()

    assert request.vt_symbol == "rb2501.SSE"
    assert order.vt_symbol == "rb2501.SSE"
    assert order.vt_orderid == "sim.1"
    assert cancel_request.vt_symbol == "rb2501.SSE"


def test_backtest_schema_models_keep_serialization_behavior() -> None:
    """回测配置对象拆分后仍应保留 JSON 序列化能力。"""
    request = BacktestReq(
        class_name="DemoStrategy",
        vt_symbols=["000001.SZSE"],
        product=schema.Product.EQUITY,
        interval=schema.Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 31),
        capital=100000,
    )

    instance_name = request.to_instance_name()
    restored = BacktestReq.from_instance_name(instance_name)
    account = AccountData(update=datetime(2024, 1, 1).date())

    assert request.hash_name.endswith(".json")
    assert restored.class_name == "DemoStrategy"
    assert restored.vt_symbols == ["000001.SZSE"]
    assert account.total == 0
