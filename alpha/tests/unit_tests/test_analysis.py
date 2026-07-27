from __future__ import annotations

from datetime import date

import pandas as pd
import pytest
from pandas import DataFrame

from alpha.backtest.analysis import Analysis


def _sample_data() -> list[dict]:
    dates = pd.date_range("2024-01-02", periods=6, freq="D")
    return [
        {
            "date": d.date(),
            "net_pnl": pnl,
            "commission": 10,
            "slippage": 2,
            "turnover": 1000,
            "trade_count": 1,
        }
        for d, pnl in zip(dates, [200, -50, 300, -100, 0, 180], strict=True)
    ]


def test_analysis_statistics_should_calculate_daily_metrics_and_summary() -> None:
    data = _sample_data()
    analysis = Analysis(data, output=lambda _: None, capital=1_000_000)

    daily_df = analysis.calculate_dalily(returns=True)
    assert isinstance(daily_df, DataFrame)
    assert {"balance", "return", "drawdown", "ddpercent"}.issubset(set(daily_df.columns))
    assert daily_df["balance"].tolist() == [
        1_000_200,
        1_000_150,
        1_000_450,
        1_000_350,
        1_000_350,
        1_000_530,
    ]
    assert daily_df["drawdown"].tolist() == [0.0, -50.0, 0.0, -100.0, -100.0, 0.0]
    assert daily_df["ddpercent"].iloc[3] == pytest.approx(-0.009995502024089161)

    assert analysis.calculate_statistics() == {
        "start_date": date(2024, 1, 2),
        "end_date": date(2024, 1, 7),
        "total_days": 6,
        "profit_days": 3,
        "loss_days": 2,
        "end_balance": 1_000_530,
        "max_drawdown": -100.0,
        "max_ddpercent": -0.01,
        "max_drawdown_duration": 1,
        "total_net_pnl": 530,
        "daily_net_pnl": 88.33,
        "total_commission": 60,
        "daily_commission": 10.0,
        "total_slippage": 12,
        "daily_slippage": 2.0,
        "total_turnover": 6000,
        "daily_turnover": 1000.0,
        "total_trade_count": 6,
        "daily_trade_count": 1.0,
        "total_return": 0.05,
        "annual_return": 2.12,
        "daily_return": 0.01,
        "return_std": 0.02,
        "sharpe_ratio": 8.55,
        "ewm_sharpe": 8.54,
        "return_drawdown_ratio": 5.3,
    }


def test_analysis_should_fill_missing_columns_and_compute() -> None:
    data = [
        {"date": date(2024, 1, 1), "net_pnl": 10},
        {"date": date(2024, 1, 2), "net_pnl": -5},
    ]
    analysis = Analysis(data, output=lambda _: None, capital=100)
    analysis.calculate_dalily()
    stats = analysis.calculate_statistics()

    assert "commission" in analysis.df.columns
    assert "slippage" in analysis.df.columns
    assert "turnover" in analysis.df.columns
    assert "trade_count" in analysis.df.columns
    assert stats["total_days"] == 2


def test_analysis_empty_data_should_return_empty_results() -> None:
    analysis = Analysis([], output=lambda _: None)

    assert analysis.calculate_dalily() == []
    assert analysis.calculate_statistics() == {}


def test_analysis_zero_std_path_should_set_sharpe_to_zero() -> None:
    data = [
        {
            "date": date(2024, 1, 1),
            "net_pnl": 0,
            "commission": 0,
            "slippage": 0,
            "turnover": 0,
            "trade_count": 0,
        },
        {
            "date": date(2024, 1, 2),
            "net_pnl": 0,
            "commission": 0,
            "slippage": 0,
            "turnover": 0,
            "trade_count": 0,
        },
    ]
    analysis = Analysis(data, output=lambda _: None, capital=100)
    stats = analysis.calculate_statistics()

    assert stats["return_std"] == 0
    assert stats["sharpe_ratio"] == 0
    assert stats["ewm_sharpe"] == 0


def test_analysis_margin_call_branch_should_clip_balance_to_zero() -> None:
    data = [
        {
            "date": date(2024, 1, 1),
            "net_pnl": -200,
            "commission": 0,
            "slippage": 0,
            "turnover": 0,
            "trade_count": 0,
        },
        {
            "date": date(2024, 1, 2),
            "net_pnl": 10,
            "commission": 0,
            "slippage": 0,
            "turnover": 0,
            "trade_count": 0,
        },
    ]
    analysis = Analysis(data, output=lambda _: None, capital=100)
    result = analysis.calculate_dalily(returns=True)

    assert result is None
    assert analysis.df["balance"].min() == 0


def test_analysis_show_chart_should_render_plotly_figure(monkeypatch: pytest.MonkeyPatch) -> None:
    data = _sample_data()
    analysis = Analysis(data, output=lambda _: None, capital=1_000_000)
    analysis.calculate_dalily()

    captured: dict[str, object] = {}

    def fake_show(self: object) -> None:
        captured["figure"] = self

    monkeypatch.setattr("plotly.graph_objs._figure.Figure.show", fake_show)

    analysis.show_chart()

    figure = captured["figure"]
    assert figure is not None
    assert len(figure.data) == 4
    assert figure.layout.height == 1000
    assert figure.layout.width == 1000
