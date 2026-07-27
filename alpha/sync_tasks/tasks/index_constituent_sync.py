from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime
from time import perf_counter
from typing import Callable

from tqdm import tqdm

from alpha.common.schema_market import IndexConstituentQuery
from alpha.storage.database import DataBase
from alpha.sync_tasks.base import BaseSyncProvider
from alpha.sync_tasks.calendar import get_latest_target_trade_date
from alpha.sync_tasks.models import IndexConstituentSyncPlan, SecurityInfo, StageProfiler
from alpha.sync_tasks.normalizers import normalize_index_constituent_vt_symbols
from alpha.sync_tasks.planners import build_index_constituent_sync_plans
from alpha.sync_tasks.reporting import format_stage_timings
from alpha.sync_tasks.universe import load_symbol_universe_from_csv, load_trade_dates_from_csv
from alpha.sync_tasks.writers import load_index_constituent_meta_map
from alpha.common.paths import load_json, save_json

INDEX_CONSTITUENT_CACHE_FILE = "index_constituent_probe_cache.json"
INDEX_CONSTITUENT_CACHE_FOLDER = "sync_tasks"


@dataclass(slots=True)
class IndexConstituentFetchResult:
    """单次指数成分股抓取结果。"""

    trade_date: date
    vt_symbols: list[str] | None
    is_empty: bool
    error: Exception | None


@dataclass(slots=True)
class IndexConstituentProbeCacheEntry:
    """指数成分股探测跳过缓存。"""

    index_code: str
    latest_empty_trade_date: date
    skip_until_trade_date: date
    updated_at: str


