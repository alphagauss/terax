"""Alpha 业务路由响应、任务保护和设置接口测试。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from alpha.api.cache import AsyncTtlCache
from alpha.api.router import router
from alpha.api.routes.bars import _market_local_datetime
from alpha.config import AlphaConfig


class FakeDatabase:
    """测试用数据库门面。"""

    data_dir = Path("/tmp/alpha-test-db")

    async def get_data_catalog_overview(self) -> dict[str, object]:
        """返回固定数据目录概览和 Facets。"""
        return {
            "summary": {
                "security_count": 1,
                "profile_count": 1,
                "bar_security_count": 1,
                "total_bar_count": 3,
                "data_start": "2025-01-02 00:00:00",
                "data_end": "2025-01-03 00:00:00",
                "latest_updated_at": "2025-01-03 00:00:00",
            },
            "facets": {
                "exchanges": [{"value": "SZSE", "count": 1}],
                "asset_types": [{"value": "stock", "count": 1}],
                "data_states": [{"value": "complete", "count": 1}],
                "intervals": [{"value": "d", "security_count": 1, "row_count": 3}],
            },
        }

    async def query_security_catalog(self, query: object) -> dict[str, object]:
        """返回固定证券目录分页。"""
        item = await self.get_security_catalog_item("000001.SZSE")
        return {
            "items": [item],
            "total": 1,
            "limit": getattr(query, "limit", 50),
            "offset": getattr(query, "offset", 0),
        }

    async def get_security_catalog_item(
        self, vt_symbol: str
    ) -> dict[str, object] | None:
        """返回固定证券目录详情。"""
        if vt_symbol != "000001.SZSE":
            return None
        return {
            "vt_symbol": vt_symbol,
            "symbol": "000001",
            "exchange": "SZSE",
            "name": "平安银行",
            "asset_type": "stock",
            "board": None,
            "sec_name": "平安银行",
            "sec_abbr": "平安银行",
            "price_tick": 0.01,
            "trade_n": 100,
            "listed_date": "1991-04-03",
            "delisted_date": None,
            "status": "active",
            "data_state": "complete",
            "total_bar_count": 3,
            "data_start": "2025-01-02 00:00:00",
            "data_end": "2025-01-03 00:00:00",
            "latest_updated_at": "2025-01-03 00:00:00",
            "intervals": ["d"],
            "coverage": {
                "d": {
                    "start": "2025-01-02 00:00:00",
                    "end": "2025-01-03 00:00:00",
                    "rows": 3,
                    "updated_at": "2025-01-03 00:00:00",
                }
            },
        }

    async def get_bar_overview(self) -> list[dict[str, object]]:
        """返回固定行情概览行。

        Args:
            无。

        Returns:
            固定的数据概览行列表。
        """

        return [
            {
                "vt_symbol": "000001.SZSE",
                "interval": "d",
                "start": "2025-01-02 00:00:00",
                "end": "2025-01-03 00:00:00",
                "count": 3,
                "updated_at": "2025-01-03 00:00:00",
            }
        ]

    async def get_bar_overview_item(
        self,
        vt_symbol: str,
        interval: str,
    ) -> dict[str, object] | None:
        """返回固定证券和周期的行情概览。"""
        rows = await self.get_bar_overview()
        return next(
            (
                row
                for row in rows
                if row["vt_symbol"] == vt_symbol and row["interval"] == interval
            ),
            None,
        )

    async def load_security_profiles(self, query: object) -> list[dict[str, object]]:
        """返回固定证券资料。

        Args:
            query: 证券查询条件。

        Returns:
            固定证券资料列表。
        """

        vt_symbols = getattr(query, "vt_symbols", None)
        rows = [
            {
                "vt_symbol": "000001.SZSE",
                "asset_type": "stock",
                "sec_name": "平安银行",
                "sec_abbr": "平安银行",
                "listed_date": "1991-04-03",
                "delisted_date": None,
            }
        ]
        if vt_symbols is None:
            return rows
        return [row for row in rows if row["vt_symbol"] in vt_symbols]

    async def load_security_status_meta(self, vt_symbol: str) -> dict[str, object]:
        """返回固定证券状态游标。

        Args:
            vt_symbol: 证券代码。

        Returns:
            固定状态游标。
        """

        return {
            "vt_symbol": vt_symbol,
            "latest_checked_trade_date": "2025-01-03",
            "latest_data_trade_date": "2025-01-03",
            "is_terminal": False,
            "updated_at": "2025-01-03 15:00:00",
        }

    async def load_share_capital_changes(
        self,
        vt_symbol: str,
        start: object,
        end: object,
    ) -> list[dict[str, object]]:
        """返回固定股本变化。

        Args:
            vt_symbol: 证券代码。
            start: 开始日期。
            end: 结束日期。

        Returns:
            固定股本变化列表。
        """

        return [
            {"vt_symbol": vt_symbol, "trade_date": "2025-01-02", "total_share": 1.0}
        ]

    async def load_bar_data(self, query: object) -> list[dict[str, object]]:
        """返回固定 K 线。

        Args:
            query: K 线查询条件。

        Returns:
            固定 K 线列表。
        """

        return [
            {
                "datetime": "2025-01-02 00:00:00",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "volume": 1000,
                "turnover": 10500,
            }
        ]

    async def load_bar_history(self, query: object) -> dict[str, object]:
        """返回固定的有界历史页。"""
        items = await self.load_bar_data(query)
        return {
            "items": items,
            "has_more_before": False,
            "next_before": None,
            "actual_start": items[0]["datetime"],
            "actual_end": items[-1]["datetime"],
        }


class FakeStrategyManager:
    """测试用策略管理器。"""

    def __init__(self) -> None:
        self.reload_called = False

    def get_strategy_class(self) -> dict[str, dict[str, object]]:
        """返回固定策略元数据。

        Args:
            无。

        Returns:
            固定策略信息映射。
        """

        return {
            "DemoStrategy": {"author": "test"},
            "load_error::bad": {"error": "boom"},
        }

    def load_strategy_class(self) -> bool:
        """记录刷新调用。

        Args:
            无。

        Returns:
            始终返回成功。
        """

        self.reload_called = True
        return True

    def get_status_dict(self) -> dict[str, dict[str, object]]:
        """返回固定回测任务。

        Args:
            无。

        Returns:
            固定回测任务映射。
        """

        return {"bt-1": {"task_id": "bt-1", "status": "running"}}

    def start_backtesting(self, request: object) -> str:
        """记录回测请求并返回任务标识。

        Args:
            request: 回测请求模型。

        Returns:
            固定任务标识。
        """

        assert getattr(request, "class_name") == "DemoStrategy"
        return "bt-2"

    def get_all_strategy_result_info(self) -> dict[str, dict[str, object]]:
        """返回固定回测结果概要。

        Args:
            无。

        Returns:
            回测结果概要映射。
        """

        return {
            "bt-done.json": {
                "hash_name": "bt-done.json",
                "class_name": "DemoStrategy",
                "vt_symbols": ["000001.SZSE"],
                "interval": "d",
                "start": "2025-01-01T00:00:00",
                "end": "2025-01-03T00:00:00",
                "capital": 1000000,
            }
        }

    def get_strategy_result(self, hash_name: str) -> dict[str, object]:
        """返回固定回测结果。

        Args:
            hash_name: 回测结果标识。

        Returns:
            回测结果。
        """

        if hash_name != "bt-done.json":
            return {}
        return {
            "backtest_req": self.get_all_strategy_result_info()[hash_name],
            "status": None,
            "result": {
                "statistics": {
                    "total_return": 12.5,
                    "annual_return": 20.0,
                    "max_ddpercent": -3.0,
                    "sharpe_ratio": 1.2,
                    "total_trade_count": 2,
                    "total_commission": 12.0,
                },
                "daily_results": [
                    {
                        "date": "2025-01-02",
                        "balance": 1001000,
                        "ddpercent": -1.0,
                        "return": 0.001,
                    }
                ],
                "trades": [
                    {
                        "tradeid": "t1",
                        "vt_symbol": "000001.SZSE",
                        "direction": "多",
                        "price": 10.5,
                        "volume": 100,
                        "datetime": "2025-01-02T10:00:00",
                    }
                ],
            },
        }


class FakeProcessManager:
    """测试用进程任务管理器。"""

    def list_snapshots(self) -> list[dict[str, object]]:
        """返回混合任务快照。

        Args:
            无。

        Returns:
            固定任务快照列表。
        """

        return [
            {"task_id": "sync-1", "status": "succeeded", "task_type": "sync-bars"},
            {"task_id": "bt-1", "status": "running", "task_type": "backtest"},
        ]

    def stop(self, task_id: str) -> object | None:
        """返回固定取消后任务。

        Args:
            task_id: 任务标识。

        Returns:
            带 snapshot 方法的测试对象。
        """

        if task_id != "bt-1":
            return None

        class StoppedTask:
            """测试用已停止任务。"""

            def snapshot(self) -> dict[str, object]:
                """返回取消后的任务快照。

                Args:
                    无。

                Returns:
                    任务快照。
                """

                return {
                    "task_id": "bt-1",
                    "status": "cancelled",
                    "task_type": "backtest",
                }

        return StoppedTask()


def _client() -> TestClient:
    """构造只挂载 alpha router 的测试客户端。

    Args:
        无。

    Returns:
        FastAPI 测试客户端。
    """

    app = FastAPI()
    app.state.alpha_services = SimpleNamespace(
        config=AlphaConfig(data_dir=Path.cwd()),
        database=FakeDatabase(),
        strategy_manager=FakeStrategyManager(),
        process_manager=FakeProcessManager(),
        data_overview_cache=AsyncTtlCache(ttl_seconds=60),
        has_running_tasks=lambda: False,
    )
    app.state.alpha_started_at = datetime(2026, 8, 13, 9, 20, 31, tzinfo=timezone.utc)
    app.include_router(router, prefix="/api/alpha")
    return TestClient(app)


def test_alpha_router_exposes_business_health() -> None:
    """验证 alpha router 只提供业务健康检查。"""

    response = _client().get("/api/alpha/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "ready": True,
        "service": "terax-alpha",
        "protocol_version": 2,
        "runtime_revision": "dev:unmanaged",
        "started_at": "2026-08-13T09:20:31Z",
    }


def test_alpha_health_reports_injected_runtime_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证受管进程注入的运行源码 revision 会原样返回。"""

    monkeypatch.setenv("TERAX_ALPHA_RUNTIME_REVISION", "release:abc123")

    response = _client().get("/api/alpha/health")

    assert response.status_code == 200
    assert response.json()["runtime_revision"] == "release:abc123"


