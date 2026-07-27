from __future__ import annotations

from datetime import date
from types import TracebackType

from alpha.common.schema import BarDataQuery, IndexConstituentQuery
from alpha.sync_tasks.models import SecurityInfo


class DummyProgress:
    """用于替换 tqdm 的测试进度条。"""

    def __init__(self, total: int = 0, **_: object) -> None:
        self.total = total
        self.updated = 0
        self.postfix = ""

    def __enter__(self) -> "DummyProgress":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        return False

    def set_postfix_str(self, _text: str) -> None:
        self.postfix = _text
        return None

    def update(self, _n: int = 1) -> None:
        self.updated += _n
        return None

    def close(self) -> None:
        return None

    @staticmethod
    def write(_text: str) -> None:
        return None


class FakeSecurityDb:
    """证券同步任务用假数据库。"""

    def __init__(self, initial_meta_map: dict[str, str] | None = None) -> None:
        self.initial_meta_map = initial_meta_map or {}
        self.saved_profiles: list[dict[str, object]] = []
        self.saved_suspended_events: list[dict[str, object]] = []
        self.saved_st_events: list[dict[str, object]] = []
        self.saved_adjust_factors: list[dict[str, object]] = []
        self.saved_limit_bar_rows: list[dict[str, object]] = []
        self.saved_status_meta_rows: list[dict[str, object]] = []

    async def load_security_status_metas(self) -> dict[str, dict[str, object]]:
        return {
            vt_symbol: {
                "vt_symbol": vt_symbol,
                "latest_checked_trade_date": latest_checked_trade_date,
                "latest_data_trade_date": latest_checked_trade_date,
                "is_terminal": False,
                "updated_at": "2026-04-21 00:00:00",
            }
            for vt_symbol, latest_checked_trade_date in self.initial_meta_map.items()
        }

    async def save_security_profiles(self, rows: list[dict[str, object]]) -> bool:
        self.saved_profiles.extend(rows)
        return True

    async def save_suspended_day_events(self, rows: list[dict[str, object]]) -> bool:
        self.saved_suspended_events.extend(rows)
        return True

    async def save_st_day_events(self, rows: list[dict[str, object]]) -> bool:
        self.saved_st_events.extend(rows)
        return True

    async def save_adjust_factors(self, rows: list[dict[str, object]]) -> bool:
        self.saved_adjust_factors.extend(rows)
        return True

    async def save_bar_data(self, rows: list[dict[str, object]], *, adjust: str, update_overview: bool) -> bool:
        assert adjust == "non"
        assert update_overview is False
        self.saved_limit_bar_rows.extend(rows)
        return True

    async def save_security_status_metas(self, rows: list[dict[str, object]]) -> bool:
        self.saved_status_meta_rows.extend(rows)
        return True

    async def close(self) -> None:
        return None


class FakeIndexDb:
    """指数成分股同步任务用假数据库。"""

    def __init__(self, initial_meta: dict[str, str] | None = None) -> None:
        self.initial_meta = initial_meta or {}
        self.saved: dict[tuple[str, str], list[str]] = {}
        self.save_calls: list[tuple[str, str, list[str]]] = []

    async def load_index_constituent_meta(self, index_code: str) -> dict[str, object] | None:
        trade_date = self.initial_meta.get(index_code)
        if trade_date is None:
            return None
        return {"index_code": index_code, "latest_trade_date": trade_date, "last_sync_at": "2026-01-01 00:00:00"}

    async def load_index_constituents(self, query: IndexConstituentQuery) -> list[str]:
        trade_date = query.trade_date.isoformat() if isinstance(query.trade_date, date) else str(query.trade_date)
        return self.saved.get((query.index_code, trade_date), [])

    async def save_index_constituents(self, index_code: str, trade_date: date, vt_symbols: list[str]) -> bool:
        self.saved[(index_code, trade_date.isoformat())] = list(vt_symbols)
        self.save_calls.append((index_code, trade_date.isoformat(), list(vt_symbols)))
        return True

    async def close(self) -> None:
        return None


class FakeBarDb:
    """日线同步任务用假数据库。"""

    def __init__(self) -> None:
        self.saved_rows: list[dict[str, object]] = []
        self.rebuild_calls = 0
        self.overlap_rows: dict[str, list[dict[str, object]]] = {}

    async def get_bar_overview(self) -> list[dict[str, object]]:
        return [
            {
                "vt_symbol": "600000.SSE",
                "interval": "d",
                "start": "2025-01-02 00:00:00",
                "end": "2025-01-02 00:00:00",
                "count": 1,
                "updated_at": "2025-01-02 00:00:00",
            }
        ]

    async def save_bar_data(self, rows: list[dict[str, object]], *, adjust: str, update_overview: bool) -> bool:
        assert adjust == "non"
        self.saved_rows.extend(rows)
        return True

    async def rebuild_bar_overview(self) -> None:
        self.rebuild_calls += 1

    async def load_bar_data(self, query: BarDataQuery) -> list[dict[str, object]]:
        return self.overlap_rows.get(query.vt_symbol, [])

    async def close(self) -> None:
        return None


