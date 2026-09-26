"""页面与 Agent 共用的自选命令、分组快照及有界日线摘要接口。"""

import asyncio
import math
import re
import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from alpha.api.container import AlphaServiceContainer
from alpha.api.deps import get_alpha_services
from alpha.common.market_metadata import get_market_metadata
from alpha.common.schema_market import BarHistoryQuery
from alpha.common.schema_core import split_vt_symbol
from alpha.storage.repositories.watchlist import WatchlistConflict

router = APIRouter()


class WatchlistCommand(BaseModel):
    """仅接收领域命令；批量集合与相对顺序在后端事务内解析。"""

    model_config = ConfigDict(extra="forbid")
    action: Literal[
        "create_group",
        "rename_group",
        "delete_group",
        "add",
        "remove",
        "copy",
        "move",
        "pin",
        "reorder",
    ]
    group_id: str = "all"
    name: str | None = Field(default=None, min_length=1, max_length=60)
    symbols: list[str] = Field(default_factory=list)
    target_group_id: str | None = None
    pinned: bool | None = None
    edge: Literal["first", "last"] | None = None
    anchor: str | None = None
    side: Literal["before", "after"] | None = None

    @model_validator(mode="after")
    def validate_command(self):
        """拒绝缺失参数和歧义重排，证券格式沿用公共市场类型。"""
        if self.name is not None:
            self.name = self.name.strip()
        if self.action in {"create_group", "rename_group"} and not self.name:
            raise ValueError("name_required")
        self.symbols = list(dict.fromkeys(symbol.upper() for symbol in self.symbols))
        if self.anchor is not None:
            self.anchor = self.anchor.upper()
        for symbol in [*self.symbols, *([self.anchor] if self.anchor else [])]:
            if not re.fullmatch(r"[^.\s]+\.[^.\s]+", symbol):
                raise ValueError("invalid_symbol")
            split_vt_symbol(symbol)
        if (
            self.action in {"add", "remove", "copy", "move", "pin", "reorder"}
            and not self.symbols
        ):
            raise ValueError("symbols_required")
        if self.action in {"pin", "reorder"} and len(self.symbols) != 1:
            raise ValueError("single_symbol_required")
        if self.action == "pin" and self.pinned is None:
            raise ValueError("pinned_required")
        if self.action in {"copy", "move"} and not self.target_group_id:
            raise ValueError("target_required")
        if self.action == "reorder":
            if self.edge:
                if self.anchor or self.side:
                    raise ValueError("ambiguous_position")
            elif not self.anchor or not self.side:
                raise ValueError("anchor_required")
        return self


@router.get("/watchlist")
async def get_watchlist(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict:
    """读取独立于行情和临时排序的自选权威快照。"""
    return await services.database.get_watchlist()


@router.post("/watchlist/commands")
async def change_watchlist(
    command: WatchlistCommand,
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
) -> dict:
    """新关注校验证券目录；历史失效成员仍允许整理和移除。"""
    if command.action == "add":
        for symbol in command.symbols:
            if await services.database.get_security_catalog_item(symbol) is None:
                raise HTTPException(404, "security_missing")
    try:
        return await services.database.change_watchlist(
            command.model_dump(exclude_none=True)
        )
    except WatchlistConflict as error:
        raise HTTPException(409, str(error)) from error


def _number(value):
    """缺失或非有限行情不能成为有效零价。"""
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


@router.get("/watchlist/quotes")
async def get_watchlist_quotes(
    services: Annotated[AlphaServiceContainer, Depends(get_alpha_services)],
    group_id: str = "all",
) -> list[dict]:
    """批量读取当前组全部成员；每标的仅取二十根日线，限制并发分片读取。"""
    snapshot = await services.database.get_watchlist()
    if group_id != "all" and not any(g["id"] == group_id for g in snapshot["groups"]):
        raise HTTPException(409, "group_missing")
    semaphore = asyncio.Semaphore(8)

    async def quote(item):
        symbol = item["vt_symbol"]
        result = {
            "vt_symbol": symbol,
            "close": None,
            "change": None,
            "date": None,
            "closes": [],
            "price_tick": item["price_tick"],
            "price_color_convention": get_market_metadata(
                symbol
            ).price_color_convention,
            "status": "missing",
        }
        async with semaphore:
            try:
                raw = (
                    await services.database.load_bar_history(
                        BarHistoryQuery(
                            vt_symbol=symbol, interval="d", adjust="non", limit=2
                        )
                    )
                )["items"]
                if raw:
                    result["date"] = str(raw[-1]["datetime"])[:10]
                    result["close"] = _number(raw[-1].get("close"))
                    result["status"] = "daily"
                adjusted = (
                    await services.database.load_bar_history(
                        BarHistoryQuery(
                            vt_symbol=symbol, interval="d", adjust="pre", limit=20
                        )
                    )
                )["items"]
                result["closes"] = [_number(row.get("close")) for row in adjusted]
                if len(raw) >= 2 and len(adjusted) >= 2:
                    previous = _number(raw[-2].get("close"))
                    current = result["close"]
                    before = _number(adjusted[-2].get("close"))
                    after = _number(adjusted[-1].get("close"))
                    # 日线存储没有交易所除权参考价，检测到复权跳变时不伪造市场涨幅。
                    aligned = all(
                        str(a["datetime"]) == str(b["datetime"])
                        for a, b in zip(raw[-2:], adjusted[-2:])
                    )
                    if (
                        aligned
                        and previous
                        and current is not None
                        and before
                        and after is not None
                    ):
                        if math.isclose(
                            current / previous,
                            after / before,
                            rel_tol=1e-7,
                            abs_tol=1e-9,
                        ):
                            result["change"] = _number((current / previous - 1) * 100)
            except (OSError, ValueError, sqlite3.Error):
                result["status"] = "error"
        return result

    return await asyncio.gather(
        *(quote(item) for item in snapshot["items"] if item["group_id"] == group_id)
    )
