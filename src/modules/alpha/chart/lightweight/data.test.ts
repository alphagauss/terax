/**
 * 本文件测试 Alpha 行情到 Lightweight Charts 的纯转换。
 * 重点锁定交易日、前收盘方向色、尾部更新保护和历史 prepend 计数。
 */

import {
  buildFinancialSeriesData,
  countPrependedBars,
  financialChartTime,
  financialTailUpdateMode,
} from "@/modules/alpha/chart/lightweight/data";
import type { FinancialChartPalette } from "@/modules/alpha/chart/model";
import type { MarketBar } from "@/modules/alpha/market/model";
import { describe, expect, it } from "vitest";

const palette: FinancialChartPalette = {
  text: "#aaa",
  grid: "#222",
  border: "#333",
  crosshair: "#bbb",
  up: "#0f0",
  down: "#f00",
  line: "#00f",
};

function bar(date: string, close: number): MarketBar {
  return {
    time: { kind: "trading-day", date },
    open: 10,
    high: Math.max(11, close),
    low: Math.min(9, close),
    close,
    volume: 100,
    amount: 1_000,
    openInterest: null,
  };
}

describe("financial chart data", () => {
  it("转换交易日和绝对时间", () => {
    expect(
      financialChartTime({ kind: "trading-day", date: "2026-07-30" }),
    ).toEqual({
      year: 2026,
      month: 7,
      day: 30,
    });
    expect(
      financialChartTime({ kind: "instant", epochSeconds: 1785375000 }),
    ).toBe(1785375000);
  });

  it("一次构建价格、收盘线和带方向色的成交量数据", () => {
    const result = buildFinancialSeriesData(
      [bar("2026-07-29", 11), bar("2026-07-30", 10.5)],
      palette,
    );

    expect(result.candles).toHaveLength(2);
    expect(result.candles.map((item) => item.color)).toEqual(["#0f0", "#f00"]);
    expect(result.ohlc.map((item) => item.color)).toEqual(["#0f0", "#f00"]);
    expect(result.line.map((item) => item.value)).toEqual([11, 10.5]);
    expect(result.volume.map((item) => item.color)).toEqual(["#0f0", "#f00"]);
  });

  it("只允许稳定前缀上的尾部替换或追加", () => {
    const initial = [bar("2026-07-28", 10), bar("2026-07-29", 11)];
    expect(financialTailUpdateMode(initial, initial)).toBe("unchanged");
    expect(
      financialTailUpdateMode(initial, [initial[0], bar("2026-07-29", 12)]),
    ).toBe("replace");
    expect(
      financialTailUpdateMode(initial, [...initial, bar("2026-07-30", 13)]),
    ).toBe("append");
    expect(
      financialTailUpdateMode(initial, [bar("2026-07-27", 9), initial[1]]),
    ).toBeNull();
  });

  it("计算历史回填相对旧快照增加的逻辑索引", () => {
    const current = [bar("2026-07-29", 11), bar("2026-07-30", 12)];
    const next = [bar("2026-07-27", 9), bar("2026-07-28", 10), ...current];

    expect(countPrependedBars(current, next)).toBe(2);
    expect(
      countPrependedBars(current, [...current, bar("2026-07-31", 13)]),
    ).toBe(0);
  });
});
