from __future__ import annotations

import pandas as pd
import pytest

from alpha.sync_tasks.normalizers import (
    normalize_bool_flag,
    normalize_index_constituent_vt_symbols,
    normalize_optional_float,
    normalize_optional_int,
)


def test_optional_number_normalizers_parse_values_and_nulls() -> None:
    assert normalize_optional_float("1.2") == 1.2
    assert normalize_optional_float(None) is None
    assert normalize_optional_int("3") == 3
    assert normalize_optional_int(None) is None


def test_bool_flag_normalizer_supports_text_numeric_and_null_values() -> None:
    assert normalize_bool_flag("true") is True
    assert normalize_bool_flag("0") is False
    assert normalize_bool_flag(1) is True
    assert normalize_bool_flag("unknown") is None
    assert normalize_bool_flag(None) is None


def test_normalize_index_constituent_vt_symbols_sorts_and_deduplicates() -> None:
    df = pd.DataFrame(
        [
            {"symbol": "SZSE.000001"},
            {"symbol": "SHSE.600000"},
            {"symbol": "SHSE.600000"},
        ]
    )

    assert normalize_index_constituent_vt_symbols(df) == ["000001.SZSE", "600000.SSE"]


def test_normalize_index_constituent_vt_symbols_rejects_invalid_payloads() -> None:
    with pytest.raises(ValueError, match="缺少 symbol"):
        normalize_index_constituent_vt_symbols(pd.DataFrame([{"code": "SHSE.600000"}]))

    with pytest.raises(ValueError, match="数据为空"):
        normalize_index_constituent_vt_symbols(pd.DataFrame([{"symbol": ""}]))
