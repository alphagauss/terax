/**
 * 本文件把 Terax 行情模型转换为 Lightweight Charts series 数据。
 * 同时统一按前收盘价着色，并提供尾部更新保护判断，避免非法增量更新。
 */

import type { FinancialChartPalette } from "@/modules/alpha/chart/model";
import type { MarketBar, MarketTime } from "@/modules/alpha/market/model";
import {
  marketTimeKey,
  marketTradingDayParts,
} from "@/modules/alpha/market/normalize";
import type {
  BarData,
  CandlestickData,
  HistogramData,
  LineData,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

export type FinancialSeriesData = {
  candles: CandlestickData<Time>[];
  ohlc: BarData<Time>[];
  line: LineData<Time>[];
  volume: HistogramData<Time>[];
};

export type TailUpdateMode = "unchanged" | "replace" | "append" | null;

/** 把公共行情时间转换为 Lightweight Charts 横轴时间。 */
export function financialChartTime(time: MarketTime): Time {
  if (time.kind === "instant") {
    return time.epochSeconds as UTCTimestamp;
  }
  return marketTradingDayParts(time);
}

/** 构建价格和成交量 series 的完整快照。 */
export function buildFinancialSeriesData(
  bars: readonly MarketBar[],
  palette: FinancialChartPalette,
  initialPreviousClose: number | null = null,
): FinancialSeriesData {
  const candles: CandlestickData<Time>[] = [];
  const ohlc: BarData<Time>[] = [];
  const line: LineData<Time>[] = [];
  const volume: HistogramData<Time>[] = [];

  let previousClose = initialPreviousClose;
  for (const bar of bars) {
    const time = financialChartTime(bar.time);
    const color =
      bar.close >= (previousClose ?? bar.open) ? palette.up : palette.down;
    const price = {
      time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    };
    candles.push({
      ...price,
      color,
      borderColor: color,
      wickColor: color,
    });
    ohlc.push({ ...price, color });
    line.push({ time, value: bar.close });
    volume.push({
      time,
      value: bar.volume ?? 0,
      color,
    });
    previousClose = bar.close;
  }

  return { candles, ohlc, line, volume };
}

function sameBar(left: MarketBar, right: MarketBar): boolean {
  return (
    marketTimeKey(left.time) === marketTimeKey(right.time) &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume &&
    left.amount === right.amount &&
    left.openInterest === right.openInterest
  );
}

/**
 * 判断下一组数据能否只更新尾部。
 *
 * 只有稳定前缀完全一致时才允许 `update()`，避免回退时间戳或历史修订破坏 series。
 */
export function financialTailUpdateMode(
  previous: readonly MarketBar[],
  next: readonly MarketBar[],
): TailUpdateMode {
  if (previous.length === 0 || next.length === 0) return null;

  if (previous.length === next.length) {
    const lastIndex = next.length - 1;
    for (let index = 0; index < lastIndex; index += 1) {
      if (!sameBar(previous[index], next[index])) return null;
    }
    if (
      marketTimeKey(previous[lastIndex].time) !==
      marketTimeKey(next[lastIndex].time)
    ) {
      return null;
    }
    return sameBar(previous[lastIndex], next[lastIndex])
      ? "unchanged"
      : "replace";
  }

  if (next.length === previous.length + 1) {
    for (let index = 0; index < previous.length; index += 1) {
      if (!sameBar(previous[index], next[index])) return null;
    }
    if (
      marketTimeKey(next[next.length - 1].time) <=
      marketTimeKey(previous[previous.length - 1].time)
    ) {
      return null;
    }
    return "append";
  }

  return null;
}

/** 返回完整历史快照相对旧快照新增的前置 K 线数量。 */
export function countPrependedBars(
  previous: readonly MarketBar[],
  next: readonly MarketBar[],
): number {
  if (previous.length === 0 || next.length <= previous.length) return 0;

  const firstKey = marketTimeKey(previous[0].time);
  const offset = next.findIndex((bar) => marketTimeKey(bar.time) === firstKey);
  if (offset <= 0 || offset + previous.length > next.length) return 0;

  for (let index = 0; index < previous.length; index += 1) {
    if (
      marketTimeKey(previous[index].time) !==
      marketTimeKey(next[offset + index].time)
    ) {
      return 0;
    }
  }
  return offset;
}