class FakeProvider:
    """任务测试用假 provider。"""

    async def fetch_history(self, symbols: list[str], start_date: date, end_date: date, fields: str) -> pd.DataFrame:
        """返回已完成基础字段适配的标准日线结果。"""
        import pandas as pd

        return pd.DataFrame(
            [
                {
                    "vt_symbol": "600000.SSE",
                    "symbol": "600000",
                    "exchange": "SSE",
                    "datetime": f"{start_date.isoformat()} 00:00:00",
                    "interval": "d",
                    "adjust": "non",
                    "open": 10.0,
                    "high": 10.5,
                    "low": 9.8,
                    "close": 10.2,
                    "volume": 1000.0,
                    "turnover": 12000.0,
                    "open_interest": 0.0,
                }
            ]
        )

    async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
        import pandas as pd

        return pd.DataFrame(
            [
                {
                    "gm_symbol": symbol,
                    "vt_symbol": "600000.SSE" if symbol == "SHSE.600000" else "000001.SZSE",
                    "asset_type": "stock",
                    "trade_date": end_date.isoformat(),
                    "board": 10100101,
                    "sec_name": "浦发银行",
                    "sec_abbr": "PFYH",
                    "price_tick": 0.01,
                    "trade_n": 1,
                    "listed_date": "1991-04-03",
                    "delisted_date": None,
                    "is_suspended": False,
                    "is_st": False,
                    "adj_factor": 1.2,
                    "upper_limit": 11.0,
                    "lower_limit": 9.0,
                }
            ]
        )

    async def fetch_symbols_snapshot(self, asset_type: str, trade_date: date) -> pd.DataFrame:
        import pandas as pd

        symbol = {
            "stock": "SZSE.000001",
            "etf": "SHSE.510300",
            "index": "SHSE.000001",
        }[asset_type]
        return pd.DataFrame(
            [
                {
                    "gm_symbol": symbol,
                    "vt_symbol": {
                        "stock": "000001.SZSE",
                        "etf": "510300.SSE",
                        "index": "000001.SSE",
                    }[asset_type],
                    "asset_type": asset_type,
                    "trade_date": trade_date.isoformat(),
                    "board": 10100101 if asset_type == "stock" else 10200101 if asset_type == "etf" else None,
                    "sec_name": {
                        "stock": "平安银行",
                        "etf": "沪深300ETF",
                        "index": "上证指数",
                    }[asset_type],
                    "sec_abbr": {
                        "stock": "PAYH",
                        "etf": "HS300ETF",
                        "index": "SZZS",
                    }[asset_type],
                    "price_tick": 0.01,
                    "trade_n": 1,
                    "listed_date": "1991-04-03",
                    "delisted_date": None,
                    "is_suspended": False,
                    "is_st": False,
                    "adj_factor": 1.2,
                    "upper_limit": 11.0,
                    "lower_limit": 9.0,
                }
            ]
        )

    async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
        import pandas as pd

        return pd.DataFrame([{"symbol": "SHSE.600000"}, {"symbol": "SZSE.000001"}])

    async def fetch_trading_dates(self, exchange: str, start_year: int, end_year: int) -> pd.DataFrame | list:
        return []

    async def fetch_symbol_infos(self, asset_type: str) -> pd.DataFrame:
        import pandas as pd

        symbol = {
            "stock": "SZSE.000001",
            "etf": "SHSE.510300",
            "index": "SHSE.000001",
        }[asset_type]
        vt_symbol = {
            "stock": "000001.SZSE",
            "etf": "510300.SSE",
            "index": "000001.SSE",
        }[asset_type]
        return pd.DataFrame(
            [
                {
                    "gm_symbol": symbol,
                    "vt_symbol": vt_symbol,
                    "asset_type": asset_type,
                    "trade_date": None,
                    "board": 10100101 if asset_type == "stock" else 10200101 if asset_type == "etf" else None,
                    "sec_name": {
                        "stock": "平安银行",
                        "etf": "沪深300ETF",
                        "index": "上证指数",
                    }[asset_type],
                    "sec_abbr": {
                        "stock": "PAYH",
                        "etf": "HS300ETF",
                        "index": "SZZS",
                    }[asset_type],
                    "price_tick": 0.01,
                    "trade_n": 1,
                    "listed_date": "1991-04-03",
                    "delisted_date": None,
                    "is_suspended": None,
                    "is_st": None,
                    "adj_factor": None,
                    "upper_limit": None,
                    "lower_limit": None,
                }
            ]
        )


def sample_security(
    asset_type: str = "stock",
    gm_symbol: str = "SHSE.600000",
    vt_symbol: str = "600000.SSE",
) -> SecurityInfo:
    """构造通用测试证券。"""
    gm_exchange, sec_id = gm_symbol.split(".", 1)
    db_exchange = vt_symbol.split(".", 1)[1]
    return SecurityInfo(
        asset_type=asset_type,
        gm_symbol=gm_symbol,
        gm_exchange=gm_exchange,
        sec_id=sec_id,
        db_exchange=db_exchange,
        vt_symbol=vt_symbol,
        listed_date=date(2000, 1, 1),
        delisted_date=None,
    )
