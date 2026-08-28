from __future__ import annotations

import asyncio
from datetime import date

import pandas as pd

from alpha.sync_tasks.jobs import run_bar_sync_job
from alpha.sync_tasks.models import SecurityInfo
from alpha.sync_tasks.tasks.bar_sync import BarSyncTask
from alpha.sync_tasks.tasks.index_constituent_sync import IndexConstituentSyncTask
from alpha.sync_tasks.tasks.security_sync import SecuritySyncTask
from conftest import DummyProgress, FakeBarDb, FakeIndexDb, FakeProvider, FakeSecurityDb, sample_security


def test_security_sync_task_runs_full_and_incremental() -> None:
    securities = [
        SecurityInfo("stock", "SZSE.000001", "SZSE", "000001", "SZSE", "000001.SZSE", date(1991, 4, 3), None),
        SecurityInfo("etf", "SHSE.510300", "SHSE", "510300", "SSE", "510300.SSE", date(2012, 5, 28), None),
        SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None),
    ]
    trade_dates = [date(2025, 1, 2), date(2025, 1, 3)]
    provider = FakeProvider()

    full_task = SecuritySyncTask(
        provider,
        db_factory=lambda: FakeSecurityDb({item.vt_symbol: "2025-01-02" for item in securities}),
        trade_dates_loader=lambda: trade_dates,
        universe_loader=lambda: securities,
        progress_factory=DummyProgress,
    )
    full_result = asyncio.run(full_task.run_by_symbol(flush_symbol_count=1, target_trade_date=date(2025, 1, 3)))
    assert full_result["mode"] == "by_symbol"
    assert full_result["plan_mode"] == "incremental"
    assert full_result["planned_symbol_count"] == len(securities)
    assert full_result["saved_status_metas"] == len(securities)

    inc_task = SecuritySyncTask(
        provider,
        db_factory=lambda: FakeSecurityDb({item.vt_symbol: "2025-01-02" for item in securities}),
        trade_dates_loader=lambda: trade_dates,
        universe_loader=lambda: securities,
        progress_factory=DummyProgress,
    )
    inc_result = asyncio.run(inc_task.run_by_date(target_trade_date=date(2025, 1, 3)))
    assert inc_result["mode"] == "by_date"
    assert inc_result["plan_mode"] == "incremental"
    assert inc_result["processed_trade_date_count"] == 1
    assert inc_result["saved_status_metas"] == len(securities)


def test_security_sync_task_refresh_symbol_infos_csv_updates_csv_and_db(tmp_path, monkeypatch) -> None:
    import alpha.storage.csvdb as csvdb

    csvdb.get_csvdb_folder.cache_clear()
    monkeypatch.setattr(csvdb, "get_csvdb_folder", lambda: tmp_path)

    db = FakeSecurityDb()
    task = SecuritySyncTask(FakeProvider(), db_factory=lambda: db)

    result = asyncio.run(task.run_refresh_symbol_infos_csv())

    assert result["csv_rows"] == 3
    assert result["saved_profile_rows"] == 3
    assert len(db.saved_profiles) == 3
    assert db.saved_profiles[0]["sec_name"] is not None
    assert any(row["asset_type"] == "index" and row["board"] is None for row in db.saved_profiles)
    assert tmp_path.joinpath("gm_a_share_stock_infos.csv").exists()
    assert tmp_path.joinpath("gm_a_share_etf_infos.csv").exists()
    assert tmp_path.joinpath("gm_a_share_idx_infos.csv").exists()


def test_security_sync_task_refresh_symbols_snapshot_csv_updates_latest_csv(tmp_path, monkeypatch) -> None:
    import alpha.storage.csvdb as csvdb

    csvdb.get_csvdb_folder.cache_clear()
    monkeypatch.setattr(csvdb, "get_csvdb_folder", lambda: tmp_path)

    task = SecuritySyncTask(FakeProvider(), db_factory=FakeSecurityDb)

    result = asyncio.run(task.run_refresh_symbols_snapshot_csv(target_trade_date=date(2025, 1, 3)))

    assert result["trade_date"] == "2025-01-03"
    assert result["csv_rows"] == 3
    assert tmp_path.joinpath("gm_a_share_stock_infos_latest.csv").exists()
    assert tmp_path.joinpath("gm_a_share_etf_infos_latest.csv").exists()
    assert tmp_path.joinpath("gm_a_share_idx_infos_latest.csv").exists()


