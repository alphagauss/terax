/**
 * 本文件计算多证券共同起点上的相对收益序列。
 * 纯函数只处理时间、收盘价和结构化错误，不填补交易日，也不依赖图表引擎。
 */

import type {
  ChartComparisonPoint,
  ChartComparisonSeries,
} from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { marketTimeKey } from "@/modules/alpha/market/normalize";

export type ChartComparisonSource = {
  vtSymbol: string;
  name: string;
  color: string;
  bars: readonly Pick<MarketBar, "time" | "close">[];
};

export type ChartComparisonNormalizationError = {
  vtSymbol: string;
  kind: "empty" | "zero-base";
};

export type ChartComparisonNormalizationResult = {
  commonStart: ChartComparisonPoint["time"] | null;
  series: ChartComparisonSeries[];
  errors: ChartComparisonNormalizationError[];
};

/** 过滤非法 close，并按时间排序去重，同时间保留最后输入值。 */
function normalizeSource(source: ChartComparisonSource): ChartComparisonSource {
  const byTime = new Map<number, Pick<MarketBar, "time" | "close">>();
  for (const bar of source.bars) {
    if (!Number.isFinite(bar.close)) continue;
    byTime.set(marketTimeKey(bar.time), bar);
  }
  return {
    ...source,
    bars: [...byTime.values()].sort(
      (left, right) => marketTimeKey(left.time) - marketTimeKey(right.time),
    ),
  };
}

/**
 * 把主标的和已成功读取的对比标的归一到共同有效起点。
 *
 * 重复时间保留输入中的最后值；各序列只输出自身真实存在的点，基准为共同起点
 * 当日或之后的第一条有效收盘价。
 */
export function normalizeChartComparisons(
  sources: readonly ChartComparisonSource[],
): ChartComparisonNormalizationResult {
  const normalized = sources.map(normalizeSource);
  const valid = normalized.filter((source) => source.bars.length > 0);
  const errors: ChartComparisonNormalizationError[] = normalized
    .filter((source) => source.bars.length === 0)
    .map((source) => ({ vtSymbol: source.vtSymbol, kind: "empty" }));
  if (valid.length === 0) {
    return { commonStart: null, series: [], errors };
  }

  const commonStartKey = Math.max(
    ...valid.map((source) => marketTimeKey(source.bars[0].time)),
  );
  const commonStartSource = valid.find(
    (source) => marketTimeKey(source.bars[0].time) === commonStartKey,
  );
  const commonStart = commonStartSource?.bars[0].time ?? null;
  const series: ChartComparisonSeries[] = [];

  for (const source of valid) {
    const baselineIndex = source.bars.findIndex(
      (bar) => marketTimeKey(bar.time) >= commonStartKey,
    );
    const base = source.bars[baselineIndex]?.close;
    if (baselineIndex < 0) {
      errors.push({ vtSymbol: source.vtSymbol, kind: "empty" });
      continue;
    }
    if (base === 0) {
      errors.push({ vtSymbol: source.vtSymbol, kind: "zero-base" });
      continue;
    }
    series.push({
      vtSymbol: source.vtSymbol,
      name: source.name,
      color: source.color,
      points: source.bars.slice(baselineIndex).map((bar) => ({
        time: bar.time,
        value: (bar.close / base - 1) * 100,
      })),
    });
  }

  return { commonStart, series, errors };
}

/** 提取每条相对收益线的最后值，供十字线离开后的 legend 使用。 */
export function latestChartComparisonValues(
  series: readonly ChartComparisonSeries[],
): Record<string, number | null> {
  return Object.fromEntries(
    series.map((item) => [
      item.vtSymbol,
      item.points[item.points.length - 1]?.value ?? null,
    ]),
  );
}
