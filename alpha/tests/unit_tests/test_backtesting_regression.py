from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from alpha.backtest.data import BacktestInput, build_history_data
from alpha.backtest.backtesting import BackTesting
from alpha.common.schema import Direction, Interval, Offset, Product
from alpha.common.schema_trade import ContractData
from tests.manual.sma_strategy import DoubleMaStrategy

CSV_PATH = Path(__file__).resolve().parents[1] / "data" / "000001_SZ_daily_pre_20200106_20251107.csv"
VT_SYMBOL = "000001.SZSE"


def _load_csv_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with CSV_PATH.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(
                {
                    "datetime": row["datetime"],
                    "vt_symbol": row["vt_symbol"],
                    "symbol": row["symbol"],
                    "exchange": row["exchange"],
                    "interval": row["interval"],
                    "adjust": row["adjust"],
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row["volume"]),
                    "turnover": float(row["turnover"]),
                    "open_interest": float(row["open_interest"]),
                }
            )
    return rows


def _make_regression_input(rows: list[dict[str, Any]]) -> BacktestInput:
    """构造回归测试使用的回测输入。"""
    contract = ContractData(
        gateway_name="backtest",
        vt_symbol=VT_SYMBOL,
        name=VT_SYMBOL,
        product=Product.ASHARE,
        size=100,
        pricetick=0.01,
        rate=1.1 / 10_000,
        slippage=0.005,
        min_commission=1,
    )
    return BacktestInput(
        contracts={VT_SYMBOL: contract},
        history_data=build_history_data(rows),
    )


def _independent_long_only_snapshot(engine: BackTesting, final_close: float) -> dict[str, float]:
    contract = engine.contracts[VT_SYMBOL]
    position = 0.0
    avg_cost = 0.0
    realized = 0.0

    trades = sorted(engine.get_all_trades(), key=lambda t: (t.datetime, t.tradeid))
    for trade in trades:
        turnover = trade.price * trade.volume * contract.size

        if trade.offset == Offset.OPEN and trade.direction == Direction.LONG:
            total_cost = avg_cost * position * contract.size + turnover + trade.slippage + trade.commission
            position += trade.volume
            avg_cost = total_cost / (position * contract.size)
            continue

        if trade.offset == Offset.CLOSE and trade.direction == Direction.SHORT:
            realized += turnover - avg_cost * trade.volume * contract.size - trade.slippage - trade.commission
            position -= trade.volume
            if position == 0:
                avg_cost = 0.0

    frozen = position * avg_cost * contract.size
    hold_earn = (final_close - avg_cost) * position * contract.size if position > 0 else 0.0

    return {
        "position": position,
        "avg_cost": avg_cost,
        "realized": realized,
        "frozen": frozen,
        "hold_earn": hold_earn,
        "usable": engine.capital + realized - frozen,
        "total": engine.capital + realized + hold_earn,
    }


@pytest.fixture(scope="module")
def regression_result() -> dict[str, Any]:
    rows = _load_csv_rows()

    engine = BackTesting()
    engine.set_parameters(
        interval=Interval.DAILY,
        start=datetime(2020, 1, 4),
        end=datetime(2025, 11, 9),
        capital=1_000_000,
    )
    engine.load_input(_make_regression_input(rows))
    engine.add_strategy(DoubleMaStrategy, "double_ma_regression")
    engine.run_backtesting(
        {
            "fast_window": 5,
            "slow_window": 20,
            "trading_size": 1000,
        }
    )

    return {
        "rows": rows,
        "engine": engine,
    }


def test_real_stock_csv_snapshot_exists_and_has_expected_range() -> None:
    rows = _load_csv_rows()

    assert CSV_PATH.exists()
    assert len(rows) == 1415
    assert rows[0]["datetime"] == "2020-01-06 00:00:00"
    assert rows[-1]["datetime"] == "2025-11-07 00:00:00"
    assert rows[0]["vt_symbol"] == VT_SYMBOL
    assert rows[-1]["vt_symbol"] == VT_SYMBOL


def test_double_ma_strategy_runs_with_real_data_and_creates_trades(regression_result: dict[str, Any]) -> None:
    engine: BackTesting = regression_result["engine"]
    trades = engine.get_all_trades()

    assert engine.strategy.class_name == DoubleMaStrategy.class_name
    assert len(trades) > 0
    assert any(t.offset == Offset.OPEN and t.direction == Direction.LONG for t in trades)
    assert any(t.offset == Offset.CLOSE and t.direction == Direction.SHORT for t in trades)


