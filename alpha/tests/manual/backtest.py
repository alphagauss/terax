from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pandas as pd

from alpha.backtest.data import BacktestDataScope
from alpha.backtest.runner import BacktestJobSpec, run_backtest_job
from alpha.common.schema import Interval, Product
from tests.manual.sma_strategy import DoubleMaStrategy


def save_records(path: str, rows: list[dict[str, object]]) -> None:
    """保存手工回测记录。

    Args:
        path: 输出文件路径。
        rows: 待保存记录列表。

    Returns:
        无返回值。
    """

    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(f"{row}\n\n")


def main() -> None:
    """运行一次手工双均线回测。"""

    scope = BacktestDataScope(
        vt_symbols=["000001.SZSE"],
        product=Product.ASHARE,
        interval=Interval.DAILY,
        start=datetime(2020, 1, 4),
        end=datetime(2025, 11, 9),
        price_adjust="pre",
    )
    spec = BacktestJobSpec(
        instance_name="manual_double_ma",
        strategy_class=DoubleMaStrategy,
        data_scope=scope,
        capital=1_000_000,
    )
    result = run_backtest_job(
        spec,
        {
            "fast_window": 5,
            "slow_window": 20,
            "trading_size": 1000,
        },
    )

    pd.DataFrame(result["daily_results"]).to_csv(
        ".data/temp_bt_daily.csv",
        encoding="utf-8-sig",
        index=False,
    )
    print(result["statistics"])

    save_records(".data/temp_trades.txt", result["trades"])


if __name__ == "__main__":
    main()
