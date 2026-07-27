from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from typing import Literal

from alpha.common.schema_market import AdjustFactorPayload, ShareCapitalPayload

AdjustMode = Literal["pre", "post", "non"]
PRICE_FIELDS = ("open", "high", "low", "close")
VIEW_PRICE_FIELDS = (*PRICE_FIELDS, "upper_limit", "lower_limit")
ShareCapitalState = tuple[float | None, float | None, float | None]


def extract_trade_date(datetime_text: str) -> str:
    """从时间字符串中提取交易日。

    统一返回 ``YYYY-MM-DD`` 格式，供因子表和 K 线映射使用。

    Args:
        datetime_text: K 线时间字符串，约定为 ``YYYY-MM-DD HH:MM:SS`` 格式。

    Returns:
        交易日字符串。
    """

    return datetime_text[:10]


def normalize_trade_date(value: str | date | datetime) -> str:
    """标准化交易日格式。

    Args:
        value: 原始交易日值，支持 ``str``、``date``、``datetime``。

    Returns:
        ``YYYY-MM-DD`` 格式的交易日字符串。
    """

    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return datetime.fromisoformat(value).date().isoformat()


def build_factor_map(
    trade_dates: list[str],
    factor_rows: list[dict],
) -> dict[str, float]:
    """构造按交易日索引的累计因子映射。

    当部分交易日没有因子记录时，沿用上一交易日因子；若整个区间都没有
    因子数据，则退化为 ``1.0``。

    Args:
        trade_dates: 查询结果中的交易日列表。
        factor_rows: 因子查询结果，元素至少包含 ``trade_date`` 与 ``adj_factor``。

    Returns:
        交易日到累计因子的映射。
    """

    unique_dates = sorted(set(trade_dates))
    if not unique_dates:
        return {}

    normalized_rows = sorted(
        (
            (
                normalize_trade_date(str(row["trade_date"])),
                float(row["adj_factor"]),
            )
            for row in factor_rows
        ),
        key=lambda item: item[0],
    )
    if not normalized_rows:
        return {trade_date: 1.0 for trade_date in unique_dates}

    normalized_map: dict[str, float] = {}
    last_factor = 1.0
    row_index = 0

    # 查询区间起点之前最近一次生效的累计因子，决定了区间第一天的复权基准。
    while row_index < len(normalized_rows) and normalized_rows[row_index][0] < unique_dates[0]:
        last_factor = normalized_rows[row_index][1]
        row_index += 1

    for trade_date in unique_dates:
        # 累计因子是稀疏变化点，这里按日期顺序推进并沿用最近一次已生效的值。
        while row_index < len(normalized_rows) and normalized_rows[row_index][0] <= trade_date:
            last_factor = normalized_rows[row_index][1]
            row_index += 1
        normalized_map[trade_date] = last_factor
    return normalized_map


def resolve_base_factor(
    adjust: AdjustMode,
    factor_map: dict[str, float],
    trade_dates: list[str],
) -> float:
    """根据复权模式选择锚点因子。

    Args:
        adjust: 复权模式。
        factor_map: 交易日因子映射。
        trade_dates: 查询结果中的交易日列表。

    Returns:
        用于归一化的基准因子。
    """

    if adjust == "non" or not trade_dates:
        return 1.0

    anchor_date = trade_dates[-1] if adjust == "pre" else trade_dates[0]
    return factor_map.get(anchor_date, 1.0) or 1.0


