"""Alpha 工作台路由辅助函数。"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Literal, cast

from fastapi import HTTPException, status

from alpha.common.enums import Interval, Product


MAX_LIST_LIMIT = 100
MAX_BAR_LIMIT = 5000


def clamp_limit(limit: int, *, default: int, maximum: int = MAX_LIST_LIMIT) -> int:
    """限制分页大小。

    Args:
        limit: 请求传入的分页大小。
        default: 非法分页大小时使用的默认值。
        maximum: 允许返回的最大条数。

    Returns:
        归一化后的分页大小。
    """

    if limit <= 0:
        return default
    return min(limit, maximum)


def clamp_offset(offset: int) -> int:
    """限制分页偏移量。

    Args:
        offset: 请求传入的分页偏移量。

    Returns:
        非负分页偏移量。
    """

    return max(offset, 0)


def parse_datetime(value: str | None, *, end_of_day: bool = False) -> datetime | None:
    """解析前端日期或时间字符串。

    Args:
        value: 日期、日期时间或空值。
        end_of_day: 仅传入日期时是否补到当天结束。

    Returns:
        解析后的日期时间；空值返回 ``None``。

    Raises:
        HTTPException: 日期格式非法。
    """

    if value is None or not value.strip():
        return None

    raw = value.strip()
    try:
        if len(raw) == 10:
            parsed_date = date.fromisoformat(raw)
            return datetime.combine(parsed_date, time.max if end_of_day else time.min)
        return datetime.fromisoformat(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"日期格式非法: {value}",
        ) from exc


def normalize_interval(value: str) -> str:
    """归一化前端周期到 Alpha 内部周期值。

    Args:
        value: 前端周期，例如 ``1d``、``d``、``1m``。

    Returns:
        Alpha 内部周期值。

    Raises:
        HTTPException: 周期不受支持。
    """

    aliases = {
        "1d": "d",
        "day": "d",
        "daily": "d",
        "1w": "w",
        "week": "w",
        "weekly": "w",
        "60m": "1h",
        "hour": "1h",
        "hourly": "1h",
    }
    normalized = aliases.get(value.strip().lower(), value.strip().lower())
    if not Interval.is_valid(normalized):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"不支持的周期: {value}",
        )
    return normalized


def normalize_adjust(value: str) -> Literal["pre", "post", "non"]:
    """归一化前端复权方式。

    Args:
        value: 前端复权值，例如 ``forward``、``backward``、``none``。

    Returns:
        Alpha 内部复权值。

    Raises:
        HTTPException: 复权方式不受支持。
    """

    aliases = {
        "forward": "pre",
        "backward": "post",
        "none": "non",
        "no": "non",
        "non": "non",
        "pre": "pre",
        "post": "post",
    }
    normalized = aliases.get(value.strip().lower())
    if normalized not in {"pre", "post", "non"}:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"不支持的复权方式: {value}",
        )
    return cast(Literal["pre", "post", "non"], normalized)


def normalize_product(value: str | None) -> Product:
    """归一化前端资产类型到 Alpha 产品枚举。

    Args:
        value: 前端资产类型或中文产品值。

    Returns:
        Alpha 产品枚举。
    """

    if value is None or not value.strip():
        return Product.EQUITY

    raw = value.strip()
    aliases = {
        "stock": Product.EQUITY,
        "equity": Product.EQUITY,
        "ashare": Product.ASHARE,
        "a_share": Product.ASHARE,
        "index": Product.INDEX,
        "etf": Product.ETF,
        "fund": Product.FUND,
    }
    if raw.lower() in aliases:
        return aliases[raw.lower()]
    for product in Product:
        if raw in {product.name, product.value}:
            return product
    return Product.EQUITY


def task_status(value: object) -> str:
    """把运行时任务状态归一为前端状态。

    Args:
        value: 任务状态值。

    Returns:
        前端状态字符串。
    """

    raw = str(value or "").lower()
    if raw == "succeeded":
        return "completed"
    if raw == "timeout":
        return "failed"
    if raw in {"running", "failed", "cancelled", "pending", "completed"}:
        return raw
    return raw or "pending"


def page_items(
    items: list[dict[str, object]],
    *,
    limit: int,
    offset: int,
) -> dict[str, object]:
    """构造列表分页响应。

    Args:
        items: 全量条目。
        limit: 页大小。
        offset: 偏移量。

    Returns:
        包含 ``items`` 与 ``total`` 的响应字典。
    """

    normalized_limit = clamp_limit(limit, default=50)
    normalized_offset = clamp_offset(offset)
    return {
        "items": items[normalized_offset : normalized_offset + normalized_limit],
        "total": len(items),
    }


def first_text(row: dict[str, object], keys: tuple[str, ...]) -> str | None:
    """从多个候选字段读取第一个非空字符串。

    Args:
        row: 原始数据行。
        keys: 候选字段名。

    Returns:
        字符串值或 ``None``。
    """

    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return None


def first_number(row: dict[str, object], keys: tuple[str, ...]) -> float | None:
    """从多个候选字段读取第一个数字。

    Args:
        row: 原始数据行。
        keys: 候选字段名。

    Returns:
        浮点数或 ``None``。
    """

    for key in keys:
        value = row.get(key)
        if isinstance(value, int | float):
            return float(value)
    return None


def date_text(value: object) -> str | None:
    """把日期时间值转成前端展示字符串。

    Args:
        value: 日期、日期时间或字符串。

    Returns:
        日期时间字符串或 ``None``。
    """

    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is None:
        return None
    text = str(value)
    if len(text) >= 19 and text.endswith(" 00:00:00"):
        return text[:10]
    return text