def test_security_sync_task_run_full_supports_force_full_plan_mode() -> None:
    class RecordingProvider(FakeProvider):
        def __init__(self) -> None:
            self.calls: list[tuple[str, date, date]] = []

        async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
            self.calls.append((symbol, start_date, end_date))
            return await super().fetch_history_symbol(symbol, start_date, end_date)

    security = SecurityInfo("stock", "SZSE.000001", "SZSE", "000001", "SZSE", "000001.SZSE", date(1991, 4, 3), None)
    provider = RecordingProvider()
    task = SecuritySyncTask(
        provider,
        db_factory=lambda: FakeSecurityDb({"000001.SZSE": "2025-01-02"}),
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2), date(2025, 1, 3)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run_by_symbol(
        flush_symbol_count=1,
        target_trade_date=date(2025, 1, 3),
        plan_mode="full",
    ))

    assert result["plan_mode"] == "full"
    assert provider.calls == [("SZSE.000001", date(2005, 1, 4), date(2025, 1, 3))]


def test_security_sync_task_incremental_advances_checked_cursor_even_when_snapshot_missing_symbol() -> None:
    class MissingSnapshotProvider(FakeProvider):
        async def fetch_symbols_snapshot(self, asset_type: str, trade_date: date) -> pd.DataFrame:
            if asset_type == "stock":
                return pd.DataFrame()
            return await super().fetch_symbols_snapshot(asset_type, trade_date)

    security = SecurityInfo("stock", "SZSE.000001", "SZSE", "000001", "SZSE", "000001.SZSE", date(1991, 4, 3), None)
    db = FakeSecurityDb({"000001.SZSE": "2025-01-02"})
    task = SecuritySyncTask(
        MissingSnapshotProvider(),
        db_factory=lambda: db,
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run_by_date(target_trade_date=date(2025, 1, 3)))

    assert result["processed_trade_date_count"] == 1
    assert db.saved_status_meta_rows == [
        {
            "vt_symbol": "000001.SZSE",
            "latest_checked_trade_date": "2025-01-03",
            "latest_data_trade_date": "2025-01-02",
            "is_terminal": False,
        }
    ]


def test_security_sync_task_writes_non_zero_limit_bars_and_skips_zero_or_index() -> None:
    class MixedLimitProvider(FakeProvider):
        async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
            payload_map = {
                "SZSE.000001": {
                    "vt_symbol": "000001.SZSE",
                    "asset_type": "stock",
                    "upper_limit": 11.5,
                    "lower_limit": 9.5,
                },
                "SHSE.510300": {
                    "vt_symbol": "510300.SSE",
                    "asset_type": "etf",
                    "upper_limit": 0.0,
                    "lower_limit": 0.0,
                },
                "SHSE.000001": {
                    "vt_symbol": "000001.SSE",
                    "asset_type": "index",
                    "upper_limit": None,
                    "lower_limit": None,
                },
            }
            payload = payload_map[symbol]
            return pd.DataFrame(
                [
                    {
                        "gm_symbol": symbol,
                        "vt_symbol": payload["vt_symbol"],
                        "asset_type": payload["asset_type"],
                        "trade_date": end_date.isoformat(),
                        "board": 10100101 if payload["asset_type"] == "stock" else 10200101 if payload["asset_type"] == "etf" else None,
                        "sec_name": "示例名称",
                        "sec_abbr": "SAMPLE",
                        "price_tick": 0.01,
                        "trade_n": 1,
                        "listed_date": "1991-04-03",
                        "delisted_date": None,
                        "is_suspended": False,
                        "is_st": False,
                        "adj_factor": 1.2,
                        "upper_limit": payload["upper_limit"],
                        "lower_limit": payload["lower_limit"],
                    }
                ]
            )

    securities = [
        SecurityInfo("stock", "SZSE.000001", "SZSE", "000001", "SZSE", "000001.SZSE", date(1991, 4, 3), None),
        SecurityInfo("etf", "SHSE.510300", "SHSE", "510300", "SSE", "510300.SSE", date(2012, 5, 28), None),
        SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None),
    ]
    db = FakeSecurityDb({item.vt_symbol: "2025-01-02" for item in securities})
    task = SecuritySyncTask(
        MixedLimitProvider(),
        db_factory=lambda: db,
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3)],
        universe_loader=lambda: securities,
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run_by_symbol(flush_symbol_count=1, target_trade_date=date(2025, 1, 3)))

    assert result["saved_status_metas"] == len(securities)
    assert db.saved_limit_bar_rows == [
        {
            "vt_symbol": "000001.SZSE",
            "datetime": "2025-01-03 00:00:00",
            "interval": "d",
            "upper_limit": 11.5,
            "lower_limit": 9.5,
        }
    ]