def apply_adjustment(
    bars: list[dict],
    factor_rows: list[dict],
    adjust: AdjustMode,
) -> list[dict]:
    """对原始 K 线应用复权。

    仅调整当前价格视图字段，成交量与成交额保持原值，避免在不同市场规则下
    引入额外假设。若 bar 中带有 ``upper_limit`` / ``lower_limit``，也会按同一
    复权因子换算，保证策略看到的涨跌停价与 OHLC 处于同一价格口径。函数会
    返回新的结果列表，不修改输入参数中的原始 bar 对象。

    Args:
        bars: 原始 K 线列表。
        factor_rows: 因子查询结果。
        adjust: 复权模式。

    Returns:
        处理后的 K 线列表。
    """

    if not bars:
        return []

    normalized_bars = [dict(bar) for bar in bars]
    if adjust == "non":
        for bar in normalized_bars:
            bar["adjust"] = "non"
        return normalized_bars

    first_trade_date = extract_trade_date(str(normalized_bars[0]["datetime"]))
    last_trade_date = extract_trade_date(str(normalized_bars[-1]["datetime"]))
    normalized_factors = sorted(
        (
            (
                normalize_trade_date(str(row["trade_date"])),
                float(row["adj_factor"]),
            )
            for row in factor_rows
        ),
        key=lambda item: item[0],
    )

    current_factor = 1.0
    factor_index = 0

    # 先吸收查询起点之前最近一次已生效的因子，保证区间前半段不会错误回退为 1.0。
    while (
        factor_index < len(normalized_factors)
        and normalized_factors[factor_index][0] < first_trade_date
    ):
        current_factor = normalized_factors[factor_index][1]
        factor_index += 1

    base_factor = current_factor
    if adjust == "pre":
        # 前复权以区间最后一个交易日为锚点，因此先预扫一遍拿到末日因子。
        preview_factor = current_factor
        preview_index = factor_index
        while (
            preview_index < len(normalized_factors)
            and normalized_factors[preview_index][0] <= last_trade_date
        ):
            preview_factor = normalized_factors[preview_index][1]
            preview_index += 1
        base_factor = preview_factor

    previous_trade_date = ""
    current_scale = current_factor / base_factor
    for bar in normalized_bars:
        trade_date = extract_trade_date(str(bar["datetime"]))
        if trade_date != previous_trade_date:
            # bars 已按 datetime 升序排列，因此可与稀疏因子表做双指针线性扫描。
            while (
                factor_index < len(normalized_factors)
                and normalized_factors[factor_index][0] <= trade_date
            ):
                current_factor = normalized_factors[factor_index][1]
                factor_index += 1
            current_scale = current_factor / base_factor
            previous_trade_date = trade_date

        # 复权只调整当前价格视图，不改成交量与成交额等非价格字段。
        for field in VIEW_PRICE_FIELDS:
            field_value = bar.get(field)
            if field_value is None:
                continue
            bar[field] = float(field_value) * current_scale
        bar["adjust"] = adjust

    return normalized_bars


def build_adjust_factor_meta_rows(
    factors: list[AdjustFactorPayload],
    *,
    last_sync_at: str,
) -> list[dict[str, str]]:
    """根据复权因子生成元信息更新行。

    Args:
        factors: 标准化复权因子写入载荷。
        last_sync_at: 本次同步时间戳。

    Returns:
        按证券聚合后的元信息更新行列表。
    """

    latest_trade_date_by_symbol: dict[str, str] = {}
    for factor in factors:
        vt_symbol = str(factor["vt_symbol"])
        trade_date = str(factor["trade_date"])
        current_latest = latest_trade_date_by_symbol.get(vt_symbol)
        if current_latest is None or trade_date > current_latest:
            latest_trade_date_by_symbol[vt_symbol] = trade_date

    return [
        {
            "vt_symbol": vt_symbol,
            "latest_trade_date": latest_trade_date,
            "last_sync_at": last_sync_at,
        }
        for vt_symbol, latest_trade_date in latest_trade_date_by_symbol.items()
    ]


def collect_adjust_factor_first_trade_dates(
    factors: list[AdjustFactorPayload],
) -> dict[str, str]:
    """提取每个证券在当前写入批次中的最早交易日。

    Args:
        factors: 标准化复权因子写入载荷。

    Returns:
        ``{vt_symbol: first_trade_date}`` 形式的映射。
    """

    first_trade_date_by_symbol: dict[str, str] = {}
    for factor in factors:
        vt_symbol = str(factor["vt_symbol"])
        trade_date = str(factor["trade_date"])
        current_first = first_trade_date_by_symbol.get(vt_symbol)
        if current_first is None or trade_date < current_first:
            first_trade_date_by_symbol[vt_symbol] = trade_date
    return first_trade_date_by_symbol


def build_sparse_adjust_factor_rows(
    factors: list[AdjustFactorPayload],
    latest_factor_by_symbol: dict[str, float],
) -> list[AdjustFactorPayload]:
    """将复权因子压缩为仅保留变化点的稀疏记录。

    Args:
        factors: 标准化复权因子写入载荷。
        latest_factor_by_symbol: 各证券在本批最早交易日前最近一次已存储的累计因子。

    Returns:
        稀疏化后的变化点记录列表。
    """

    latest_rows_by_key: dict[tuple[str, str], AdjustFactorPayload] = {}
    for factor in factors:
        key = (str(factor["vt_symbol"]), str(factor["trade_date"]))
        latest_rows_by_key[key] = factor

    grouped_rows: dict[str, list[AdjustFactorPayload]] = defaultdict(list)
    for vt_symbol, trade_date in sorted(latest_rows_by_key):
        grouped_rows[vt_symbol].append(latest_rows_by_key[(vt_symbol, trade_date)])

    sparse_rows: list[AdjustFactorPayload] = []
    for vt_symbol, rows in grouped_rows.items():
        previous_factor = latest_factor_by_symbol.get(vt_symbol)
        for row in rows:
            current_factor = float(row["adj_factor"])
            if previous_factor is None or current_factor != previous_factor:
                sparse_rows.append(row)
            previous_factor = current_factor
    return sparse_rows


