from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pandas as pd

from alpha.sync_tasks.constants import LOG_FOLDER_NAME
from alpha.sync_tasks.models import BatchResult, ValidationIssue
from alpha.common.paths import get_runtime_subdir


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
) -> tuple[Path, Path]:
    """将本次同步结果落盘。"""
    log_dir = get_runtime_subdir(LOG_FOLDER_NAME)
    json_path = log_dir.joinpath(f"{report_name}.json")
    csv_path = log_dir.joinpath(f"{report_name}_validation_issues.csv")

    json_payload = {
        **summary,
        "batch_results": [asdict(item) for item in batch_results],
        "validation_issue_count": len(validation_issues),
    }
    json_path.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")

    issue_df = pd.DataFrame([asdict(item) for item in validation_issues])
    issue_df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    return json_path, csv_path
