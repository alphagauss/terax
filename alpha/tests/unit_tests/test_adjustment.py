import pytest

from alpha.storage.transforms import apply_adjustment, build_factor_map, extract_trade_date


def test_extract_trade_date_returns_iso_date() -> None:
    assert extract_trade_date("2024-01-05 09:30:00") == "2024-01-05"


def test_build_factor_map_forward_fills_latest_factor() -> None:
    trade_dates = ["2024-01-01", "2024-01-02", "2024-01-03"]
    factor_rows = [
        {"trade_date": "2024-01-01", "adj_factor": 1.0},
        {"trade_date": "2024-01-03", "adj_factor": 1.5},
    ]

    factor_map = build_factor_map(trade_dates, factor_rows)

    assert factor_map == {
        "2024-01-01": 1.0,
        "2024-01-02": 1.0,
        "2024-01-03": 1.5,
    }


def test_apply_adjustment_updates_only_price_fields() -> None:
    bars = [
        {
            "datetime": "2024-01-01 00:00:00",
            "open": 10.0,
            "high": 12.0,
            "low": 9.0,
            "close": 11.0,
            "upper_limit": 13.0,
            "lower_limit": 8.0,
            "volume": 100.0,
            "turnover": 1000.0,
            "open_interest": 0.0,
        },
        {
            "datetime": "2024-01-02 00:00:00",
            "open": 20.0,
            "high": 22.0,
            "low": 19.0,
            "close": 21.0,
            "upper_limit": 23.0,
            "lower_limit": 18.0,
            "volume": 200.0,
            "turnover": 2000.0,
            "open_interest": 0.0,
        },
    ]
    factors = [
        {"trade_date": "2024-01-01", "adj_factor": 1.0},
        {"trade_date": "2024-01-02", "adj_factor": 2.0},
    ]

    adjusted = apply_adjustment(bars, factors, "pre")

    assert adjusted[0]["close"] == pytest.approx(11.0 * 0.5)
    assert adjusted[1]["close"] == pytest.approx(21.0)
    assert adjusted[0]["upper_limit"] == pytest.approx(13.0 * 0.5)
    assert adjusted[1]["lower_limit"] == pytest.approx(18.0)
    assert adjusted[0]["volume"] == 100.0
    assert adjusted[1]["turnover"] == 2000.0


def test_apply_adjustment_non_keeps_prices_and_marks_adjust_mode() -> None:
    bars = [
        {
            "datetime": "2024-01-01 00:00:00",
            "open": 10.0,
            "high": 12.0,
            "low": 9.0,
            "close": 11.0,
            "volume": 100.0,
            "turnover": 1000.0,
            "open_interest": 0.0,
        }
    ]

    adjusted = apply_adjustment(
        bars,
        [{"trade_date": "2024-01-01", "adj_factor": 2.0}],
        "non",
    )

    assert adjusted[0]["open"] == 10.0
    assert adjusted[0]["high"] == 12.0
    assert adjusted[0]["low"] == 9.0
    assert adjusted[0]["close"] == 11.0
    assert adjusted[0]["adjust"] == "non"
    assert adjusted[0] is not bars[0]


def test_apply_adjustment_does_not_mutate_input_bars() -> None:
    bars = [
        {
            "datetime": "2024-01-01 09:30:00",
            "open": 10.0,
            "high": 11.0,
            "low": 9.0,
            "close": 10.5,
            "volume": 100.0,
            "turnover": 1000.0,
            "open_interest": 0.0,
        }
    ]
    original_close = bars[0]["close"]

    adjusted = apply_adjustment(
        bars,
        [{"trade_date": "2024-01-01", "adj_factor": 2.0}],
        "post",
    )

    assert bars[0]["close"] == original_close
    assert adjusted is not bars
    assert adjusted[0] is not bars[0]


def test_apply_adjustment_uses_same_factor_for_multiple_bars_in_one_trade_day() -> None:
    bars = [
        {
            "datetime": "2024-01-01 09:30:00",
            "open": 10.0,
            "high": 10.0,
            "low": 10.0,
            "close": 10.0,
            "volume": 100.0,
            "turnover": 1000.0,
            "open_interest": 0.0,
        },
        {
            "datetime": "2024-01-01 10:30:00",
            "open": 11.0,
            "high": 11.0,
            "low": 11.0,
            "close": 11.0,
            "volume": 101.0,
            "turnover": 1100.0,
            "open_interest": 0.0,
        },
        {
            "datetime": "2024-01-02 09:30:00",
            "open": 12.0,
            "high": 12.0,
            "low": 12.0,
            "close": 12.0,
            "volume": 102.0,
            "turnover": 1200.0,
            "open_interest": 0.0,
        },
    ]
    factors = [
        {"trade_date": "2024-01-01", "adj_factor": 1.0},
        {"trade_date": "2024-01-02", "adj_factor": 2.0},
    ]

    adjusted = apply_adjustment(bars, factors, "pre")

    assert adjusted[0]["close"] == pytest.approx(5.0)
    assert adjusted[1]["close"] == pytest.approx(5.5)
    assert adjusted[2]["close"] == pytest.approx(12.0)


def test_apply_adjustment_respects_previous_factor_before_query_start() -> None:
    bars = [
        {
            "datetime": "2024-01-03 09:30:00",
            "open": 10.0,
            "high": 10.0,
            "low": 10.0,
            "close": 10.0,
            "volume": 100.0,
            "turnover": 1000.0,
            "open_interest": 0.0,
        },
        {
            "datetime": "2024-01-04 09:30:00",
            "open": 20.0,
            "high": 20.0,
            "low": 20.0,
            "close": 20.0,
            "volume": 200.0,
            "turnover": 2000.0,
            "open_interest": 0.0,
        },
    ]
    factors = [
        {"trade_date": "2024-01-01", "adj_factor": 1.0},
        {"trade_date": "2024-01-04", "adj_factor": 1.5},
    ]

    adjusted = apply_adjustment(bars, factors, "pre")

    assert adjusted[0]["close"] == pytest.approx(10.0 / 1.5)
    assert adjusted[1]["close"] == pytest.approx(20.0)