def test_security_sync_task_full_marks_delisted_security_terminal_after_checking_delisted_trade_date() -> None:
    class EmptyHistoryProvider(FakeProvider):
        async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
            return pd.DataFrame()

    delisted_security = SecurityInfo(
        "stock",
        "SZSE.000001",
        "SZSE",
        "000001",
        "SZSE",
        "000001.SZSE",
        date(1991, 4, 3),
        date(2025, 1, 3),
    )
    db = FakeSecurityDb({"000001.SZSE": "2025-01-02"})
    task = SecuritySyncTask(
        EmptyHistoryProvider(),
        db_factory=lambda: db,
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3), date(2025, 1, 6)],
        universe_loader=lambda: [delisted_security],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run_by_symbol(flush_symbol_count=1, target_trade_date=date(2025, 1, 6)))

    assert result["planned_symbol_count"] == 1
    assert db.saved_status_meta_rows == [
        {
            "vt_symbol": "000001.SZSE",
            "latest_checked_trade_date": "2025-01-03",
            "latest_data_trade_date": "2025-01-02",
            "is_terminal": True,
        }
    ]


def test_security_sync_task_by_symbol_fetches_with_default_concurrency_and_keeps_progress_visible() -> None:
    class TrackingProvider(FakeProvider):
        def __init__(self) -> None:
            self.active_request_count = 0
            self.max_active_request_count = 0

        async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
            self.active_request_count += 1
            self.max_active_request_count = max(self.max_active_request_count, self.active_request_count)
            await asyncio.sleep(0.01)
            result = await super().fetch_history_symbol(symbol, start_date, end_date)
            self.active_request_count -= 1
            return result

    class RecordingProgress(DummyProgress):
        instances: list["RecordingProgress"] = []

        def __init__(self, total: int = 0, **kwargs: object) -> None:
            super().__init__(total=total, **kwargs)
            RecordingProgress.instances.append(self)

    securities = [
        SecurityInfo("stock", f"SZSE.{index:06d}", "SZSE", f"{index:06d}", "SZSE", f"{index:06d}.SZSE", date(1991, 4, 3), None)
        for index in range(1, 8)
    ]
    provider = TrackingProvider()
    RecordingProgress.instances = []
    task = SecuritySyncTask(
        provider,
        db_factory=lambda: FakeSecurityDb({}),
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2), date(2025, 1, 3)],
        universe_loader=lambda: securities,
        progress_factory=RecordingProgress,
    )

    result = asyncio.run(task.run_by_symbol(
        flush_symbol_count=10,
        target_trade_date=date(2025, 1, 3),
        plan_mode="full",
    ))

    progress = RecordingProgress.instances[-1]
    assert result["planned_symbol_count"] == len(securities)
    assert progress.updated == len(securities)
    assert "并发中" in progress.postfix
    assert provider.max_active_request_count == 5


def test_index_constituent_sync_task_runs() -> None:
    provider = FakeProvider()
    security = SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None)
    task = IndexConstituentSyncTask(
        provider,
        db_factory=lambda: FakeIndexDb(),
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
    )
    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 2)))
    assert result["planned_index_count"] == 1
    assert result["saved_trade_date_count"] == 2


