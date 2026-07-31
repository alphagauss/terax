"""Alpha 数据库人工检查脚本。"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path
from pprint import pprint
from typing import Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from alpha.common.schema_market import (
    BarDataQuery,
    SecurityDailyInfoQuery,
    SecurityProfileQuery,
)
from alpha.config import load_config
from alpha.storage import DataBase, csvdb
from alpha.storage.transforms import normalize_trade_date


def _print_rows(title: str, rows: Sequence[object], limit: int = 10) -> None:
    """在控制台打印查询结果摘要。

    Args:
        title: 本段输出标题。
        rows: 待打印的结果序列。
        limit: 最多打印多少行明细。

    Returns:
        None
    """
    print(f"\n=== {title} | count={len(rows)} ===")
    for row in list(rows)[:limit]:
        pprint(row)
    if len(rows) > limit:
        print(f"... 其余 {len(rows) - limit} 行未展示")


def _load_latest_trade_date_window(window_size: int = 5) -> tuple[str, str]:
    """从交易日历中提取最近一个查询窗口。

    Args:
        window_size: 需要覆盖的最近交易日数量。

    Returns:
        ``(start_trade_date, end_trade_date)`` 形式的闭区间边界。

    Raises:
        ValueError: 当交易日历缺失或为空时抛出。
    """
    trade_date_df = csvdb.get_trade_date()
    if "trade_date" not in trade_date_df.columns:
        raise ValueError("trade_date.csv 缺少 trade_date 列")

    # 统一清洗交易日字符串，避免 CSV 中的空值或时间格式影响查询窗口。
    trade_dates = sorted(
        {
            normalize_trade_date(str(raw_trade_date))
            for raw_trade_date in trade_date_df["trade_date"].tolist()
            if raw_trade_date is not None and str(raw_trade_date).strip().lower() not in {"", "nan", "nat"}
        }
    )
    if not trade_dates:
        raise ValueError("交易日历为空，无法构造手动检查窗口")

    scoped_trade_dates = trade_dates[-window_size:]
    return scoped_trade_dates[0], scoped_trade_dates[-1]


async def check_load_bar_data(db: DataBase) -> None:
    """手动查看单证券日线数据。"""
    query = BarDataQuery(
        vt_symbol="000001.SZSE",
        interval="d",
        adjust="non",
        start=datetime(year=2026, month=1, day=1),
        end=datetime(year=2026, month=5, day=10),
    )

    rows = await db.load_bar_data(query)
    _print_rows("load_bar_data", rows)


async def check_bar_overview(db: DataBase) -> None:
    """手动查看 K 线概览。"""
    rows = await db.get_bar_overview()
    _print_rows("get_bar_overview", rows, limit=5)


async def check_load_security_profiles(db: DataBase) -> None:
    """手动查看证券静态资料查询结果。"""
    # 同时覆盖显式证券代码过滤与重复去重场景，便于直接观察返回顺序和字段。
    query = SecurityProfileQuery(
        vt_symbols=["000001.SZSE", "510300.SSE", "000300.SSE", "000001.SZSE"],
    )
    rows = await db.load_security_profiles(query)
    _print_rows("load_security_profiles", rows)


async def check_load_security_daily_info(db: DataBase) -> None:
    """手动查看证券逐日状态查询结果。"""
    start_trade_date, end_trade_date = _load_latest_trade_date_window(window_size=5)

    # 查询窗口直接来自 trade_date.csv，便于验证数据库门面内部的交易日截断逻辑。
    query = SecurityDailyInfoQuery(
        vt_symbols=["000001.SZSE", "510300.SSE", "000300.SSE"],
        start=start_trade_date,
        end=end_trade_date,
    )
    rows = await db.load_security_daily_info(query)
    _print_rows(
        f"load_security_daily_info [{start_trade_date} ~ {end_trade_date}]",
        rows,
        limit=20,
    )


async def main() -> None:
    """执行数据库手动检查入口。"""
    db = DataBase(load_config().database_dir)
    try:
        await check_bar_overview(db)
        await check_load_security_profiles(db)
        await check_load_security_daily_info(db)
        await check_load_bar_data(db)
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())
