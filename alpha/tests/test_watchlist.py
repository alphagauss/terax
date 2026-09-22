"""锁定自选持久化、并发精确修改和公共接口的证券校验边界。"""

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from alpha.api.deps import get_alpha_services
from alpha.api.routes.watchlist import router
from alpha.api.routes.tasks import router as task_router
from alpha.storage.database import DataBase


def test_watchlist_preserves_other_clients_and_survives_reopen(tmp_path):
    async def run():
        first = DataBase(tmp_path)
        second = DataBase(tmp_path)
        await asyncio.gather(
            first.set_watchlist_symbol("000001.SZSE", True),
            second.set_watchlist_symbol("600000.SSE", True),
        )
        await first.set_watchlist_symbol("000001.SZSE", True)
        assert {item["vt_symbol"] for item in await second.list_watchlist()} == {
            "000001.SZSE",
            "600000.SSE",
        }
        await asyncio.gather(
            first.set_watchlist_symbol("000001.SZSE", False),
            second.set_watchlist_symbol("600001.SSE", True),
        )
        await first.close()
        await second.close()
        reopened = DataBase(tmp_path)
        assert {item["vt_symbol"] for item in await reopened.list_watchlist()} == {
            "600000.SSE",
            "600001.SSE",
        }
        await reopened.close()

    asyncio.run(run())


def test_watchlist_rejects_unknown_additions_but_allows_removing_stale_symbols(
    tmp_path,
):
    database = DataBase(tmp_path)
    asyncio.run(
        database.save_security_profiles(
            [
                {
                    "vt_symbol": "000001.SZSE",
                    "asset_type": "stock",
                    "sec_name": "平安银行",
                }
            ]
        )
    )
    asyncio.run(database.set_watchlist_symbol("MISSING.SSE", True))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_alpha_services] = lambda: SimpleNamespace(
        database=database
    )
    with TestClient(app) as client:
        assert client.get("/watchlist").json() == [
            {"vt_symbol": "MISSING.SSE", "name": "MISSING.SSE"}
        ]
        assert (
            client.post(
                "/watchlist", json={"vt_symbol": "bad", "included": True}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/watchlist", json={"vt_symbol": "UNKNOWN.SSE", "included": True}
            ).status_code
            == 404
        )
        response = client.post(
            "/watchlist", json={"vt_symbol": "missing.sse", "included": False}
        )
        assert response.status_code == 200
        assert response.json() == []
        for _ in range(2):
            response = client.post(
                "/watchlist", json={"vt_symbol": "000001.szse", "included": True}
            )
            assert response.status_code == 200
            assert response.json() == [{"vt_symbol": "000001.SZSE", "name": "平安银行"}]
    asyncio.run(database.close())


def test_task_list_recovers_authoritative_snapshot_after_reconnect():
    snapshots = [{"task_id": "sync-1", "status": "running", "revision": 1}]
    app = FastAPI()
    app.include_router(task_router)
    app.dependency_overrides[get_alpha_services] = lambda: SimpleNamespace(
        task_manager=SimpleNamespace(list_snapshots=lambda: list(snapshots))
    )
    with TestClient(app) as client:
        assert client.get("/tasks").json() == snapshots
        snapshots[0] = {"task_id": "sync-1", "status": "succeeded", "revision": 2}
        assert client.get("/tasks").json()[0]["revision"] == 2
        snapshots.clear()
        assert client.get("/tasks").json() == []
