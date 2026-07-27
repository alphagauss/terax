from __future__ import annotations

from alpha.common.schema_market import SecurityStatusMetaPayload
from alpha.common.enums import Interval
from alpha.storage.database import DataBase
from alpha.sync_tasks.calendar import parse_date_like


async def load_security_status_meta_map(db: DataBase) -> dict[str, dict[str, object]]:
    """加载证券状态同步游标映射。

    返回值以 ``vt_symbol`` 为键，值中至少包含：

    - ``latest_checked_trade_date``：最新已检查交易日；
    - ``latest_data_trade_date``：最新拿到有效数据的交易日；
    - ``is_terminal``：是否已进入无需继续探测的终态。
    """
    return await db.load_security_status_metas()


async def load_index_constituent_meta_map(db: DataBase, indices: list) -> dict[str, str]:
    """加载指数成分股同步边界映射。"""
    meta_map: dict[str, str] = {}
    for security in indices:
        meta = await db.load_index_constituent_meta(security.vt_symbol)
        if meta is None:
            continue
        latest_trade_date = parse_date_like(meta.get("latest_trade_date"))
        if latest_trade_date is None:
            continue
        meta_map[security.vt_symbol] = latest_trade_date.isoformat()
    return meta_map


async def load_bar_overview_map(db: DataBase) -> dict[str, dict[str, object]]:
    """加载现有日线概览。"""
    overview_map: dict[str, dict[str, object]] = {}
    for row in await db.get_bar_overview():
        if row["interval"] != Interval.DAILY.value:
            continue
        overview_map[str(row["vt_symbol"])] = row
    return overview_map


async def flush_security_sync_buffers(
    db: DataBase,
    *,
    profile_rows: list[dict[str, object]],
    suspended_events: list[dict[str, object]],
    st_events: list[dict[str, object]],
    adjust_factor_rows: list[dict[str, object]],
    limit_bar_rows: list[dict[str, object]],
    status_meta_map: dict[str, SecurityStatusMetaPayload],
) -> dict[str, int]:
    """将证券信息同步缓冲批量写入数据库。"""
    profile_count = len(profile_rows)
    suspended_count = len(suspended_events)
    st_count = len(st_events)
    factor_count = len(adjust_factor_rows)
    limit_bar_count = len(limit_bar_rows)
    meta_count = len(status_meta_map)

    if profile_rows and not await db.save_security_profiles(profile_rows):
        raise RuntimeError("保存 security_profile 失败")
    if suspended_events and not await db.save_suspended_day_events(suspended_events):
        raise RuntimeError("保存停牌事件失败")
    if st_events and not await db.save_st_day_events(st_events):
        raise RuntimeError("保存 ST 事件失败")
    if adjust_factor_rows and not await db.save_adjust_factors(adjust_factor_rows):
        raise RuntimeError("保存复权因子失败")
    if limit_bar_rows and not await db.save_bar_data(limit_bar_rows, adjust="non", update_overview=False):
        raise RuntimeError("保存涨跌停价补写失败")
    if status_meta_map:
        meta_rows = list(status_meta_map.values())
        if not await db.save_security_status_metas(meta_rows):
            raise RuntimeError("保存证券状态同步游标失败")

    profile_rows.clear()
    suspended_events.clear()
    st_events.clear()
    adjust_factor_rows.clear()
    limit_bar_rows.clear()
    status_meta_map.clear()

    return {
        "profiles": profile_count,
        "suspended_events": suspended_count,
        "st_events": st_count,
        "adjust_factors": factor_count,
        "limit_bars": limit_bar_count,
        "metas": meta_count,
    }


async def save_rows_to_db(
    db: DataBase,
    rows: list[dict[str, object]],
    *,
    update_overview: bool,
) -> bool:
    """写入数据库。"""
    if not rows:
        return False
    return await db.save_bar_data(rows, adjust="non", update_overview=update_overview)


async def flush_year_buffer(db: DataBase, rows: list[dict[str, object]]) -> int:
    """将当前年份缓冲区批量写入数据库。"""
    if not rows:
        return 0
    row_count = len(rows)
    await save_rows_to_db(db, rows, update_overview=False)
    rows.clear()
    return row_count