def test_index_constituent_sync_task_limits_fetch_concurrency() -> None:
    class TrackingProvider(FakeProvider):
        def __init__(self) -> None:
            self.active_request_count = 0
            self.max_active_request_count = 0

        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            self.active_request_count += 1
            self.max_active_request_count = max(self.max_active_request_count, self.active_request_count)
            await asyncio.sleep(0.01)
            self.active_request_count -= 1
            return pd.DataFrame([{"symbol": "SHSE.600000"}, {"symbol": "SZSE.000001"}])

    provider = TrackingProvider()
    securities = [
        SecurityInfo("index", f"SHSE.{index:06d}", "SHSE", f"{index:06d}", "SSE", f"{index:06d}.SSE", date(1991, 7, 15), None)
        for index in range(1, 5)
    ]
    trade_dates = [date(2005, 1, 4), date(2025, 1, 2), date(2025, 1, 3), date(2025, 1, 4)]
    task = IndexConstituentSyncTask(
        provider,
        db_factory=lambda: FakeIndexDb(),
        trade_dates_loader=lambda: trade_dates,
        universe_loader=lambda: securities,
        progress_factory=DummyProgress,
        max_fetch_concurrency=2,
        probe_cache_loader=lambda: {},
        probe_cache_saver=lambda payload: None,
    )

    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 4)))

    assert result["saved_trade_date_count"] == len(securities) * len(trade_dates)
    assert provider.max_active_request_count == 2


def test_index_constituent_sync_task_skips_index_when_latest_trade_date_is_empty() -> None:
    class LatestEmptyProvider(FakeProvider):
        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            if trade_date == date(2025, 1, 3):
                return pd.DataFrame()
            return pd.DataFrame([{"symbol": "SHSE.600000"}])

    provider = LatestEmptyProvider()
    db = FakeIndexDb()
    security = SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None)
    task = IndexConstituentSyncTask(
        provider,
        db_factory=lambda: db,
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 3)))

    assert result["processed_trade_date_count"] == 1
    assert result["saved_trade_date_count"] == 0
    assert result["skipped_by_probe_cache_count"] == 0
    assert db.save_calls == []


def test_index_constituent_sync_task_writes_probe_cache_when_latest_trade_date_is_empty() -> None:
    class LatestEmptyProvider(FakeProvider):
        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            if trade_date == date(2025, 1, 3):
                return pd.DataFrame()
            return pd.DataFrame([{"symbol": "SHSE.600000"}])

    cache_holder: dict[str, object] = {}
    provider = LatestEmptyProvider()
    security = SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None)
    task = IndexConstituentSyncTask(
        provider,
        db_factory=lambda: FakeIndexDb(),
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3), date(2025, 1, 6), date(2025, 1, 7)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
        empty_latest_skip_trade_days=3,
        probe_cache_loader=lambda: cache_holder,
        probe_cache_saver=lambda payload: cache_holder.update(payload),
    )

    asyncio.run(task.run(target_trade_date=date(2025, 1, 3)))

    assert cache_holder == {
        "000001.SSE": {
            "latest_empty_trade_date": "2025-01-03",
            "skip_until_trade_date": "2025-01-07",
            "updated_at": cache_holder["000001.SSE"]["updated_at"],
        }
    }


def test_index_constituent_sync_task_stops_on_first_empty_after_finding_data_and_saves_in_ascending_order() -> None:
    class DescendingProbeProvider(FakeProvider):
        def __init__(self) -> None:
            self.requested_trade_dates: list[date] = []

        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            self.requested_trade_dates.append(trade_date)
            payload_map = {
                date(2025, 1, 6): pd.DataFrame([{"symbol": "SHSE.600000"}, {"symbol": "SZSE.000001"}]),
                date(2025, 1, 3): pd.DataFrame([{"symbol": "SHSE.600000"}]),
            }
            return payload_map.get(trade_date, pd.DataFrame())

    provider = DescendingProbeProvider()
    db = FakeIndexDb()
    security = SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None)
    task = IndexConstituentSyncTask(
        provider,
        db_factory=lambda: db,
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3), date(2025, 1, 6)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 6)))

    assert provider.requested_trade_dates == [date(2025, 1, 6), date(2025, 1, 3), date(2025, 1, 2)]
    assert result["processed_trade_date_count"] == 3
    assert result["saved_trade_date_count"] == 2
    assert db.save_calls == [
        ("000001.SSE", "2025-01-03", ["600000.SSE"]),
        ("000001.SSE", "2025-01-06", ["000001.SZSE", "600000.SSE"]),
    ]


