import importlib
import sys
import types

import numpy as np


def _load_indicator_with_fake_talib(monkeypatch):
    fake_talib = types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "talib", fake_talib)
    sys.modules.pop("alpha.backtest.indicator", None)
    import alpha.backtest.indicator as indicator_module

    return importlib.reload(indicator_module), fake_talib


def test_pick_and_pick_tuple():
    from alpha.backtest.indicator import Indicators

    arr_a = np.array([1.0, 2.0, 3.0])
    arr_b = np.array([4.0, 5.0, 6.0])

    assert Indicators._pick(arr_a, array=True) is arr_a
    assert Indicators._pick(arr_a, array=False) == 3.0

    assert Indicators._pick_tuple(arr_a, arr_b, array=True) == (arr_a, arr_b)
    assert Indicators._pick_tuple(arr_a, arr_b, array=False) == (3.0, 6.0)


def test_sma_passes_args_and_respects_array_flag(monkeypatch):
    indicator_module, fake_talib = _load_indicator_with_fake_talib(monkeypatch)
    calls = {}

    def fake_sma(close, n):
        calls["args"] = (close, n)
        return np.array([10.0, 20.0, 30.0])

    fake_talib.SMA = fake_sma
    close = np.array([1.0, 2.0, 3.0])

    arr_result = indicator_module.Indicators.sma(close, 5, array=True)
    val_result = indicator_module.Indicators.sma(close, 5, array=False)

    assert calls["args"] == (close, 5)
    assert np.array_equal(arr_result, np.array([10.0, 20.0, 30.0]))
    assert val_result == 30.0


def test_macd_returns_tuple_of_last_values_when_array_false(monkeypatch):
    indicator_module, fake_talib = _load_indicator_with_fake_talib(monkeypatch)
    calls = {}

    def fake_macd(close, fast_period, slow_period, signal_period):
        calls["args"] = (close, fast_period, slow_period, signal_period)
        return (
            np.array([1.0, 2.0]),
            np.array([3.0, 4.0]),
            np.array([5.0, 6.0]),
        )

    fake_talib.MACD = fake_macd
    close = np.array([1.0, 2.0])

    result = indicator_module.Indicators.macd(close, 12, 26, 9, array=False)

    assert calls["args"] == (close, 12, 26, 9)
    assert result == (2.0, 4.0, 6.0)


def test_boll_computes_up_down_from_sma_and_stddev(monkeypatch):
    indicator_module, fake_talib = _load_indicator_with_fake_talib(monkeypatch)

    fake_talib.SMA = lambda close, n: np.array([10.0, 20.0])
    fake_talib.STDDEV = lambda close, n, nbdev: np.array([1.0, 2.0])

    close = np.array([1.0, 2.0])
    up, down = indicator_module.Indicators.boll(close, 2, 2.0, array=True)
    up_last, down_last = indicator_module.Indicators.boll(close, 2, 2.0, array=False)

    assert np.array_equal(up, np.array([12.0, 24.0]))
    assert np.array_equal(down, np.array([8.0, 16.0]))
    assert (up_last, down_last) == (24.0, 16.0)


def test_aroon_returns_up_then_down(monkeypatch):
    indicator_module, fake_talib = _load_indicator_with_fake_talib(monkeypatch)

    down = np.array([11.0, 22.0])
    up = np.array([33.0, 44.0])
    fake_talib.AROON = lambda high, low, n: (down, up)

    high = np.array([1.0, 2.0])
    low = np.array([0.5, 1.0])

    aroon_up, aroon_down = indicator_module.Indicators.aroon(high, low, 14, array=False)

    assert (aroon_up, aroon_down) == (44.0, 22.0)


def test_atr_parameter_order_is_high_low_close(monkeypatch):
    indicator_module, fake_talib = _load_indicator_with_fake_talib(monkeypatch)
    calls = {}

    def fake_atr(high, low, close, n):
        calls["args"] = (high, low, close, n)
        return np.array([7.0, 8.0])

    fake_talib.ATR = fake_atr

    close = np.array([10.0, 11.0])
    high = np.array([12.0, 13.0])
    low = np.array([9.0, 10.0])
    value = indicator_module.Indicators.atr(close, high, low, 14, array=False)

    assert calls["args"] == (high, low, close, 14)
    assert value == 8.0
