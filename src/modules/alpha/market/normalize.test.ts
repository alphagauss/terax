/**
 * 本文件测试 Alpha 行情归一化、跨页合并和重叠实时尾部覆盖。
 * 锁定交易日时区、绝对时间、OHLC 校验、升序约束、游标边界和快照恢复。
 */

import {
  marketTradingDayParts,
  mergeMarketBarPages,
  mergeMarketBarTail,
  normalizeMarketBars,
  normalizeMarketTime,
} from "@/modules/alpha/market/normalize";
import { describe, expect, it } from "vitest";

const bar = (time: string, close = 10) => ({
  time,
  open: 10,
  high: Math.max(11, close),
  low: Math.min(9, close),
  close,
  volume: 100,
  amount: 1000,
  openInterest: null,
});

describe("Alpha market normalization", () => {
  it("keeps daily bars independent from the local timezone", () => {
    const time = normalizeMarketTime("2026-07-30T00:00:00+08:00", "d");
    expect(time).toEqual({ kind: "trading-day", date: "2026-07-30" });
    expect(marketTradingDayParts(time)).toEqual({
      year: 2026,
      month: 7,
      day: 30,
    });
  });

  it("requires an explicit timezone for intraday bars", () => {
    expect(normalizeMarketTime("2026-07-30T09:30:00+08:00", "1m")).toEqual({
      kind: "instant",
      epochSeconds: 1785375000,
    });
    expect(() => normalizeMarketTime("2026-07-30 09:30:00", "1m")).toThrow(
      "缺少明确时区",
    );
    expect(() => normalizeMarketTime("2026-07-30-invalid", "d")).toThrow(
      "格式非法",
    );
    expect(() => normalizeMarketTime("2026-07-30Tinvalid", "d")).toThrow(
      "格式非法",
    );
    expect(() => normalizeMarketTime("2026-07-30T25:00:00", "d")).toThrow(
      "时间格式非法",
    );
    expect(() => normalizeMarketTime("2026-07-30T09:30:00+99:99", "d")).toThrow(
      "时间格式非法",
    );
  });

  it("deduplicates equal times while rejecting invalid order and OHLC", () => {
    const normalized = normalizeMarketBars(
      [bar("2026-07-29"), bar("2026-07-29", 10.5), bar("2026-07-30")],
      "d",
    );
    expect(normalized).toHaveLength(2);
    expect(normalized[0].close).toBe(10.5);
    expect(() =>
      normalizeMarketBars([bar("2026-07-30"), bar("2026-07-29")], "d"),
    ).toThrow("不是升序");
    expect(() =>
      normalizeMarketBars([{ ...bar("2026-07-30"), high: 9.5 }], "d"),
    ).toThrow("OHLC");
  });

  it("merges adjacent pages without duplicating the cursor boundary", () => {
    const older = normalizeMarketBars(
      [bar("2026-07-28"), bar("2026-07-29")],
      "d",
    );
    const current = normalizeMarketBars(
      [bar("2026-07-29", 10.5), bar("2026-07-30")],
      "d",
    );
    const merged = mergeMarketBarPages(older, current);
    expect(merged).toHaveLength(3);
    expect(merged[1].close).toBe(10.5);
  });

  it("allows an HTTP snapshot to overlap and replace the current live tail", () => {
    const stable = normalizeMarketBars(
      [bar("2026-05-15"), bar("2026-08-27", 11.59), bar("2026-08-28", 11.65)],
      "d",
    );
    const liveTail = normalizeMarketBars(
      [bar("2026-05-15"), bar("2026-08-27", 11.6), bar("2026-08-28", 11.66)],
      "d",
    );

    const merged = mergeMarketBarTail(stable, liveTail);

    expect(merged.map((item) => item.time)).toEqual([
      { kind: "trading-day", date: "2026-05-15" },
      { kind: "trading-day", date: "2026-08-27" },
      { kind: "trading-day", date: "2026-08-28" },
    ]);
    expect(merged[2].close).toBe(11.66);
  });
});