def test_alpha_router_builds_data_overview() -> None:
    """验证数据接口返回 union 目录概览和 Facets。"""

    response = _client().get("/api/alpha/data/overview")

    assert response.status_code == 200
    assert response.json()["summary"]["total_bar_count"] == 3
    assert response.json()["summary"]["security_count"] == 1
    assert response.json()["facets"]["data_states"][0] == {
        "value": "complete",
        "count": 1,
    }


def test_alpha_router_reports_workbench_status() -> None:
    """验证 Alpha 工作台状态接口返回轻量状态。"""

    response = _client().get("/api/alpha/status")

    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["database_ready"] is True
    assert response.json()["security_count"] == 1


def test_alpha_router_filters_strategy_loader_errors() -> None:
    """验证策略接口在路由层过滤加载错误条目。"""

    client = _client()

    list_response = client.get("/api/alpha/strategies")
    reload_response = client.post("/api/alpha/strategies/reload")

    assert list_response.status_code == 200
    assert list_response.json()["items"][0]["id"] == "DemoStrategy"
    assert list_response.json()["items"][0]["metadata"] == {"author": "test"}
    assert reload_response.status_code == 200
    assert reload_response.json()[0]["metadata"] == {"author": "test"}


def test_alpha_router_uses_strategy_manager_for_backtests() -> None:
    """验证回测接口在路由层调用策略管理器。"""

    client = _client()

    list_response = client.get("/api/alpha/backtests")
    create_response = client.post(
        "/api/alpha/backtests",
        json={
            "class_name": "DemoStrategy",
            "vt_symbols": ["000001.SZSE"],
            "product": "股票",
            "interval": "d",
            "start": "2025-01-01T00:00:00",
            "end": "2025-01-31T00:00:00",
            "capital": 1000000,
            "param_setting": {},
        },
    )

    assert list_response.status_code == 200
    assert list_response.json()["total"] == 2
    assert list_response.json()["items"][0]["id"] == "bt-done.json"
    assert create_response.status_code == 200
    assert create_response.json()["task_id"] == "bt-2"
    assert create_response.json()["backtest_id"].endswith(".json")


