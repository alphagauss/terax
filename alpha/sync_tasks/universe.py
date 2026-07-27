from __future__ import annotations

from alpha.common.enums import Exchange
from alpha.storage import csvdb
from alpha.sync_tasks.calendar import parse_date_like
from alpha.sync_tasks.models import SecurityInfo


def map_gm_exchange_to_db_exchange(gm_exchange: str) -> str:
    """将 GM 交易所代码映射为数据库内部交易所代码。"""
    mapping = {
        "SHSE": Exchange.SSE.value,
        "SZSE": Exchange.SZSE.value,
        "BJSE": Exchange.BSE.value,
    }
    try:
        return mapping[gm_exchange]
    except KeyError as exc:
        raise ValueError(f"不支持的 GM 交易所代码: {gm_exchange}") from exc


def convert_gm_symbol_to_vt_symbol(gm_symbol: str) -> str:
    """将 GM 代码转换为数据库使用的 ``vt_symbol``。"""
    normalized_symbol = gm_symbol.strip()
    if "." not in normalized_symbol:
        raise ValueError(f"GM 代码格式不正确: {gm_symbol}")
    gm_exchange, sec_id = normalized_symbol.split(".", 1)
    db_exchange = map_gm_exchange_to_db_exchange(gm_exchange)
    return f"{sec_id}.{db_exchange}"


def load_trade_dates_from_csv() -> list:
    """加载非空交易日列表。"""
    df = csvdb.get_trade_date()
    if "trade_date" not in df.columns:
        raise ValueError("trade_date.csv 缺少 trade_date 列")

    trade_dates = sorted(
        {
            parsed
            for raw_value in df["trade_date"].tolist()
            if (parsed := parse_date_like(raw_value)) is not None
        }
    )
    if not trade_dates:
        raise ValueError("交易日历为空，无法执行增量更新")
    return trade_dates


def load_symbol_universe_from_csv() -> list[SecurityInfo]:
    """加载指数、ETF 和沪深股票证券池。"""
    raw_infos = csvdb.get_a_share_infos()
    universe: list[SecurityInfo] = []
    asset_type_map = {
        "gm_a_share_stock_infos": "stock",
        "gm_a_share_etf_infos": "etf",
        "gm_a_share_idx_infos": "index",
    }

    for table_name, asset_type in asset_type_map.items():
        df = raw_infos[table_name]
        for row in df.itertuples(index=False):
            # 兼容旧版原始 CSV（symbol/exchange）与新版标准化 CSV（gm_symbol/vt_symbol）。
            gm_symbol = str(getattr(row, "gm_symbol", getattr(row, "symbol", ""))).strip()
            if not gm_symbol or "." not in gm_symbol:
                continue

            gm_exchange = str(getattr(row, "exchange", gm_symbol.split(".", 1)[0])).strip()
            _, sec_id = gm_symbol.split(".", 1)
            listed_date = parse_date_like(getattr(row, "listed_date", None))
            if listed_date is None:
                continue

            delisted_date_raw = parse_date_like(getattr(row, "delisted_date", None))
            delisted_date = (
                None if delisted_date_raw is None or delisted_date_raw.year >= 2038 else delisted_date_raw
            )
            db_exchange = map_gm_exchange_to_db_exchange(gm_exchange)
            vt_symbol = f"{sec_id}.{db_exchange}"
            universe.append(
                SecurityInfo(
                    asset_type=asset_type,
                    gm_symbol=gm_symbol,
                    gm_exchange=gm_exchange,
                    sec_id=sec_id,
                    db_exchange=db_exchange,
                    vt_symbol=vt_symbol,
                    listed_date=listed_date,
                    delisted_date=delisted_date,
                )
            )

    return universe
