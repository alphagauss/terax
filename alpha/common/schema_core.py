from __future__ import annotations

from datetime import datetime as _datetime, timedelta

from alpha.common.enums import Exchange, Interval

STOPORDER_PREFIX = "STOP"

INTERVAL_DELTA_MAP: dict[Interval, timedelta] = {
    Interval.TICK: timedelta(milliseconds=1),
    Interval.MINUTE: timedelta(minutes=1),
    Interval.HOUR: timedelta(hours=1),
    Interval.DAILY: timedelta(days=1),
}


def normalize_exchange_text(exchange: str | Exchange) -> str:
    """校验并返回项目内部唯一允许的交易所值。"""
    normalized_exchange = exchange.value if isinstance(exchange, Exchange) else exchange
    if not Exchange.is_valid(normalized_exchange):
        raise ValueError(f"{normalized_exchange} is not a valid exchange")
    return normalized_exchange


def extract_vt_symbol(vt_symbol: str) -> tuple[str, Exchange]:
    """拆分 vt_symbol 并返回代码与交易所枚举。"""
    symbol, exchange_str = vt_symbol.rsplit(".", 1)
    return symbol, Exchange(normalize_exchange_text(exchange_str))


def split_vt_symbol(vt_symbol: str) -> tuple[str, str]:
    """拆分 vt_symbol 并返回字符串形式的代码与交易所。"""
    symbol, exchange = vt_symbol.rsplit(".", 1)
    return symbol, normalize_exchange_text(exchange)


def build_vt_symbol(symbol: str, exchange: str | Exchange) -> str:
    """拼接 vt_symbol。"""
    exchange_value = normalize_exchange_text(exchange)
    return f"{symbol}.{exchange_value}"


def datetime_to_timestamp(dt: _datetime, type: str = "s") -> int:
    """将时间转换为秒级或毫秒级时间戳。"""
    if type == "s":
        timestamp = int(dt.timestamp())
    else:
        timestamp = int(dt.timestamp() * 1000)
    return timestamp


def datetime_to_timestr(dt: _datetime) -> str:
    """将时间格式化为数据库使用的字符串格式。"""
    return dt.strftime("%Y-%m-%d %H:%M:%S")
