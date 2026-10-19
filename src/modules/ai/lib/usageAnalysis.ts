/** 从已有模型调用事实派生缓存复用诊断，不参与请求执行或持久化。 */

import type { UsageRecord } from "@/modules/ai/lib/usage";

const BASELINE_WINDOW = 5;
const MIN_BASELINE_COVERAGE = 0.6;
const MAX_EXPECTED_RATIO = 0.6;
const MAX_PREVIOUS_CACHE_RATIO = 0.8;
const MIN_DEFICIT_TOKENS = 1024;

export type CacheComparison = {
  previousCallId: string;
  currentCallId: string;
  turnId: string;
  taskId?: string;
  runId?: string;
  previousInputTokens: number;
  currentInputTokens: number;
  cacheReadTokens: number;
  requestHitRate: number;
  prefixReuseCoverage: number;
  baselineCoverage?: number;
  expectedTokens?: number;
};

export type CacheIncident = CacheComparison & {
  baselineCoverage: number;
  expectedTokens: number;
};

export type CacheAnalysis = {
  status:
    | "unavailable"
    | "insufficient"
    | "healthy"
    | "suspected"
    | "recovered"
    | "historical";
  latest?: CacheComparison;
  incidents: CacheIncident[];
};

/**
 * 诊断一个独立会话的缓存复用是否相对近期健康基线明显下降。
 * 当前缓存读取与上次总输入比较，避免本次新增的大型工具结果拉低命中率时误报。
 */
export function analyzeCacheUsage(
  records: readonly UsageRecord[],
  taskId?: string,
): CacheAnalysis {
  let previous: UsageRecord | undefined;
  let latest: CacheComparison | undefined;
  let cacheReported = false;
  let baselineSamples: number[] = [];
  const incidents: CacheIncident[] = [];

  const reset = () => {
    previous = undefined;
    latest = undefined;
    baselineSamples = [];
  };

  for (const current of records) {
    if (current.taskId !== taskId) continue;
    if (current.purpose === "compaction") {
      reset();
      continue;
    }
    if (current.purpose) continue;
    if (current.values.cacheReadTokens != null) cacheReported = true;

    if (!previous) {
      previous = current;
      continue;
    }
    if (!isComparable(previous, current)) {
      reset();
      previous = current;
      continue;
    }

    const cached = current.values.cacheReadTokens;
    if (
      cached == null ||
      previous.estimated.includes("inputTokens") ||
      current.estimated.includes("inputTokens") ||
      cached > current.values.inputTokens
    ) {
      previous = current;
      continue;
    }

    const coverage = Math.min(cached / previous.values.inputTokens, 1);
    const baseline = median(baselineSamples);
    const expected =
      baseline == null ? undefined : baseline * previous.values.inputTokens;
    latest = {
      previousCallId: previous.callId,
      currentCallId: current.callId,
      turnId: current.turnId,
      ...(current.taskId ? { taskId: current.taskId } : {}),
      ...(current.runId ? { runId: current.runId } : {}),
      previousInputTokens: previous.values.inputTokens,
      currentInputTokens: current.values.inputTokens,
      cacheReadTokens: cached,
      requestHitRate:
        current.values.inputTokens > 0
          ? cached / current.values.inputTokens
          : 0,
      prefixReuseCoverage: coverage,
      baselineCoverage: baseline,
      expectedTokens: expected,
    };

    const previousCached = previous.values.cacheReadTokens;
    const droppedFromPrevious =
      previousCached != null &&
      previousCached <= previous.values.inputTokens &&
      cached < previousCached * MAX_PREVIOUS_CACHE_RATIO &&
      previousCached - cached >= MIN_DEFICIT_TOKENS;
    const missedExpectedPrefix =
      baseline != null &&
      expected != null &&
      cached < expected * MAX_EXPECTED_RATIO &&
      expected - cached >=
        Math.max(MIN_DEFICIT_TOKENS, expected * (1 - MAX_EXPECTED_RATIO));
    if (droppedFromPrevious || missedExpectedPrefix) {
      const incidentExpected = Math.max(expected ?? 0, previousCached ?? 0);
      incidents.push({
        ...latest,
        baselineCoverage: incidentExpected / previous.values.inputTokens,
        expectedTokens: incidentExpected,
      });
    } else if (coverage >= MIN_BASELINE_COVERAGE) {
      baselineSamples = [...baselineSamples, coverage].slice(-BASELINE_WINDOW);
    }
    previous = current;
  }

  return {
    status: latest
      ? incidents[incidents.length - 1]?.currentCallId === latest.currentCallId
        ? "suspected"
        : incidents.length
          ? "recovered"
          : baselineSamples.length
            ? "healthy"
            : "insufficient"
      : cacheReported
        ? incidents.length
          ? "historical"
          : "insufficient"
        : "unavailable",
    latest,
    incidents,
  };
}

function isComparable(previous: UsageRecord, current: UsageRecord): boolean {
  if (
    previous.model.providerId !== current.model.providerId ||
    previous.model.modelId !== current.model.modelId ||
    previous.values.inputTokens <= 0 ||
    current.values.inputTokens < previous.values.inputTokens
  )
    return false;
  if (
    previous.context?.overheadHash &&
    current.context?.overheadHash &&
    previous.context.overheadHash !== current.context.overheadHash
  )
    return false;
  return !(
    previous.context &&
    current.context &&
    current.context.messageCount < previous.context.messageCount
  );
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 主子会话各自比较；子任务续跑延续其历史基线，其他任务和父会话压缩不会干扰。 */
export function analyzeSessionCacheUsage(
  records: readonly UsageRecord[],
): CacheAnalysis[] {
  const groups = new Map<string | undefined, UsageRecord[]>();
  for (const record of records) {
    const group = groups.get(record.taskId) ?? [];
    group.push(record);
    groups.set(record.taskId, group);
  }
  return [...groups].map(([taskId, calls]) => analyzeCacheUsage(calls, taskId));
}

/** 仅比较同供应商的跨轮主请求；切换供应商的缓存标记差异不视为指令变化。 */
export function changedPromptTurns(
  records: readonly UsageRecord[],
): Set<string> {
  const changed = new Set<string>();
  const seen = new Set<string>();
  let previous: UsageRecord | undefined;
  for (const current of records) {
    if (current.taskId || current.purpose) continue;
    if (!seen.has(current.turnId)) {
      if (
        previous?.context?.overheadHash &&
        previous.model.providerId === current.model.providerId &&
        current.context?.overheadHash &&
        previous.context.overheadHash !== current.context.overheadHash
      )
        changed.add(current.turnId);
      seen.add(current.turnId);
    }
    previous = current;
  }
  return changed;
}
