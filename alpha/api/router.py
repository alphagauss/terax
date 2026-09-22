"""Alpha 业务 API 总路由。"""

from __future__ import annotations

from fastapi import APIRouter

from alpha.api.routes import (
    bars,
    backtests,
    data,
    health,
    securities,
    settings,
    status,
    studies,
    strategies,
    sync,
    system,
    tasks,
    watchlist,
)

router = APIRouter()
router.include_router(health.router)
router.include_router(system.router)
router.include_router(status.router)
router.include_router(data.router)
router.include_router(securities.router)
router.include_router(settings.router)
router.include_router(bars.router)
router.include_router(studies.router)
router.include_router(strategies.router)
router.include_router(backtests.router)
router.include_router(sync.router)
router.include_router(tasks.router)
router.include_router(watchlist.router)
