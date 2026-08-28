from __future__ import annotations

from datetime import date, datetime
from time import perf_counter
from typing import Callable

from loguru import logger
from tqdm import tqdm

from alpha.storage.database import DataBase
from alpha.sync_tasks.base import BaseSyncProvider
from alpha.sync_tasks.calendar import get_latest_target_trade_date
from alpha.sync_tasks.constants import (
    MAX_QUALITY_ISSUES,
    SYNC_FIELDS,
    YEAR_BUFFER_FLUSH_ROWS,
)
from alpha.sync_tasks.models import (
    BarWriteCoverage,
    BatchResult,
    SecurityInfo,
    StageProfiler,
    ValidationIssue,
    YearPlan,
)
from alpha.sync_tasks.planners import (
    build_bar_sync_plans,
    chunk_year_plans,
    split_bar_sync_plans_by_year,
)
from alpha.sync_tasks.reporting import (
    build_quality_snapshot,
    format_stage_timings,
    write_update_report,
)
from alpha.sync_tasks.universe import (
    load_symbol_universe_from_csv,
    load_trade_dates_from_csv,
)
from alpha.sync_tasks.validators import (
    merge_bar_coverage,
    validate_bar_batch,
    validate_overlap_rows,
    validate_overview_coverage,
)
from alpha.sync_tasks.writers import flush_year_buffer, load_bar_overview_map


