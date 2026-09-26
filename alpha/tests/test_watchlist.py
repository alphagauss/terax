"""锁定分组隔离、持久化、并发位置命令与批量事务边界。"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alpha.api.deps import get_alpha_services
from alpha.api.routes.watchlist import router
from alpha.api.routes.tasks import router as task_router
from alpha.storage.database import DataBase
from alpha.storage.repositories.watchlist import WatchlistConflict

A, B, C = "000001.SZSE", "600000.SSE", "600001.SSE"


def members(snapshot, group="all"):
    return [r for r in snapshot["items"] if r["group_id"] == group]


def symbols(snapshot, group="all"):
    return [r["vt_symbol"] for r in members(snapshot, group)]


def test_groups_atomic_transfer_pin_order_and_persistence(tmp_path):
    async def run():
        db = DataBase(tmp_path)
        await db.change_watchlist(dict(action="add", symbols=[A, B, C]))
        snapshot = await db.change_watchlist(dict(action="create_group", name="研究"))
        source = snapshot["groups"][0]["id"]
        snapshot = await db.change_watchlist(dict(action="create_group", name="观察"))
        target = snapshot["groups"][1]["id"]
        await db.change_watchlist(
            dict(action="copy", group_id="all", target_group_id=source, symbols=[A, B])
        )
        await db.change_watchlist(
            dict(action="copy", group_id="all", target_group_id=target, symbols=[B])
        )
        await db.change_watchlist(
            dict(action="pin", group_id=source, symbols=[A], pinned=True)
        )
        snapshot = await db.change_watchlist(
            dict(action="move", group_id=source, target_group_id=target, symbols=[B, A])
        )
        assert snapshot["transfer"] == {"total": 2, "existing": 1}
        assert symbols(snapshot, source) == []
        assert symbols(snapshot, target) == [B, A]
        assert not any(r["pinned"] for r in members(snapshot, target))
        assert symbols(snapshot) == [A, B, C]
        with pytest.raises(WatchlistConflict):
            await db.change_watchlist(
                dict(
                    action="move",
                    group_id=target,
                    target_group_id=source,
                    symbols=[A, C],
                )
            )
        snapshot = await db.get_watchlist()
        assert symbols(snapshot, source) == []
        assert symbols(snapshot, target) == [B, A]
        await db.change_watchlist(dict(action="pin", symbols=[B], pinned=True))
        await db.change_watchlist(
            dict(action="reorder", symbols=[C], anchor=A, side="before")
        )
        snapshot = await db.change_watchlist(
            dict(action="pin", symbols=[B], pinned=False)
        )
        assert symbols(snapshot) == [C, B, A]
        await db.change_watchlist(dict(action="remove", group_id=target, symbols=[A]))
        assert A in symbols(await db.get_watchlist())
        await db.change_watchlist(dict(action="remove", group_id="all", symbols=[B]))
        snapshot = await db.change_watchlist(
            dict(action="delete_group", group_id=source)
        )
        assert symbols(snapshot, target) == []
        assert symbols(snapshot) == [C, A]
        await db.close()
        reopened = DataBase(tmp_path)
        assert await reopened.get_watchlist() == snapshot
        await reopened.close()

    asyncio.run(run())


def test_concurrent_clients_preserve_members_and_reject_stale_anchor(tmp_path):
    async def run():
        first, second = DataBase(tmp_path), DataBase(tmp_path)
        await asyncio.gather(
            first.change_watchlist(dict(action="add", symbols=[A])),
            second.change_watchlist(dict(action="add", symbols=[B])),
        )
        await first.change_watchlist(dict(action="add", symbols=[A]))
        assert set(symbols(await second.get_watchlist())) == {A, B}
        await asyncio.gather(
            first.change_watchlist(dict(action="reorder", symbols=[B], edge="first")),
            second.change_watchlist(dict(action="add", symbols=[C])),
        )
        assert set(symbols(await second.get_watchlist())) == {A, B, C}
        await first.change_watchlist(dict(action="remove", symbols=[A]))
        with pytest.raises(WatchlistConflict):
            await second.change_watchlist(
                dict(action="reorder", symbols=[B], anchor=A, side="after")
            )
        assert set(symbols(await second.get_watchlist())) == {B, C}
        await first.close()
        await second.close()

    asyncio.run(run())


def test_watchlist_api_validates_commands_and_cleans_stale_members(tmp_path):
    db = DataBase(tmp_path)
    asyncio.run(
        db.save_security_profiles(
            [{"vt_symbol": A, "asset_type": "stock", "sec_name": "平安银行"}]
        )
    )
    asyncio.run(db.change_watchlist(dict(action="add", symbols=[C])))
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_alpha_services] = lambda: SimpleNamespace(database=db)
    with TestClient(app) as client:

        def post(**command):
            return client.post("/watchlist/commands", json=command)

        assert post(action="add", symbols=[A, B]).status_code == 404
        assert symbols(client.get("/watchlist").json()) == [C]
        assert post(action="add", symbols=["bad"]).status_code == 422
        assert post(action="reorder", symbols=[C]).status_code == 422
        assert (
            post(action="reorder", symbols=[C], edge="first", anchor=A).status_code
            == 422
        )
        assert post(action="pin", symbols=[C]).status_code == 422
        assert post(action="delete_group", group_id="all").status_code == 409
        assert post(action="create_group", name="   ").status_code == 422
        assert post(action="create_group", name="观察").status_code == 200
        assert post(action="create_group", name="观察").status_code == 409
        assert post(action="remove", symbols=[C.lower()]).status_code == 200
        for _ in range(2):
            assert post(action="add", symbols=[A.lower()]).status_code == 200
        assert symbols(client.get("/watchlist").json()) == [A]
        quotes = client.get("/watchlist/quotes").json()
        assert quotes[0]["status"] == "missing"
        assert quotes[0]["change"] is None
        assert client.get("/watchlist/quotes?group_id=deleted").status_code == 409
    asyncio.run(db.close())


def test_daily_summary_uses_raw_price_and_suppresses_adjustment_discontinuity():
    state = {"adjusted": [10, 11], "fail_adjusted": False}

    async def get_watchlist():
        return {
            "groups": [],
            "items": [{"group_id": "all", "vt_symbol": A, "price_tick": 0.01}],
        }

    async def history(query):
        if query.adjust == "pre" and state["fail_adjusted"]:
            raise OSError("unavailable adjustment data")
        values = [10, 11] if query.adjust == "non" else state["adjusted"]
        assert query.limit <= 20
        return {
            "items": [
                {"datetime": f"2026-09-{day:02d}", "close": value}
                for day, value in zip([21, 22], values)
            ]
        }

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_alpha_services] = lambda: SimpleNamespace(
        database=SimpleNamespace(get_watchlist=get_watchlist, load_bar_history=history)
    )
    with TestClient(app) as client:
        quote = client.get("/watchlist/quotes").json()[0]
        assert quote["close"] == 11
        assert quote["change"] == pytest.approx(10)
        assert quote["date"] == "2026-09-22"
        state["adjusted"] = [5, 11]
        quote = client.get("/watchlist/quotes").json()[0]
        assert quote["close"] == 11
        assert quote["closes"] == [5, 11]
        assert quote["change"] is None
        state["fail_adjusted"] = True
        quote = client.get("/watchlist/quotes").json()[0]
        assert quote["close"] == 11
        assert quote["date"] == "2026-09-22"
        assert quote["status"] == "error"


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