def test_index_constituent_sync_task_skips_by_probe_cache_within_window() -> None:
    class RecordingProvider(FakeProvider):
        def __init__(self) -> None:
            self.request_count = 0

        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            self.request_count += 1
            return pd.DataFrame([{"symbol": "SHSE.600000"}])

    cache_holder = {
        "000001.SSE": {
            "latest_empty_trade_date": "2025-01-03",
            "skip_until_trade_date": "2025-01-07",
            "updated_at": "2026-04-20 09:00:00",
        }
    }
    provider = RecordingProvider()
    task = IndexConstituentSyncTask(
        provider,
        db_factory=lambda: FakeIndexDb(),
        trade_dates_loader=lambda: [date(2025, 1, 2), date(2025, 1, 3), date(2025, 1, 6), date(2025, 1, 7)],
        universe_loader=lambda: [SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None)],
        progress_factory=DummyProgress,
        probe_cache_loader=lambda: cache_holder,
        probe_cache_saver=lambda payload: None,
    )

    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 6)))

    assert result["skipped_by_probe_cache_count"] == 1
    assert result["processed_trade_date_count"] == 0
    assert provider.request_count == 0


def test_index_constituent_sync_task_clears_probe_cache_after_successful_fetch() -> None:
    class SuccessfulProvider(FakeProvider):
        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            return pd.DataFrame([{"symbol": "SHSE.600000"}])

    saved_cache: dict[str, object] = {}
    task = IndexConstituentSyncTask(
        SuccessfulProvider(),
        db_factory=lambda: FakeIndexDb(),
        trade_dates_loader=lambda: [date(2025, 1, 8)],
        universe_loader=lambda: [SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None)],
        progress_factory=DummyProgress,
        probe_cache_loader=lambda: {
            "000001.SSE": {
                "latest_empty_trade_date": "2025-01-03",
                "skip_until_trade_date": "2025-01-07",
                "updated_at": "2026-04-20 09:00:00",
            }
        },
        probe_cache_saver=lambda payload: saved_cache.update(payload),
    )

    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 8)))

    assert result["saved_trade_date_count"] == 1
    assert saved_cache == {}


def test_index_constituent_sync_task_persists_probe_cache_after_each_completed_index() -> None:
    class MixedProvider(FakeProvider):
        async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
            if index_symbol == "SHSE.000001":
                return pd.DataFrame()
            return pd.DataFrame([{"symbol": "SHSE.600000"}])

    saved_payloads: list[dict[str, object]] = []
    securities = [
        SecurityInfo("index", "SHSE.000001", "SHSE", "000001", "SSE", "000001.SSE", date(1991, 7, 15), None),
        SecurityInfo("index", "SHSE.000300", "SHSE", "000300", "SSE", "000300.SSE", date(2005, 4, 8), None),
    ]
    task = IndexConstituentSyncTask(
        MixedProvider(),
        db_factory=lambda: FakeIndexDb(),
        trade_dates_loader=lambda: [date(2025, 1, 3)],
        universe_loader=lambda: securities,
        progress_factory=DummyProgress,
        probe_cache_loader=lambda: {},
        probe_cache_saver=lambda payload: saved_payloads.append(dict(payload)),
    )

    result = asyncio.run(task.run(target_trade_date=date(2025, 1, 3)))

    assert result["planned_index_count"] == 2
    assert len(saved_payloads) >= 2
    assert any("000001.SSE" in payload for payload in saved_payloads)
    assert saved_payloads[-1] == saved_payloads[-2] or "000001.SSE" in saved_payloads[-1]


def test_bar_sync_task_runs() -> None:
    provider = FakeProvider()
    security = sample_security()
    task = BarSyncTask(
        provider,
        db_factory=FakeBarDb,
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2)],
        universe_loader=lambda: [security],
        progress_factory=DummyProgress,
    )
    result = asyncio.run(task.run_incremental(overlap_validation_days=0))
    assert result["planned_symbol_count"] == 1
    assert result["fetched_rows"] == 2
    assert result["quality"]["status"] == "healthy"
    assert "report_json_path" not in result
    assert "report_csv_path" not in result