class BarSyncTask:
    """A 股日线同步任务。"""

    def __init__(
        self,
        provider: BaseSyncProvider,
        *,
        db_factory: Callable[[], DataBase] = DataBase,
        trade_dates_loader: Callable[[], list[date]] = load_trade_dates_from_csv,
        universe_loader: Callable[
            [], list[SecurityInfo]
        ] = load_symbol_universe_from_csv,
        progress_factory=tqdm,
        logger_instance=logger,
    ) -> None:
        self.provider = provider
        self.db_factory = db_factory
        self.trade_dates_loader = trade_dates_loader
        self.universe_loader = universe_loader
        self.progress_factory = progress_factory
        self.logger = logger_instance

    async def run_incremental(
        self,
        overlap_validation_days: int = 30,
        rebuild_overview_before_update: bool = False,
        profile: bool = False,
        vt_symbols: list[str] | None = None,
    ) -> dict[str, object]:
        """执行增量同步。"""
        if overlap_validation_days < 0:
            raise ValueError("overlap_validation_days 不能小于 0")

        started_at = datetime.now()
        trade_dates = self.trade_dates_loader()
        latest_trade_date = get_latest_target_trade_date(trade_dates, started_at)
        securities = self.universe_loader()
        if vt_symbols is not None:
            requested_symbols = set(vt_symbols)
            known_symbols = {item.vt_symbol for item in securities}
            unknown_symbols = requested_symbols - known_symbols
            if unknown_symbols:
                raise ValueError(
                    f"同步标的不在证券池: {', '.join(sorted(unknown_symbols))}"
                )
            securities = [
                item for item in securities if item.vt_symbol in requested_symbols
            ]
        profiler = StageProfiler(enabled=profile)

        db = self.db_factory()
        try:
            if rebuild_overview_before_update:
                self.progress_factory.write("开始重建 bar_overview ...")
                rebuild_started_at = perf_counter()
                await db.rebuild_bar_overview()
                profiler.add("daily_rebuild_overview_before", rebuild_started_at)
                self.progress_factory.write("bar_overview 重建完成")
            overview_map = await load_bar_overview_map(db)
            plans = build_bar_sync_plans(
                securities,
                overview_map,
                trade_dates,
                latest_trade_date,
                overlap_validation_days=overlap_validation_days,
            )
            year_plans = split_bar_sync_plans_by_year(plans, trade_dates)
            batches_by_year = chunk_year_plans(year_plans)
            total_batch_count = sum(len(item) for item in batches_by_year.values())

            print(
                f"开始增量更新日线行情：计划标的 {len(plans)} 个，"
                f"年份 {len(batches_by_year)} 个，批次 {total_batch_count} 个，"
                f"目标截止交易日 {latest_trade_date}"
            )

            batch_results: list[BatchResult] = []
            validation_issues: list[ValidationIssue] = []
            validation_issue_count = 0
            failed_vt_symbols: set[str] = set()
            written_coverage: dict[str, BarWriteCoverage] = {}
            total_fetched_rows = 0
            total_saved_rows = 0
            failed_batch_count = 0
            global_batch_index = 0

            self.logger.disable("alpha")
            try:
                years = sorted(batches_by_year)
                with self.progress_factory(
                    total=len(years), desc="年度进度", unit="year", dynamic_ncols=True
                ) as year_pbar:
                    for year in years:
                        year_batches = batches_by_year[year]
                        year_buffer_rows: list[dict[str, object]] = []
                        year_saved_rows = 0
                        year_fetched_rows = 0
                        year_issue_count = 0

                        with self.progress_factory(
                            total=len(year_batches),
                            desc=f"{year} 批次",
                            unit="batch",
                            dynamic_ncols=True,
                            leave=False,
                        ) as batch_pbar:
                            for year_batch_index, batch in enumerate(
                                year_batches, start=1
                            ):
                                global_batch_index += 1
                                batch_start = batch[0].start_date.strftime("%Y-%m-%d")
                                batch_end = batch[0].end_date.strftime("%Y-%m-%d")
                                estimated_rows = sum(
                                    item.expected_rows for item in batch
                                )

                                try:
                                    fetch_started_at = perf_counter()
                                    df = await self.provider.fetch_history(
                                        [plan.gm_symbol for plan in batch],
                                        batch[0].start_date,
                                        batch[0].end_date,
                                        SYNC_FIELDS,
                                    )
                                    profiler.add("daily_fetch", fetch_started_at)

                                    normalize_started_at = perf_counter()
                                    normalized_rows = df.to_dict(orient="records")
                                    profiler.add(
                                        "daily_normalize", normalize_started_at
                                    )
                                    batch_fetched_rows = len(normalized_rows)
                                    batch_issue_count = 0

                                    batch_validation = validate_bar_batch(
                                        normalized_rows,
                                        batch,
                                        issue_limit=max(
                                            0,
                                            MAX_QUALITY_ISSUES - len(validation_issues),
                                        ),
                                    )
                                    validation_issue_count += (
                                        batch_validation.issue_count
                                    )
                                    validation_issues.extend(batch_validation.issues)
                                    batch_issue_count += batch_validation.issue_count
                                    failed_vt_symbols.update(
                                        batch_validation.retry_vt_symbols
                                    )
                                    year_fetched_rows += batch_fetched_rows
                                    year_issue_count += batch_validation.issue_count
                                    total_fetched_rows += batch_fetched_rows

                                    if not batch_validation.can_write:
                                        failed_batch_count += 1
                                        failed_vt_symbols.update(
                                            plan.vt_symbol for plan in batch
                                        )
                                        batch_results.append(
                                            BatchResult(
                                                batch_index=global_batch_index,
                                                batch_total=total_batch_count,
                                                request_start=batch_start,
                                                request_end=batch_end,
                                                symbol_count=len(batch),
                                                fetched_rows=batch_fetched_rows,
                                                saved_rows=0,
                                                validation_issue_count=(
                                                    batch_issue_count
                                                ),
                                                status="failed",
                                                message="批次质量校验失败",
                                            )
                                        )
                                        batch_pbar.set_postfix_str(
                                            f"窗口 {batch_start}->{batch_end} | 质量校验失败"
                                        )
                                        continue

                                    if overlap_validation_days > 0:
                                        validate_started_at = perf_counter()
                                        for plan in batch:
                                            plan_rows = (
                                                batch_validation.rows_by_symbol.get(
                                                    plan.vt_symbol,
                                                    [],
                                                )
                                            )
                                            result = await validate_overlap_rows(
                                                db,
                                                plan,
                                                plan_rows,
                                            )
                                            validation_issue_count += result.issue_count
                                            batch_issue_count += result.issue_count
                                            remaining = max(
                                                0,
                                                MAX_QUALITY_ISSUES
                                                - len(validation_issues),
                                            )
                                            validation_issues.extend(
                                                result.issues[:remaining]
                                            )
                                        profiler.add(
                                            "daily_validate_overlap",
                                            validate_started_at,
                                        )

                                    year_buffer_rows.extend(normalized_rows)
                                    merge_bar_coverage(
                                        written_coverage,
                                        batch_validation.coverage,
                                    )
                                    year_issue_count += (
                                        batch_issue_count - batch_validation.issue_count
                                    )

                                    flushed_rows = 0
                                    if len(year_buffer_rows) >= YEAR_BUFFER_FLUSH_ROWS:
                                        flush_started_at = perf_counter()
                                        flushed_rows = await flush_year_buffer(
                                            db, year_buffer_rows
                                        )
                                        profiler.add("daily_flush", flush_started_at)
                                        year_saved_rows += flushed_rows
                                        total_saved_rows += flushed_rows
                                        self.progress_factory.write(
                                            f"[年份 {year}] flush 写入 {flushed_rows} 条，年累计入库 {year_saved_rows} 条"
                                        )

                                    batch_results.append(
                                        BatchResult(
                                            batch_index=global_batch_index,
                                            batch_total=total_batch_count,
                                            request_start=batch_start,
                                            request_end=batch_end,
                                            symbol_count=len(batch),
                                            fetched_rows=batch_fetched_rows,
                                            saved_rows=flushed_rows,
                                            validation_issue_count=batch_issue_count,
                                            status="success",
                                            message="",
                                        )
                                    )
                                    batch_pbar.set_postfix_str(
                                        f"窗口 {batch_start}->{batch_end} | 标的 {len(batch)}"
                                        f" | 预计 {estimated_rows} | 抓取 {batch_fetched_rows}"
                                        f" | 缓冲 {len(year_buffer_rows)} | 异常 {year_issue_count}"
                                    )
                                except Exception as exc:
                                    failed_batch_count += 1
                                    failed_vt_symbols.update(
                                        plan.vt_symbol for plan in batch
                                    )
                                    batch_results.append(
                                        BatchResult(
                                            batch_index=global_batch_index,
                                            batch_total=total_batch_count,
                                            request_start=batch_start,
                                            request_end=batch_end,
                                            symbol_count=len(batch),
                                            fetched_rows=0,
                                            saved_rows=0,
                                            validation_issue_count=0,
                                            status="failed",
                                            message=str(exc),
                                        )
                                    )
                                    self.progress_factory.write(
                                        f"[年份 {year}][失败 {year_batch_index}/{len(year_batches)}] 窗口 {batch_start} -> {batch_end}，错误：{exc}"
                                    )
                                    batch_pbar.set_postfix_str(
                                        f"窗口 {batch_start}->{batch_end} | 批次失败 | 异常 {year_issue_count}"
                                    )
                                finally:
                                    batch_pbar.update(1)

                        flush_started_at = perf_counter()
                        try:
                            flushed_rows = await flush_year_buffer(
                                db,
                                year_buffer_rows,
                            )
                        except Exception as exc:
                            failed_batch_count += 1
                            failed_vt_symbols.update(
                                plan.vt_symbol
                                for year_batch in year_batches
                                for plan in year_batch
                            )
                            self.progress_factory.write(
                                f"[年份 {year}] 收尾写入失败：{exc}"
                            )
                            flushed_rows = 0
                        profiler.add("daily_flush", flush_started_at)
                        if flushed_rows > 0:
                            year_saved_rows += flushed_rows
                            total_saved_rows += flushed_rows
                            self.progress_factory.write(
                                f"[年份 {year}] 收尾写入 {flushed_rows} 条，年累计抓取 {year_fetched_rows} 条，入库 {year_saved_rows} 条，校验异常 {year_issue_count} 条"
                            )
                        else:
                            self.progress_factory.write(
                                f"[年份 {year}] 处理完成，年累计抓取 {year_fetched_rows} 条，入库 {year_saved_rows} 条，校验异常 {year_issue_count} 条"
                            )
                        year_pbar.set_postfix_str(
                            f"当前年份 {year} | 批次 {len(year_batches)} | 抓取 {year_fetched_rows}"
                            f" | 入库 {year_saved_rows} | 异常 {year_issue_count}"
                        )
                        year_pbar.update(1)
            finally:
                self.logger.enable("alpha")

            if total_saved_rows > 0:
                self.progress_factory.write("开始重建 bar_overview ...")
                rebuild_started_at = perf_counter()
                await db.rebuild_bar_overview()
                profiler.add("daily_rebuild_overview_after", rebuild_started_at)
                self.progress_factory.write("bar_overview 重建完成")

                overview_validation = validate_overview_coverage(
                    await db.get_bar_overview(),
                    written_coverage,
                    issue_limit=max(
                        0,
                        MAX_QUALITY_ISSUES - len(validation_issues),
                    ),
                )
                validation_issue_count += overview_validation.issue_count
                validation_issues.extend(overview_validation.issues)
                failed_vt_symbols.update(overview_validation.affected_vt_symbols)

            finished_at = datetime.now()
            report_name = (
                f"es_gm_daily_update_{finished_at.strftime('%Y-%m-%d_%H%M%S')}"
            )
            summary = {
                "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
                "finished_at": finished_at.strftime("%Y-%m-%d %H:%M:%S"),
                "latest_trade_date": latest_trade_date.strftime("%Y-%m-%d"),
                "planned_symbol_count": len(plans),
                "planned_year_count": len(batches_by_year),
                "planned_batch_count": total_batch_count,
                "fetched_rows": total_fetched_rows,
                "saved_rows": total_saved_rows,
                "failed_batch_count": failed_batch_count,
                "validation_issue_count": validation_issue_count,
                "message": next(
                    (
                        item.message
                        for item in batch_results
                        if item.status == "failed" and item.message
                    ),
                    None,
                ),
            }
            if profile:
                summary["timings"] = profiler.export()
            quality = build_quality_snapshot(
                summary,
                validation_issues,
                validation_issue_count,
                failed_vt_symbols,
            )
            should_persist_report = failed_batch_count > 0 or validation_issue_count > 0
            result: dict[str, object] = dict(summary)
            result["quality"] = quality

            # 仅在失败批次或校验异常存在时保留调试报告，正常完成不额外落盘。
            if should_persist_report:
                json_path, csv_path = write_update_report(
                    report_name,
                    summary,
                    batch_results,
                    validation_issues,
                    validation_issue_count=validation_issue_count,
                )
                result["report_json_path"] = str(json_path)
                result["report_csv_path"] = str(csv_path)

            print(
                f"增量更新完成：抓取 {total_fetched_rows} 条，"
                f"入库 {total_saved_rows} 条，校验异常 {validation_issue_count} 条"
            )
            if profile:
                print(f"阶段耗时：{format_stage_timings(summary['timings'])}")
            if should_persist_report:
                print(f"日志文件：{json_path}")
                print(f"校验明细：{csv_path}")

            return result
        finally:
            await db.close()
