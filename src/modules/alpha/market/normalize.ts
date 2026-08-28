/**
 * 本文件统一归一化和合并 Alpha 行情数据。
 * 日线使用无时区交易日，盘中数据只接受带明确偏移的绝对时间，避免 WebView 本地时区改变行情语义。
 */

import type {
  MarketBar,
  MarketBarInput,
  MarketInterval,
  MarketTime,
} from "@/modules/alpha/market/model";

const TRADING_DAY_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:(?:T| )(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/i;
const OFFSET_DATETIME_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** 把 API 时间转换为交易日或绝对时刻。 */
export function normalizeMarketTime(
  value: string,
  interval: MarketInterval,
): MarketTime {
  if (interval === "d" || interval === "w") {
    const match = TRADING_DAY_PATTERN.exec(value);
    if (!match) {
      throw new Error(`行情交易日格式非法: ${value}`);
    }
    const [, date, hour, minute, second, offsetHour, offsetMinute] = match;
    const [year, month, day] = date.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new Error(`行情交易日不存在: ${value}`);
    }
    if (
      (hour !== undefined && Number(hour) > 23) ||
      (minute !== undefined && Number(minute) > 59) ||
      (second !== undefined && Number(second) > 59) ||
      (offsetHour !== undefined && Number(offsetHour) > 23) ||
      (offsetMinute !== undefined && Number(offsetMinute) > 59)
    ) {
      throw new Error(`行情交易日时间格式非法: ${value}`);
    }
    return { kind: "trading-day", date };
  }

  if (!OFFSET_DATETIME_PATTERN.test(value)) {
    throw new Error(`盘中行情时间缺少明确时区: ${value}`);
  }
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    throw new Error(`盘中行情时间格式非法: ${value}`);
  }
  return { kind: "instant", epochSeconds: epochMilliseconds / 1000 };
}

/** 返回可用于排序和同时间去重的稳定时间键。 */
export function marketTimeKey(time: MarketTime): number {
  if (time.kind === "instant") return time.epochSeconds;
  return Number(time.date.replace(/-/g, ""));
}

/** 提取图表 BusinessDay 可直接消费的交易日字段。 */
export function marketTradingDayParts(time: MarketTime): {
  year: number;
  month: number;
  day: number;
} {
  if (time.kind !== "trading-day") {
    throw new Error("盘中行情不能转换为交易日");
  }
  const [year, month, day] = time.date.split("-").map(Number);
  return { year, month, day };
}

function validateBar(input: MarketBarInput): void {
  const prices = [input.open, input.high, input.low, input.close];
  if (!prices.every(Number.isFinite)) {
    throw new Error(`行情价格包含非有限值: ${input.time}`);
  }
  if (
    input.high < Math.max(input.open, input.low, input.close) ||
    input.low > Math.min(input.open, input.high, input.close)
  ) {
    throw new Error(`行情 OHLC 关系非法: ${input.time}`);
  }
  for (const value of [input.volume, input.amount, input.openInterest]) {
    if (value !== null && !Number.isFinite(value)) {
      throw new Error(`行情扩展字段包含非有限值: ${input.time}`);
    }
  }
  if (input.volume !== null && input.volume < 0) {
    throw new Error(`行情成交量不能为负数: ${input.time}`);
  }
  if (input.amount !== null && input.amount < 0) {
    throw new Error(`行情成交额不能为负数: ${input.time}`);
  }
  if (input.openInterest !== null && input.openInterest < 0) {
    throw new Error(`行情持仓量不能为负数: ${input.time}`);
  }
}

/**
 * 归一化一组按时间升序的 API K 线。
 *
 * 相同时间保留最后一条，时间倒退和非法 OHLC 直接拒绝，避免错误数据进入图表状态。
 */
export function normalizeMarketBars(
  inputs: MarketBarInput[],
  interval: MarketInterval,
): MarketBar[] {
  const result: MarketBar[] = [];
  let previousKey: number | null = null;

  for (const input of inputs) {
    validateBar(input);
    const time = normalizeMarketTime(input.time, interval);
    const key = marketTimeKey(time);
    if (previousKey !== null && key < previousKey) {
      throw new Error(`行情时间不是升序: ${input.time}`);
    }
    const bar: MarketBar = {
      time,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume,
      amount: input.amount,
      openInterest: input.openInterest,
    };
    if (previousKey === key) {
      result[result.length - 1] = bar;
    } else {
      result.push(bar);
    }
    previousKey = key;
  }

  return result;
}

/** 合并更早页面与当前页面，并在游标边界再次去重和校验顺序。 */
export function mergeMarketBarPages(
  older: readonly MarketBar[],
  current: readonly MarketBar[],
): MarketBar[] {
  const result: MarketBar[] = [];
  for (const page of [older, current]) {
    for (const bar of page) {
      const key = marketTimeKey(bar.time);
      const previous = result[result.length - 1];
      if (previous) {
        if (previous.time.kind !== bar.time.kind) {
          throw new Error("跨页行情时间类型不一致");
        }
        const previousKey = marketTimeKey(previous.time);
        if (key < previousKey) throw new Error("跨页行情时间不是升序");
        if (key === previousKey) {
          result[result.length - 1] = bar;
          continue;
        }
      }
      result.push(bar);
    }
  }
  return result;
}

/**
 * 把可能与 HTTP 快照重叠的实时尾部覆盖到稳定行情。
 *
 * 两侧各自仍须为同种时间语义，重复时间以实时尾部为准；该函数不用于历史分页。
 */
export function mergeMarketBarTail(
  stable: readonly MarketBar[],
  liveTail: readonly MarketBar[],
): MarketBar[] {
  const timeKinds = new Set(
    [...stable, ...liveTail].map((bar) => bar.time.kind),
  );
  if (timeKinds.size > 1) throw new Error("实时尾部时间类型不一致");
  const byTime = new Map<number, MarketBar>();
  for (const bar of stable) byTime.set(marketTimeKey(bar.time), bar);
  for (const bar of liveTail) byTime.set(marketTimeKey(bar.time), bar);
  return [...byTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bar]) => bar);
}
