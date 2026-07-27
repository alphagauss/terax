from __future__ import annotations

import base64
import hashlib
from dataclasses import field
from datetime import date as _date
from datetime import datetime as _datetime
from typing import Literal

from pydantic import BaseModel

from alpha.common.enums import Direction, Interval, Product


class BacktestReq(BaseModel):
    """回测与参数优化请求。"""

    class_name: str
    vt_symbols: list[str]
    product: Product
    interval: Interval
    start: _datetime
    end: _datetime
    capital: int
    price_adjust: Literal["pre", "post", "non"] = "pre"
    param_setting: dict = {}
    bt_type: Literal["backtest", "ga_optimization", "bf_optimization"] = "backtest"
    target_name: str = ""
    optimization_setting: dict = {}
    max_workers: int = 1
    req_date: str = _datetime.now().strftime("%Y-%m-%d")

    @property
    def hash_name(self) -> str:
        """返回基于请求内容生成的稳定文件名。"""
        if not hasattr(self, "_hash_cache"):
            json_str = self.model_dump_json()
            self._hash_cache = hashlib.sha256(json_str.encode()).hexdigest()[:12] + ".json"
        return self._hash_cache

    def to_instance_name(self) -> str:
        """生成带日期前缀的实例名。"""
        date_prefix = _datetime.now().strftime("%Y%m%d")
        json_str = self.model_dump_json()
        encoded = base64.urlsafe_b64encode(json_str.encode()).decode()
        return f"{date_prefix}_{self.class_name}_{encoded}"

    @classmethod
    def from_instance_name(cls, instance_name: str) -> "BacktestReq":
        """从实例名中恢复回测请求对象。"""
        _date_prefix, class_name, encoded = instance_name.split("_", 2)
        json_str = base64.urlsafe_b64decode(encoded.encode()).decode()
        obj = cls.model_validate_json(json_str)
        obj.class_name = class_name
        return obj


class HoldData(BaseModel):
    """持仓状态。"""

    vt_symbol: str
    direction: Direction
    hold_pos: float = 0
    price: float = 0
    frozen_pos: float = 0
    frozen_price: float = 0
    hold_earn: float = 0
    day_earn: float = 0


class AccountData(BaseModel):
    """账户状态快照。"""

    update: _date

    total: float = 0
    usable: float = 0
    frozen: float = 0
    hold_earn: float = 0
    realized_pnl: float = 0
    day_earn: float = 0
    long_hold: dict[str, HoldData] = field(default_factory=dict)
    short_hold: dict[str, HoldData] = field(default_factory=dict)
    commission: float = 0
    slippage: float = 0
    turnover: float = 0
    trade_count: int = 0