def test_trade_cost_and_funding_math_should_be_accurate(regression_result: dict[str, Any]) -> None:
    engine: BackTesting = regression_result["engine"]
    contract = engine.contracts[VT_SYMBOL]
    trades = engine.get_all_trades()
    final_day = max(engine.portfolio.daily_account.keys())
    final_close = engine.daily_close_bars[final_day][VT_SYMBOL]["close"]

    for trade in trades:
        turnover = trade.price * trade.volume * contract.size
        assert trade.commission == pytest.approx(turnover * contract.rate)
        assert trade.slippage == pytest.approx(trade.volume * contract.size * contract.slippage)

    expected = _independent_long_only_snapshot(engine, final_close)
    account = engine.check_hold()

    assert engine.portfolio.realized_pnl == pytest.approx(expected["realized"])
    assert engine.portfolio.frozen == pytest.approx(expected["frozen"])
    assert engine.portfolio.usable == pytest.approx(expected["usable"])
    assert engine.portfolio.total == pytest.approx(expected["total"])

    assert account.realized_pnl == pytest.approx(expected["realized"])
    assert account.frozen == pytest.approx(expected["frozen"])
    assert account.usable == pytest.approx(expected["usable"])
    assert account.hold_earn == pytest.approx(expected["hold_earn"])
    assert account.total == pytest.approx(expected["total"])


def test_daily_balance_and_day_earn_should_match_equity_changes(regression_result: dict[str, Any]) -> None:
    engine: BackTesting = regression_result["engine"]
    days = sorted(engine.portfolio.daily_account.keys())

    assert days
    for day in days:
        account = engine.portfolio.daily_account[day]

        assert account.total == pytest.approx(engine.capital + account.realized_pnl + account.hold_earn)
        assert account.usable == pytest.approx(engine.capital + account.realized_pnl - account.frozen)


def test_fixed_trade_day_snapshots_should_remain_stable(regression_result: dict[str, Any]) -> None:
    engine: BackTesting = regression_result["engine"]
    snapshots = {
        "2020-02-21": {
            "trade_count": 1,
            "day_earn": -1151.0239999999606,
            "total": 998848.976,
            "usable": 81148.97600000002,
            "frozen": 918851.024,
            "realized_pnl": 0,
            "hold_earn": -1151.0239999999606,
            "hold_pos": 700.0,
        },
        "2020-03-03": {
            "trade_count": 1,
            "day_earn": -444.86400000007416,
            "total": 943104.112,
            "usable": 943104.112,
            "frozen": 0.0,
            "realized_pnl": -56895.88799999998,
            "hold_earn": 0,
            "hold_pos": 0.0,
        },
        "2024-02-07": {
            "trade_count": 0,
            "day_earn": -4199.99999999991,
            "total": 563304.1480000003,
            "usable": 80304.14800000022,
            "frozen": 476752.40400000004,
            "realized_pnl": -442943.44799999974,
            "hold_earn": 6247.596000000044,
            "hold_pos": 600.0,
        },
        "2025-10-17": {
            "trade_count": 1,
            "day_earn": -7313.470000000067,
            "total": 648487.6480000002,
            "usable": 78487.64800000016,
            "frozen": 577313.4700000001,
            "realized_pnl": -344198.88199999975,
            "hold_earn": -7313.470000000067,
            "hold_pos": 500.0,
        },
        "2025-11-07": {
            "trade_count": 0,
            "day_earn": 2000.0000000000464,
            "total": 655987.6480000002,
            "usable": 78487.64800000016,
            "frozen": 577313.4700000001,
            "realized_pnl": -344198.88199999975,
            "hold_earn": 186.52999999995146,
            "hold_pos": 500.0,
        },
    }

    for date_str, expected in snapshots.items():
        day = datetime.fromisoformat(date_str).date()
        account = engine.portfolio.daily_account[day]
        long_hold = account.long_hold.get(VT_SYMBOL)
        hold_pos = long_hold.hold_pos if long_hold else 0.0

        assert account.day_earn == pytest.approx(expected["day_earn"])
        assert account.total == pytest.approx(expected["total"])
        assert account.usable == pytest.approx(expected["usable"])
        assert account.frozen == pytest.approx(expected["frozen"])
        assert account.realized_pnl == pytest.approx(expected["realized_pnl"])
        assert account.hold_earn == pytest.approx(expected["hold_earn"])
        assert account.trade_count == expected["trade_count"]
        assert hold_pos == pytest.approx(expected["hold_pos"])


def test_account_metrics_should_never_be_negative_with_cash_constraints(
    regression_result: dict[str, Any],
) -> None:
    engine: BackTesting = regression_result["engine"]

    for account in engine.portfolio.daily_account.values():
        assert account.total >= 0


def test_portfolio_manager_daily_result_should_reflect_daily_account_snapshots(
    regression_result: dict[str, Any],
) -> None:
    engine: BackTesting = regression_result["engine"]
    current = sorted(engine.get_daily_result(), key=lambda item: item["date"])

    assert len(current) == len(engine.portfolio.daily_account)

    for row in current:
        account = engine.portfolio.daily_account[row["date"]]
        assert row["net_pnl"] == pytest.approx(account.day_earn)
        assert row["commission"] == pytest.approx(account.commission)
        assert row["slippage"] == pytest.approx(account.slippage)
        assert row["turnover"] == pytest.approx(account.turnover)
        assert row["trade_count"] == account.trade_count

    account = engine.check_hold()
    assert current[-1]["date"] == account.update
    assert current[-1]["net_pnl"] == pytest.approx(account.day_earn)