def test_alpha_router_exposes_security_and_bar_apis() -> None:
    """验证证券搜索、详情和 K 线接口。"""

    client = _client()

    list_response = client.get("/api/alpha/securities?q=平安")
    detail_response = client.get("/api/alpha/securities/000001.SZSE")
    bars_response = client.get("/api/alpha/bars?vt_symbol=000001.SZSE&interval=1d")

    assert list_response.status_code == 200
    assert list_response.json()["items"][0]["name"] == "平安银行"
    assert list_response.json()["items"][0]["data_state"] == "complete"
    assert detail_response.status_code == 200
    assert detail_response.json()["coverage"]["d"]["rows"] == 3
    assert detail_response.json()["timezone"] == "Asia/Shanghai"
    assert detail_response.json()["price_color_convention"] == "up-red"
    assert detail_response.json()["volume_unit"] == "share"
    assert bars_response.status_code == 200
    assert bars_response.json()["items"][0]["close"] == 10.5
    assert bars_response.json()["has_more_before"] is False
    assert bars_response.json()["next_before"] is None
    assert "reference_close" in bars_response.json()
    assert "reference_time" in bars_response.json()


def test_alpha_bar_router_adds_exchange_timezone_to_intraday_bars() -> None:
    """盘中行情必须返回可解析为绝对时刻的交易所时区偏移。"""
    response = _client().get("/api/alpha/bars?vt_symbol=000001.SZSE&interval=1m")

    assert response.status_code == 200
    assert response.json()["items"][0]["time"] == "2025-01-02T00:00:00+08:00"
    assert response.json()["actual_start"] == "2025-01-02T00:00:00+08:00"


