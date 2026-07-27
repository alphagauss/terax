"""Alpha 业务 API 总路由。"""

from __future__ import annotations

from fastapi import APIRouter

from alpha.api.routes import (
    bars,
    backtests,
    data,
    health,
    securities,
    status,
    strategies,
    sync,
    system,
    tasks,
)

router = APIRouter()
router.include_router(health.router)
router.include_router(system.router)
router.include_router(status.router)
router.include_router(data.router)
router.include_router(securities.router)
router.include_router(bars.router)
router.include_router(strategies.router)
router.include_router(backtests.router)
router.include_router(sync.router)
router.include_router(tasks.router)
