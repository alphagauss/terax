"""Alpha 同步任务报告的本机持久化。"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pandas as pd

from alpha.config import get_state_subdir, load_json, save_json
from alpha.sync_tasks.constants import (
    LOG_FOLDER_NAME,
    MAX_QUALITY_ISSUES,
    MAX_QUALITY_RETRY_SYMBOLS,
)
from alpha.sync_tasks.models import BatchResult, ValidationIssue

QUALITY_STATE_FOLDER = "data-quality"
QUALITY_STATE_FILENAME = "latest.json"


def format_stage_timings(timings: dict[str, float]) -> str:
    """将阶段耗时格式化为易读文本。"""
    if not timings:
        return "无阶段耗时数据"
    return " | ".join(f"{stage}={seconds:.3f}s" for stage, seconds in timings.items())


def write_update_report(
    report_name: str,
    summary: dict[str, object],
    batch_results: list[BatchResult],
    validation_issues: list[ValidationIssue],
    *,
    validation_issue_count: int | None = None,
) -> tuple[Path, Path]:
    """将本次同步结果落盘。"""
    log_dir = get_state_subdir(LOG_FOLDER_NAME)
    json_path = log_dir.joinpath(f"{report_name}.json")
    csv_path = log_dir.joinpath(f"{report_name}_validation_issues.csv")

    json_payload = {
        **summary,
        "batch_results": [asdict(item) for item in batch_results],
        "validation_issue_count": (
            validation_issue_count
            if validation_issue_count is not None
            else len(validation_issues)
        ),
    }
    json_path.write_text(
        json.dumps(json_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
        newline="\n",
    )

    issue_df = pd.DataFrame([asdict(item) for item in validation_issues])
    issue_df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    return json_path, csv_path


def build_quality_snapshot(
    summary: dict[str, object],
    validation_issues: list[ValidationIssue],
    validation_issue_count: int,
    failed_vt_symbols: set[str],
) -> dict[str, object]:
    """构造 API 可直接消费的有界日线质量快照。"""
    failed_symbols = sorted(failed_vt_symbols)[:MAX_QUALITY_RETRY_SYMBOLS]
    return {
        "schema_version": 1,
        "status": (
            "healthy"
            if int(summary.get("failed_batch_count") or 0) == 0
            and validation_issue_count == 0
            else "issues"
        ),
        "started_at": summary.get("started_at"),
        "finished_at": summary.get("finished_at"),
        "latest_trade_date": summary.get("latest_trade_date"),
        "planned_symbol_count": int(summary.get("planned_symbol_count") or 0),
        "fetched_rows": int(summary.get("fetched_rows") or 0),
        "saved_rows": int(summary.get("saved_rows") or 0),
        "failed_batch_count": int(summary.get("failed_batch_count") or 0),
        "validation_issue_count": validation_issue_count,
        "failed_vt_symbols": failed_symbols,
        "failed_vt_symbol_count": len(failed_vt_symbols),
        "issues": [asdict(issue) for issue in validation_issues[:MAX_QUALITY_ISSUES]],
        "message": summary.get("message"),
    }


def write_quality_snapshot(snapshot: dict[str, object]) -> None:
    """保存最近一次日线同步质量快照。"""
    save_json(QUALITY_STATE_FILENAME, snapshot, QUALITY_STATE_FOLDER)


def load_quality_snapshot() -> dict[str, object] | None:
    """读取最近一次日线同步质量快照。"""
    snapshot = load_json(QUALITY_STATE_FILENAME, QUALITY_STATE_FOLDER)
    return snapshot or None