def extract_share_capital_state(
    row: ShareCapitalPayload,
) -> ShareCapitalState:
    """提取用于比较是否变化的股本状态。

    Args:
        row: 标准化股本变化写入载荷。

    Returns:
        ``(total_share, float_share, free_share)`` 形式的比较状态。
    """

    return (
        None if row["total_share"] is None else float(row["total_share"]),
        None if row["float_share"] is None else float(row["float_share"]),
        None if row["free_share"] is None else float(row["free_share"]),
    )


def build_share_capital_meta_rows(
    rows: list[ShareCapitalPayload],
    *,
    last_sync_at: str,
) -> list[dict[str, str]]:
    """根据写入数据生成股本同步元信息更新行。

    Args:
        rows: 标准化股本变化写入载荷。
        last_sync_at: 本次同步时间戳。

    Returns:
        按证券聚合后的元信息更新行列表。
    """

    latest_trade_date_by_symbol: dict[str, str] = {}
    for row in rows:
        vt_symbol = str(row["vt_symbol"])
        trade_date = str(row["trade_date"])
        current_latest = latest_trade_date_by_symbol.get(vt_symbol)
        if current_latest is None or trade_date > current_latest:
            latest_trade_date_by_symbol[vt_symbol] = trade_date

    return [
        {
            "vt_symbol": vt_symbol,
            "latest_trade_date": latest_trade_date,
            "last_sync_at": last_sync_at,
        }
        for vt_symbol, latest_trade_date in latest_trade_date_by_symbol.items()
    ]


def collect_share_capital_first_trade_dates(
    rows: list[ShareCapitalPayload],
) -> dict[str, str]:
    """提取每个证券在当前写入批次中的最早交易日。

    Args:
        rows: 标准化股本变化写入载荷。

    Returns:
        ``{vt_symbol: first_trade_date}`` 形式的映射。
    """

    earliest_trade_dates: dict[str, str] = {}
    for row in rows:
        vt_symbol = str(row["vt_symbol"])
        trade_date = str(row["trade_date"])
        current_earliest = earliest_trade_dates.get(vt_symbol)
        if current_earliest is None or trade_date < current_earliest:
            earliest_trade_dates[vt_symbol] = trade_date
    return earliest_trade_dates


def build_sparse_share_capital_rows(
    rows: list[ShareCapitalPayload],
    previous_state_map: dict[str, ShareCapitalState | None],
) -> list[ShareCapitalPayload]:
    """压缩股本记录，仅保留相对上一状态发生变化的节点。

    Args:
        rows: 标准化股本变化写入载荷。
        previous_state_map: 各证券在本批最早交易日前最近一次已存储状态。

    Returns:
        稀疏化后的变化点记录列表。
    """

    sorted_rows = sorted(
        rows,
        key=lambda row: (
            str(row["vt_symbol"]),
            str(row["trade_date"]),
            str(row["updated_at"]),
        ),
    )

    deduped_rows: list[ShareCapitalPayload] = []
    for row in sorted_rows:
        if (
            deduped_rows
            and deduped_rows[-1]["vt_symbol"] == row["vt_symbol"]
            and deduped_rows[-1]["trade_date"] == row["trade_date"]
        ):
            deduped_rows[-1] = row
            continue
        deduped_rows.append(row)

    sparse_rows: list[ShareCapitalPayload] = []
    current_symbol = ""
    previous_state: ShareCapitalState | None = None

    for row in deduped_rows:
        vt_symbol = str(row["vt_symbol"])
        row_state = extract_share_capital_state(row)
        if vt_symbol != current_symbol:
            current_symbol = vt_symbol
            previous_state = previous_state_map.get(vt_symbol)

        if row_state == previous_state:
            continue

        sparse_rows.append(row)
        previous_state = row_state

    return sparse_rows