class IndexConstituentSyncTask:
    """指数成分股同步任务。"""

    def __init__(
        self,
        provider: BaseSyncProvider,
        *,
        db_factory: Callable[[], DataBase] = DataBase,
        trade_dates_loader: Callable[[], list[date]] = load_trade_dates_from_csv,
        universe_loader: Callable[[], list[SecurityInfo]] = load_symbol_universe_from_csv,
        progress_factory=tqdm,
        max_fetch_concurrency: int = 2, # 每1000条请求会限制5分钟的样子， 多并发没有意义
        empty_latest_skip_trade_days: int = 30,
        probe_cache_loader: Callable[[], dict] | None = None,
        probe_cache_saver: Callable[[dict], None] | None = None,
    ) -> None:
        self.provider = provider
        self.db_factory = db_factory
        self.trade_dates_loader = trade_dates_loader
        self.universe_loader = universe_loader
        self.progress_factory = progress_factory
        self.max_fetch_concurrency = max_fetch_concurrency
        self.empty_latest_skip_trade_days = empty_latest_skip_trade_days
        self.probe_cache_loader = probe_cache_loader or self._load_probe_cache
        self.probe_cache_saver = probe_cache_saver or self._save_probe_cache

    async def run(self, target_trade_date: date | None = None, profile: bool = False) -> dict[str, object]:
        """执行指数成分股同步主流程。

        Args:
            target_trade_date: 目标截止交易日；若为空，则自动推导最近目标交易日。
            profile: 是否记录阶段耗时。

        Returns:
            同步执行结果统计。
        """
        started_at = datetime.now()
        trade_dates = self.trade_dates_loader()
        latest_trade_date = target_trade_date or get_latest_target_trade_date(trade_dates, started_at)
        indices = [item for item in self.universe_loader() if item.asset_type == "index"]
        db = self.db_factory()
        try:
            profiler = StageProfiler(enabled=profile)
            meta_map = await load_index_constituent_meta_map(db, indices)
            plans = build_index_constituent_sync_plans(
                indices=indices,
                meta_map=meta_map,
                trade_dates=trade_dates,
                latest_trade_date=latest_trade_date,
            )
            probe_cache_map = self._normalize_probe_cache(self.probe_cache_loader())

            total_processed_trade_dates = 0
            total_saved_trade_dates = 0
            total_failed_requests = 0
            skipped_by_probe_cache_count = 0
            if self.max_fetch_concurrency <= 0:
                raise ValueError("max_fetch_concurrency 必须大于 0")
            if self.empty_latest_skip_trade_days <= 0:
                raise ValueError("empty_latest_skip_trade_days 必须大于 0")

            active_plans: list[IndexConstituentSyncPlan] = []
            skipped_plan_map: dict[str, IndexConstituentProbeCacheEntry] = {}
            for plan in plans:
                cache_entry = probe_cache_map.get(plan.security.vt_symbol)
                if cache_entry is not None and latest_trade_date <= cache_entry.skip_until_trade_date:
                    skipped_plan_map[plan.security.vt_symbol] = cache_entry
                    continue
                active_plans.append(plan)

            total_trade_date_candidates = sum(
                1
                for plan in active_plans
                for trade_date in trade_dates
                if plan.start_date <= trade_date <= plan.end_date
            )

            semaphore = asyncio.Semaphore(self.max_fetch_concurrency)
            trade_date_pbar = self.progress_factory(
                total=total_trade_date_candidates,
                desc="交易日探测",
                unit="trade_date",
                dynamic_ncols=True,
                position=0,
            )
            index_pbar = self.progress_factory(
                total=len(plans),
                desc="指数进度",
                unit="index",
                dynamic_ncols=True,
                position=1,
            )

            try:
                index_tasks = [
                    asyncio.create_task(
                        self._sync_single_index_plan(
                            plan=plan,
                            trade_dates=trade_dates,
                            db=db,
                            semaphore=semaphore,
                            profiler=profiler,
                            trade_date_progress=trade_date_pbar,
                        )
                    )
                    for plan in active_plans
                ]

                for plan in plans:
                    cache_entry = skipped_plan_map.get(plan.security.vt_symbol)
                    if cache_entry is None:
                        continue
                    skipped_by_probe_cache_count += 1
                    index_pbar.set_postfix_str(
                        f"{plan.security.gm_symbol} | 跳过至 {cache_entry.skip_until_trade_date.isoformat()} | 成功 {total_saved_trade_dates} | 失败 {total_failed_requests}"
                    )
                    index_pbar.update(1)

                for future in asyncio.as_completed(index_tasks):
                    index_result = await future
                    total_processed_trade_dates += int(index_result["processed_trade_date_count"])
                    total_saved_trade_dates += int(index_result["saved_trade_date_count"])
                    total_failed_requests += int(index_result["failed_request_count"])
                    plan = index_result["plan"]
                    last_trade_date = index_result["last_trade_date"]
                    last_vt_symbol_count = index_result["last_vt_symbol_count"]
                    if index_result["latest_trade_date_was_empty"]:
                        cache_entry = self._build_probe_cache_entry(
                            index_code=plan.security.vt_symbol,
                            latest_trade_date=plan.end_date,
                            trade_dates=trade_dates,
                            current_time=datetime.now(),
                        )
                        probe_cache_map[plan.security.vt_symbol] = cache_entry
                    elif index_result["saved_trade_date_count"] > 0:
                        probe_cache_map.pop(plan.security.vt_symbol, None)
                    self._persist_probe_cache(probe_cache_map)

                    if index_result["failed_request_count"] > 0:
                        index_pbar.set_postfix_str(
                            f"{plan.security.gm_symbol} | {last_trade_date or '-'} | 成功 {total_saved_trade_dates} | 失败 {total_failed_requests}"
                        )
                    elif index_result["saved_trade_date_count"] > 0:
                        index_pbar.set_postfix_str(
                            f"{plan.security.gm_symbol} | {index_result['index_trade_date_progress']} | 最近 {last_trade_date} | 成分股 {last_vt_symbol_count}"
                        )
                    else:
                        cache_entry = probe_cache_map.get(plan.security.vt_symbol)
                        if cache_entry is not None:
                            index_pbar.set_postfix_str(
                                f"{plan.security.gm_symbol} | 最近日无数据 | 跳过至 {cache_entry.skip_until_trade_date.isoformat()}"
                            )
                        else:
                            index_pbar.set_postfix_str(
                                f"{plan.security.gm_symbol} | 最近日无数据 | 成功 {total_saved_trade_dates} | 失败 {total_failed_requests}"
                            )
                    index_pbar.update(1)
            finally:
                self._persist_probe_cache(probe_cache_map)
                trade_date_pbar.close()
                index_pbar.close()

            finished_at = datetime.now()
            result = {
                "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
                "finished_at": finished_at.strftime("%Y-%m-%d %H:%M:%S"),
                "latest_trade_date": latest_trade_date.strftime("%Y-%m-%d"),
                "planned_index_count": len(plans),
                "skipped_by_probe_cache_count": skipped_by_probe_cache_count,
                "processed_trade_date_count": total_processed_trade_dates,
                "saved_trade_date_count": total_saved_trade_dates,
                "failed_request_count": total_failed_requests,
            }
            if profile:
                result["timings"] = profiler.export()
            print(
                f"指数成分股同步完成：指数 {result['planned_index_count']} 个，"
                f"缓存跳过 {result['skipped_by_probe_cache_count']} 个，"
                f"处理交易日 {result['processed_trade_date_count']} 个，"
                f"成功 {result['saved_trade_date_count']} 次，失败 {result['failed_request_count']} 次"
            )
            if profile:
                print(f"阶段耗时：{format_stage_timings(result['timings'])}")
            return result
        finally:
            await db.close()

    async def _sync_single_index_plan(
        self,
        *,
        plan: IndexConstituentSyncPlan,
        trade_dates: list[date],
        db: DataBase,
        semaphore: asyncio.Semaphore,
        profiler: StageProfiler,
        trade_date_progress,
    ) -> dict[str, object]:
        """同步单个指数的成分股时间线。

        策略说明：
        - 单指数内部按交易日倒序探测；
        - 最近交易日为空则直接跳过该指数；
        - 一旦已命中过有效数据，再遇到空结果即停止继续向前探测；
        - 最终按交易日正序写库，避免输出顺序与时间线语义相反。

        Args:
            plan: 单指数同步计划。
            trade_dates: 全量交易日列表。
            db: 数据库实例。
            semaphore: 指数级并发控制信号量。
            profiler: 阶段耗时统计器。
            trade_date_progress: 全局交易日探测进度条。

        Returns:
            单指数执行统计。
        """
        scoped_trade_dates = [
            trade_date
            for trade_date in trade_dates
            if plan.start_date <= trade_date <= plan.end_date
        ]
        descending_trade_dates = list(reversed(scoped_trade_dates))
        collected_vt_symbol_payloads: list[tuple[date, list[str]]] = []
        processed_trade_date_count = 0
        saved_trade_date_count = 0
        failed_request_count = 0
        last_trade_date: date | None = None
        last_vt_symbol_count = 0
        latest_trade_date_was_empty = False
        total_index_trade_dates = len(descending_trade_dates)

        async with semaphore:
            has_found_data = False
            for trade_date in descending_trade_dates:
                fetch_result = await self._fetch_constituent_payload(
                    plan=plan,
                    trade_date=trade_date,
                    profiler=profiler,
                )
                processed_trade_date_count += 1
                last_trade_date = trade_date
                trade_date_progress.set_postfix_str(
                    f"{plan.security.gm_symbol} | {processed_trade_date_count}/{total_index_trade_dates} | {trade_date.isoformat()}"
                )
                trade_date_progress.update(1)

                if fetch_result.error is not None:
                    failed_request_count += 1
                    self.progress_factory.write(f"[指数成分股失败] {plan.security.gm_symbol} {trade_date}，错误：{fetch_result.error}")
                    break

                if fetch_result.is_empty:
                    if processed_trade_date_count == 1:
                        latest_trade_date_was_empty = True
                    break

                has_found_data = True
                vt_symbols = fetch_result.vt_symbols or []
                last_vt_symbol_count = len(vt_symbols)
                collected_vt_symbol_payloads.append((trade_date, vt_symbols))

            if not has_found_data and latest_trade_date_was_empty:
                self.progress_factory.write(
                    f"[指数成分股跳过] {plan.security.gm_symbol} {plan.end_date} 无数据，进入短期跳过窗口"
                )

        for trade_date, vt_symbols in sorted(collected_vt_symbol_payloads, key=lambda item: item[0]):
            query = IndexConstituentQuery(index_code=plan.security.vt_symbol, trade_date=trade_date)
            previous_vt_symbols = await db.load_index_constituents(query)
            try:
                save_started_at = perf_counter()
                if not await db.save_index_constituents(
                    index_code=plan.security.vt_symbol,
                    trade_date=trade_date,
                    vt_symbols=vt_symbols,
                ):
                    raise RuntimeError("保存指数成分股失败")
                profiler.add("index_constituent_save", save_started_at)

                saved_vt_symbols = await db.load_index_constituents(query)
                if saved_vt_symbols != vt_symbols:
                    raise RuntimeError("写入后校验失败")
            except Exception as exc:
                failed_request_count += 1
                self.progress_factory.write(f"[指数成分股失败] {plan.security.gm_symbol} {trade_date}，错误：{exc}")
                break

            saved_trade_date_count += 1
            self.progress_factory.write(
                f"[指数成分股写入] {plan.security.gm_symbol} {trade_date} | 成分股 {len(vt_symbols)} | 旧值 {len(previous_vt_symbols)}"
            )

        return {
            "plan": plan,
            "processed_trade_date_count": processed_trade_date_count,
            "saved_trade_date_count": saved_trade_date_count,
            "failed_request_count": failed_request_count,
            "last_trade_date": last_trade_date,
            "last_vt_symbol_count": last_vt_symbol_count,
            "latest_trade_date_was_empty": latest_trade_date_was_empty,
            "index_trade_date_progress": f"{processed_trade_date_count}/{total_index_trade_dates}",
        }

    async def _fetch_constituent_payload(
        self,
        *,
        plan: IndexConstituentSyncPlan,
        trade_date: date,
        profiler: StageProfiler,
    ) -> IndexConstituentFetchResult:
        """拉取并标准化单个指数交易日成分股结果。

        Args:
            plan: 单指数同步计划。
            trade_date: 目标交易日。
            profiler: 阶段耗时统计器。

        Returns:
            抓取结果。空结果视为业务信号，不计为异常。
        """
        try:
            fetch_started_at = perf_counter()
            df = await self.provider.fetch_index_constituents(plan.security.gm_symbol, trade_date)
            profiler.add("index_constituent_fetch", fetch_started_at)

            if df.empty:
                return IndexConstituentFetchResult(
                    trade_date=trade_date,
                    vt_symbols=None,
                    is_empty=True,
                    error=None,
                )

            normalize_started_at = perf_counter()
            vt_symbols = normalize_index_constituent_vt_symbols(df)
            profiler.add("index_constituent_normalize", normalize_started_at)
            return IndexConstituentFetchResult(
                trade_date=trade_date,
                vt_symbols=vt_symbols,
                is_empty=False,
                error=None,
            )
        except Exception as exc:
            return IndexConstituentFetchResult(
                trade_date=trade_date,
                vt_symbols=None,
                is_empty=False,
                error=exc,
            )

    def _build_probe_cache_entry(
        self,
        *,
        index_code: str,
        latest_trade_date: date,
        trade_dates: list[date],
        current_time: datetime,
    ) -> IndexConstituentProbeCacheEntry:
        """根据最近空结果构造短期跳过缓存。"""
        try:
            current_index = trade_dates.index(latest_trade_date)
        except ValueError as exc:
            raise ValueError(f"trade_dates 中不存在交易日 {latest_trade_date}") from exc

        target_index = min(current_index + self.empty_latest_skip_trade_days - 1, len(trade_dates) - 1)
        return IndexConstituentProbeCacheEntry(
            index_code=index_code,
            latest_empty_trade_date=latest_trade_date,
            skip_until_trade_date=trade_dates[target_index],
            updated_at=current_time.strftime("%Y-%m-%d %H:%M:%S"),
        )

    def _normalize_probe_cache(self, raw_cache: dict) -> dict[str, IndexConstituentProbeCacheEntry]:
        """将原始 JSON 缓存解析为内部结构。"""
        normalized: dict[str, IndexConstituentProbeCacheEntry] = {}
        for index_code, payload in raw_cache.items():
            if not isinstance(payload, dict):
                continue
            latest_empty_trade_date_text = payload.get("latest_empty_trade_date")
            skip_until_trade_date_text = payload.get("skip_until_trade_date")
            updated_at = str(payload.get("updated_at") or "")
            if not isinstance(latest_empty_trade_date_text, str) or not isinstance(skip_until_trade_date_text, str):
                continue
            try:
                normalized[index_code] = IndexConstituentProbeCacheEntry(
                    index_code=index_code,
                    latest_empty_trade_date=date.fromisoformat(latest_empty_trade_date_text),
                    skip_until_trade_date=date.fromisoformat(skip_until_trade_date_text),
                    updated_at=updated_at,
                )
            except ValueError:
                continue
        return normalized

    def _serialize_probe_cache(self, cache_map: dict[str, IndexConstituentProbeCacheEntry]) -> dict[str, dict[str, str]]:
        """将内部缓存结构序列化为 JSON 可写格式。"""
        return {
            index_code: {
                "latest_empty_trade_date": entry.latest_empty_trade_date.isoformat(),
                "skip_until_trade_date": entry.skip_until_trade_date.isoformat(),
                "updated_at": entry.updated_at,
            }
            for index_code, entry in sorted(cache_map.items())
        }

    def _load_probe_cache(self) -> dict:
        """加载指数成分股探测缓存。"""
        return load_json(INDEX_CONSTITUENT_CACHE_FILE, INDEX_CONSTITUENT_CACHE_FOLDER)

    def _save_probe_cache(self, payload: dict) -> None:
        """保存指数成分股探测缓存。"""
        save_json(INDEX_CONSTITUENT_CACHE_FILE, payload, INDEX_CONSTITUENT_CACHE_FOLDER)

    def _persist_probe_cache(self, cache_map: dict[str, IndexConstituentProbeCacheEntry]) -> None:
        """将当前缓存状态立刻落盘。"""
        self.probe_cache_saver(self._serialize_probe_cache(cache_map))
