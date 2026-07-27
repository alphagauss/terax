from __future__ import annotations

from datetime import date, datetime, time, timedelta

import pandas as pd


def parse_date_like(value: object) -> date | None:
    """将日期字段解析为日期对象。"""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = str(value).strip()
    if text == "" or text.lower() == "nan":
        return None
    return pd.Timestamp(text).date()


def align_to_next_trade_date(target: date, trade_dates: list[date]) -> date | None:
    """对齐到不早于目标日期的最近交易日。"""
    for trade_date in trade_dates:
        if trade_date >= target:
            return trade_date
    return None


def align_to_prev_trade_date(target: date, trade_dates: list[date]) -> date | None:
    """对齐到不晚于目标日期的最近交易日。"""
    for trade_date in reversed(trade_dates):
        if trade_date <= target:
            return trade_date
    return None


def count_trade_dates_between(trade_dates: list[date], start_date: date, end_date: date) -> int:
    """统计闭区间内交易日数量。"""
    return sum(start_date <= trade_date <= end_date for trade_date in trade_dates)


def shift_back_calendar_days(target: date, days: int) -> date:
    """将日期向前回退指定自然日天数。"""
    return target - timedelta(days=days)


def get_latest_target_trade_date(
    trade_dates: list[date],
    now: datetime | None = None,
    cutoff_hour: int = 20,
) -> date:
    """根据当前时间计算本次更新应覆盖到的最新交易日。"""
    current = now or datetime.now()
    today = current.date()
    is_trade_day = today in set(trade_dates)
    if is_trade_day and current.time() >= time(hour=cutoff_hour):
        return today

    previous = align_to_prev_trade_date(today - timedelta(days=1 if is_trade_day else 0), trade_dates)
    if previous is None:
        raise ValueError("未找到可用的最新交易日")
    return previous