def test_alpha_bar_router_converts_absolute_cursor_to_exchange_time() -> None:
    """带时区游标必须先转换为交易所本地时间，再与存储时间比较。"""
    assert _market_local_datetime(
        "2025-01-01T16:00:00Z",
        "000001.SZSE",
    ) == datetime(2025, 1, 2)


def test_alpha_bar_router_rejects_mixed_range_and_cursor_queries() -> None:
    """范围边界和排他游标不能混用，避免产生含糊分页语义。"""
    response = _client().get(
        "/api/alpha/bars?vt_symbol=000001.SZSE&start=2025-01-01&before=2025-01-02"
    )

    assert response.status_code == 422


def test_alpha_bar_reference_is_stable_across_pages_and_adjustments() -> None:
    """历史分页共享最新锚点，且不同复权方式必须返回各自的参考价。"""
    client = _client()
    calls: list[object] = []

    async def load_bar_history(query: object) -> dict[str, object]:
        """按测试查询返回页面或权威参考窗口。"""
        calls.append(query)
        adjust = getattr(query, "adjust")
        limit = getattr(query, "limit")
        before = getattr(query, "before")
        if limit == 2:
            reference_close = 10.0 if adjust == "pre" else 20.0
            rows = [
                {
                    "datetime": "2025-01-01 00:00:00",
                    "open": reference_close,
                    "high": reference_close,
                    "low": reference_close,
                    "close": reference_close,
                    "volume": 100,
                },
                {
                    "datetime": "2025-01-02 00:00:00",
                    "open": 11.0,
                    "high": 11.0,
                    "low": 11.0,
                    "close": 11.0,
                    "volume": 100,
                },
            ]
        else:
            day = "2024-12-31" if before is not None else "2025-01-02"
            rows = [
                {
                    "datetime": f"{day} 00:00:00",
                    "open": 11.0,
                    "high": 11.0,
                    "low": 11.0,
                    "close": 11.0,
                    "volume": 100,
                }
            ]
        return {
            "items": rows,
            "has_more_before": False,
            "next_before": None,
            "actual_start": rows[0]["datetime"],
            "actual_end": rows[-1]["datetime"],
        }

    client.app.state.alpha_services.database.load_bar_history = load_bar_history

    latest = client.get(
        "/api/alpha/bars?vt_symbol=000001.SZSE&interval=d&adjust=forward"
    ).json()
    older = client.get(
        "/api/alpha/bars?vt_symbol=000001.SZSE&interval=d&adjust=forward"
        "&before=2025-01-02"
    ).json()
    backward = client.get(
        "/api/alpha/bars?vt_symbol=000001.SZSE&interval=d&adjust=backward"
    ).json()

    assert latest["reference_close"] == 10.0
    assert older["reference_close"] == 10.0
    assert latest["reference_time"] == older["reference_time"] == "2025-01-01"
    assert backward["reference_close"] == 20.0
    reference_queries = [query for query in calls if getattr(query, "limit") == 2]
    assert all(getattr(query, "before") is None for query in reference_queries)
    assert [getattr(query, "adjust") for query in reference_queries] == [
        "pre",
        "pre",
        "post",
    ]


