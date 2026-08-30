"""Alpha 同步任务的可序列化子进程入口。"""

from __future__ import annotations

import asyncio
from datetime import datetime

from alpha.sync_tasks.constants import MAX_QUALITY_RETRY_SYMBOLS
from alpha.sync_tasks.reporting import write_quality_snapshot
from alpha.runtime.processes import TaskMessagePublisher


def run_bar_sync_job(
    vt_symbols: list[str] | None = None,
    *,
    publisher: TaskMessagePublisher | None = None,
) -> dict[str, object]:
    """在子进程执行日线增量同步并持久化最近质量快照。"""
    started_at = datetime.now()
    try:
        # 延迟导入 GM，避免 API 挂载同步路由时要求外部数据源凭据。
        from alpha.sync_tasks.gm_async import GmAsyncProvider
        from alpha.sync_tasks.tasks.bar_sync import BarSyncTask

        if publisher is not None:
            publisher.log("开始日线增量同步")
        result = asyncio.run(
            BarSyncTask(
                GmAsyncProvider(),
                progress=publisher.progress if publisher is not None else None,
            ).run_incremental(vt_symbols=vt_symbols)
        )
        quality = result.get("quality")
        if not isinstance(quality, dict):
            raise RuntimeError("日线同步没有返回质量快照")
        write_quality_snapshot(quality)
        if publisher is not None:
            publisher.stage("finalizing")
            publisher.log("日线增量同步完成")
        return {"quality": quality}
    except Exception as exc:
        all_failed_symbols = set(vt_symbols or [])
        failed_symbols = sorted(all_failed_symbols)[:MAX_QUALITY_RETRY_SYMBOLS]
        snapshot: dict[str, object] = {
            "schema_version": 1,
            "status": "failed",
            "started_at": started_at.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"),
            "latest_trade_date": None,
            "planned_symbol_count": len(all_failed_symbols),
            "fetched_rows": 0,
            "saved_rows": 0,
            "failed_batch_count": 1,
            "validation_issue_count": 0,
            "failed_vt_symbols": failed_symbols,
            "failed_vt_symbol_count": len(all_failed_symbols),
            "issues": [],
            "message": str(exc),
        }
        write_quality_snapshot(snapshot)
        raise