def test_bar_sync_task_rejects_invalid_batch_before_write(monkeypatch) -> None:
    class InvalidProvider(FakeProvider):
        async def fetch_history(
            self,
            symbols: list[str],
            start_date: date,
            end_date: date,
            fields: str,
        ) -> pd.DataFrame:
            frame = await super().fetch_history(
                symbols,
                start_date,
                end_date,
                fields,
            )
            frame.loc[:, "high"] = 9.0
            return frame

    monkeypatch.setattr(
        "alpha.sync_tasks.tasks.bar_sync.write_update_report",
        lambda *_args, **_kwargs: ("report.json", "report.csv"),
    )
    fake_db = FakeBarDb()
    task = BarSyncTask(
        InvalidProvider(),
        db_factory=lambda: fake_db,
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2)],
        universe_loader=lambda: [sample_security()],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run_incremental(overlap_validation_days=0))

    assert fake_db.saved_rows == []
    assert result["failed_batch_count"] == 2
    assert result["quality"]["validation_issue_count"] == 2
    assert result["quality"]["failed_vt_symbols"] == ["600000.SSE"]


def test_bar_sync_task_filters_targeted_retry_symbols() -> None:
    requested: list[list[str]] = []

    class RecordingProvider(FakeProvider):
        async def fetch_history(
            self,
            symbols: list[str],
            start_date: date,
            end_date: date,
            fields: str,
        ) -> pd.DataFrame:
            requested.append(list(symbols))
            return await super().fetch_history(
                symbols,
                start_date,
                end_date,
                fields,
            )

    second = SecurityInfo(
        "stock",
        "SZSE.000001",
        "SZSE",
        "000001",
        "SZSE",
        "000001.SZSE",
        date(1991, 4, 3),
        None,
    )
    task = BarSyncTask(
        RecordingProvider(),
        db_factory=FakeBarDb,
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2)],
        universe_loader=lambda: [sample_security(), second],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(
        task.run_incremental(
            overlap_validation_days=0,
            vt_symbols=["600000.SSE"],
        )
    )

    assert result["planned_symbol_count"] == 1
    assert requested == [["SHSE.600000"], ["SHSE.600000"]]


def test_bar_sync_job_persists_compact_quality_snapshot(monkeypatch) -> None:
    quality = {
        "schema_version": 1,
        "status": "healthy",
        "failed_vt_symbols": [],
        "failed_vt_symbol_count": 0,
        "issues": [],
    }
    saved: list[dict[str, object]] = []

    class FakeJobTask:
        def __init__(self, _provider: object) -> None:
            pass

        async def run_incremental(
            self,
            *,
            vt_symbols: list[str] | None,
        ) -> dict[str, object]:
            assert vt_symbols == ["600000.SSE"]
            return {"quality": quality}

    monkeypatch.setattr(
        "alpha.sync_tasks.gm_async.GmAsyncProvider",
        lambda: object(),
    )
    monkeypatch.setattr(
        "alpha.sync_tasks.tasks.bar_sync.BarSyncTask",
        FakeJobTask,
    )
    monkeypatch.setattr(
        "alpha.sync_tasks.jobs.write_quality_snapshot",
        lambda snapshot: saved.append(snapshot),
    )

    result = run_bar_sync_job(["600000.SSE"])

    assert result == {"quality": quality}
    assert saved == [quality]


def test_bar_sync_task_persists_report_when_batch_failed(monkeypatch) -> None:
    class FailingProvider(FakeProvider):
        async def fetch_history(self, symbols: list[str], start_date: date, end_date: date, fields: str) -> pd.DataFrame:
            raise RuntimeError("boom")

    recorded_calls: list[tuple[str, dict[str, object], int, int]] = []

    def fake_write_update_report(
        report_name: str,
        summary: dict[str, object],
        batch_results,
        validation_issues,
        **_kwargs,
    ):
        recorded_calls.append((report_name, dict(summary), len(batch_results), len(validation_issues)))
        return "report.json", "report.csv"

    monkeypatch.setattr("alpha.sync_tasks.tasks.bar_sync.write_update_report", fake_write_update_report)

    task = BarSyncTask(
        FailingProvider(),
        db_factory=FakeBarDb,
        trade_dates_loader=lambda: [date(2005, 1, 4), date(2025, 1, 2)],
        universe_loader=lambda: [sample_security()],
        progress_factory=DummyProgress,
    )

    result = asyncio.run(task.run_incremental(overlap_validation_days=0))

    assert result["failed_batch_count"] == 2
    assert result["report_json_path"] == "report.json"
    assert result["report_csv_path"] == "report.csv"
    assert len(recorded_calls) == 1
    assert recorded_calls[0][2] == 2
