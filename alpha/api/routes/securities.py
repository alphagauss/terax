"""Alpha 证券浏览接口。"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.api.routes._utils import clamp_limit, clamp_offset, date_text
from alpha.common.schema_market import SecurityProfileQuery

router = APIRouter()


def _split_vt_symbol(vt_symbol: str) -> tuple[str, str]:
    """拆分证券代码。

    Args:
        vt_symbol: 项目内部证券代码。

    Returns:
        证券代码和交易所文本。
    """

    if "." not in vt_symbol:
        return vt_symbol, ""
    symbol, exchange = vt_symbol.rsplit(".", 1)
    return symbol, exchange


def _security_name(row: dict[str, object]) -> str:
    """提取证券展示名称。

    Args:
        row: 证券资料行。

    Returns:
        证券简称、名称或代码。
    """

    for key in ("sec_abbr", "sec_name", "name", "symbol"):
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return str(row.get("vt_symbol") or "")


def _profile_summary(
    row: dict[str, object],
    latest_bar_by_symbol: dict[str, str],
) -> dict[str, object]:
    """构造证券摘要响应。

    Args:
        row: 证券资料行。
        latest_bar_by_symbol: 每个证券的最新 K 线日期。

    Returns:
        前端列表项。
    """

    vt_symbol = str(row.get("vt_symbol") or "")
    symbol, exchange = _split_vt_symbol(vt_symbol)
    is_terminal = bool(row.get("is_terminal") or row.get("delisted_date"))
    return {
        "vt_symbol": vt_symbol,
        "symbol": symbol,
        "exchange": exchange,
        "name": _security_name(row),
        "product": str(row.get("asset_type") or row.get("product") or "stock"),
        "status": "delisted" if is_terminal else "active",
        "latest_bar_date": latest_bar_by_symbol.get(vt_symbol),
    }


def _latest_bar_map(rows: list[dict[str, object]]) -> dict[str, str]:
    """构造最新 K 线日期索引。

    Args:
        rows: K 线概览行。

    Returns:
        证券代码到最新日期的映射。
    """

    result: dict[str, str] = {}
    for row in rows:
        vt_symbol = str(row.get("vt_symbol") or "")
        latest = date_text(row.get("end"))
        if not vt_symbol or latest is None:
            continue
        latest = latest[:10]
        if vt_symbol not in result or latest > result[vt_symbol]:
            result[vt_symbol] = latest
    return result


def _coverage(rows: list[dict[str, object]], vt_symbol: str) -> dict[str, dict[str, object]]:
    """构造单证券数据覆盖范围。

    Args:
        rows: K 线概览行。
        vt_symbol: 目标证券代码。

    Returns:
        周期到覆盖范围的映射。
    """

    coverage: dict[str, dict[str, object]] = {}
    for row in rows:
        if str(row.get("vt_symbol") or "") != vt_symbol:
            continue
        interval = str(row.get("interval") or "")
        if not interval:
            continue
        coverage[interval] = {
            "start": date_text(row.get("start")),
            "end": date_text(row.get("end")),
            "rows": row.get("count") or 0,
        }
    return coverage


@router.get("/securities", response_model=dict[str, object])
async def list_securities(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    keyword: str | None = None,
    exchange: str | None = None,
    product: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, object]:
    """搜索证券摘要列表。

    Args:
        services: Alpha 业务服务容器。
        keyword: 代码或名称关键词。
        exchange: 交易所过滤。
        product: 资产类型过滤。
        limit: 页大小。
        offset: 偏移量。

    Returns:
        分页证券摘要。
    """

    profiles = await services.database.load_security_profiles(
        SecurityProfileQuery(asset_type=product),
    )
    overview = await services.database.get_bar_overview()
    latest_bar_by_symbol = _latest_bar_map(overview)
    keyword_text = None if keyword is None else keyword.strip().lower()
    exchange_text = None if exchange is None else exchange.strip().lower()

    items: list[dict[str, object]] = []
    for row in profiles:
        summary = _profile_summary(row, latest_bar_by_symbol)
        searchable = " ".join(
            str(summary.get(key) or "")
            for key in ("vt_symbol", "symbol", "exchange", "name", "product")
        ).lower()
        if keyword_text and keyword_text not in searchable:
            continue
        if exchange_text and exchange_text != str(summary["exchange"]).lower():
            continue
        items.append(summary)

    normalized_limit = clamp_limit(limit, default=50)
    normalized_offset = clamp_offset(offset)
    return {
        "items": items[normalized_offset : normalized_offset + normalized_limit],
        "total": len(items),
    }


@router.get("/securities/{vt_symbol}", response_model=dict[str, object])
async def get_security(
    vt_symbol: str,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict[str, object]:
    """读取证券详情。

    Args:
        vt_symbol: 项目内部证券代码。
        services: Alpha 业务服务容器。

    Returns:
        证券资料、数据覆盖和少量附属信息。

    Raises:
        HTTPException: 证券不存在。
    """

    profiles = await services.database.load_security_profiles(
        SecurityProfileQuery(vt_symbols=[vt_symbol]),
    )
    if not profiles:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "证券不存在")

    overview = await services.database.get_bar_overview()
    profile = _profile_summary(profiles[0], _latest_bar_map(overview))

    latest_daily_info: dict[str, object] = {}
    if hasattr(services.database, "load_security_status_meta"):
        meta = await services.database.load_security_status_meta(vt_symbol)
        latest_daily_info = {} if meta is None else dict(meta)

    share_capital: list[dict[str, object]] = []
    if hasattr(services.database, "load_share_capital_changes"):
        rows = await services.database.load_share_capital_changes(
            vt_symbol,
            date(1900, 1, 1),
            date.today(),
        )
        share_capital = list(rows)[-50:]

    return {
        "profile": profile,
        "coverage": _coverage(overview, vt_symbol),
        "latest_daily_info": latest_daily_info,
        "status_events": [],
        "share_capital": share_capital,
    }

