from __future__ import annotations

import pandas as pd

from alpha.sync_tasks.universe import convert_gm_symbol_to_vt_symbol


def normalize_optional_float(value: object) -> float | None:
    """将对象标准化为可空浮点数。"""
    if value is None or pd.isna(value):
        return None
    return float(value)


def normalize_optional_int(value: object) -> int | None:
    """将对象标准化为可空整数。"""
    if value is None or pd.isna(value):
        return None
    return int(value)


def normalize_bool_flag(value: object) -> bool | None:
    """将对象标准化为可空布尔值。"""
    if value is None or pd.isna(value):
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y"}:
        return True
    if text in {"0", "false", "f", "no", "n"}:
        return False
    return None


def normalize_index_constituent_vt_symbols(df: pd.DataFrame) -> list[str]:
    """从 GM 返回结果中提取并转换成分股 ``vt_symbol`` 列表。"""
    if "symbol" not in df.columns:
        raise ValueError("指数成分股数据缺少 symbol 列")

    vt_symbols = sorted(
        {
            convert_gm_symbol_to_vt_symbol(str(symbol))
            for symbol in df["symbol"].tolist()
            if str(symbol).strip()
        }
    )
    if not vt_symbols:
        raise ValueError("指数成分股数据为空")
    return vt_symbols