def test_alpha_intraday_reference_uses_previous_completed_daily_close() -> None:
    """盘中行情参考价来自当前交易时段之前最近的已完成日线。"""
    client = _client()
    calls: list[object] = []

    async def load_bar_history(query: object) -> dict[str, object]:
        """分别返回盘中页面、时段锚点和前一交易日日线。"""
        calls.append(query)
        interval = getattr(query, "interval")
        limit = getattr(query, "limit")
        if interval == "d":
            rows = [
                {
                    "datetime": "2025-01-01 00:00:00",
                    "open": 9.8,
                    "high": 9.8,
                    "low": 9.8,
                    "close": 9.8,
                    "volume": 100,
                }
            ]
        else:
            rows = [
                {
                    "datetime": "2025-01-02 09:30:00",
                    "open": 10.0,
                    "high": 10.1,
                    "low": 9.9,
                    "close": 10.0,
                    "volume": 100,
                }
            ]
        return {
            "items": rows,
            "has_more_before": False,
            "next_before": None,
            "actual_start": rows[0]["datetime"],
            "actual_end": rows[-1]["datetime"],
        }

    client.app.state.alpha_services.database.load_bar_history = load_bar_history

    response = client.get(
        "/api/alpha/bars?vt_symbol=000001.SZSE&interval=1m&adjust=forward"
    )

    assert response.status_code == 200
    assert response.json()["reference_close"] == 9.8
    assert response.json()["reference_time"] == "2025-01-01"
    daily_query = next(query for query in calls if getattr(query, "interval") == "d")
    assert getattr(daily_query, "before") == datetime(2025, 1, 2)
    assert getattr(daily_query, "limit") == 1


def test_alpha_router_exposes_backtest_result_slices() -> None:
    """验证回测结果分片接口。"""

    client = _client()

    summary_response = client.get("/api/alpha/backtests/bt-done.json/summary")
    equity_response = client.get("/api/alpha/backtests/bt-done.json/equity")
    trades_response = client.get("/api/alpha/backtests/bt-done.json/trades")
    config_response = client.get("/api/alpha/backtests/bt-done.json/config")

    assert summary_response.status_code == 200
    assert summary_response.json()["total_return"] == 0.125
    assert equity_response.status_code == 200
    assert equity_response.json()["items"][0]["equity"] == 1001000
    assert trades_response.status_code == 200
    assert trades_response.json()["items"][0]["id"] == "t1"
    assert config_response.status_code == 200
    assert config_response.json()["strategy_id"] == "DemoStrategy"


def test_alpha_router_exposes_task_status_and_cancel() -> None:
    """验证任务状态、日志和取消接口。"""

    client = _client()

    task_response = client.get("/api/alpha/tasks/bt-1")
    logs_response = client.get("/api/alpha/tasks/bt-1/logs")
    cancel_response = client.post("/api/alpha/tasks/bt-1/cancel")

    assert task_response.status_code == 200
    assert task_response.json()["status"] == "running"
    assert logs_response.status_code == 200
    assert logs_response.json()["total"] == 0
    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "cancelled"


def test_alpha_router_filters_sync_tasks() -> None:
    """验证同步接口在路由层过滤同步任务。"""

    response = _client().get("/api/alpha/sync/tasks")

    assert response.status_code == 200
    assert response.json() == [
        {"task_id": "sync-1", "status": "succeeded", "task_type": "sync-bars"}
    ]


def test_alpha_router_reads_and_updates_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """验证设置接口保存显式数据目录并更新容器配置。"""

    monkeypatch.setenv("TERAX_ALPHA_HOME", str(tmp_path / "alpha-home"))
    client = _client()
    data_dir = tmp_path / "synced-data"

    initial = client.get("/api/alpha/settings")
    updated = client.post(
        "/api/alpha/settings",
        json={"data_dir": str(data_dir)},
    )

    assert initial.status_code == 200
    assert updated.status_code == 200
    assert Path(updated.json()["data_dir"]) == data_dir.resolve()
    assert client.app.state.alpha_services.config.data_dir == data_dir.resolve()


def test_alpha_router_rejects_settings_update_while_task_is_running(
    tmp_path: Path,
) -> None:
    """验证运行任务存在时不会切换数据目录。"""

    client = _client()
    client.app.state.alpha_services.has_running_tasks = lambda: True

    response = client.post(
        "/api/alpha/settings",
        json={"data_dir": str(tmp_path / "synced-data")},
    )

    assert response.status_code == 409
