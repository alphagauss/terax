/**
 * 本文件测试对比标的相对收益归一化。
 * 重点锁定共同起点、排序去重、缺失日期、非法价格与零基准的结构化结果。
 */

import {
  type ChartComparisonSource,
  latestChartComparisonValues,
  normalizeChartComparisons,
} from "@/modules/alpha/chart/comparison/normalize";
import { describe, expect, it } from "vitest";

function source(
  vtSymbol: string,
  bars: Array<[date: string, close: number]>,
): ChartComparisonSource {
  return {
    vtSymbol,
    name: vtSymbol,
    color: "#4daafc",
    bars: bars.map(([date, close]) => ({
      time: { kind: "trading-day", date },
      close,
    })),
  };
}

describe("normalizeChartComparisons", () => {
  it("按最晚首点选择共同起点，并保留各自缺失交易日", () => {
    const result = normalizeChartComparisons([
      source("MAIN.SSE", [
        ["2026-07-01", 10],
        ["2026-07-02", 11],
        ["2026-07-03", 12],
      ]),
      source("LATE.SSE", [
        ["2026-07-02", 100],
        ["2026-07-03", 110],
      ]),
      source("GAP.SSE", [
        ["2026-07-01", 20],
        ["2026-07-03", 30],
      ]),
    ]);

    expect(result.commonStart).toEqual({
      kind: "trading-day",
      date: "2026-07-02",
    });
    expect(result.series[0].points).toEqual([
      { time: { kind: "trading-day", date: "2026-07-02" }, value: 0 },
      {
        time: { kind: "trading-day", date: "2026-07-03" },
        value: expect.closeTo(9.0909, 3),
      },
    ]);
    expect(result.series[2].points).toEqual([
      { time: { kind: "trading-day", date: "2026-07-03" }, value: 0 },
    ]);
  });

  it("过滤非法值，排序并让重复时间保留最后一条", () => {
    const result = normalizeChartComparisons([
      source("MAIN.SSE", [
        ["2026-07-03", 30],
        ["2026-07-01", Number.NaN],
        ["2026-07-02", 10],
        ["2026-07-02", 20],
      ]),
    ]);

    expect(result.series[0].points).toEqual([
      { time: { kind: "trading-day", date: "2026-07-02" }, value: 0 },
      { time: { kind: "trading-day", date: "2026-07-03" }, value: 50 },
    ]);
  });

  it("分别报告空序列和零基准，不阻断其他标的", () => {
    const result = normalizeChartComparisons([
      source("MAIN.SSE", [["2026-07-01", 10]]),
      source("EMPTY.SSE", [["2026-07-01", Number.POSITIVE_INFINITY]]),
      source("ZERO.SSE", [["2026-07-01", 0]]),
    ]);

    expect(result.series.map((item) => item.vtSymbol)).toEqual(["MAIN.SSE"]);
    expect(result.errors).toEqual([
      { vtSymbol: "EMPTY.SSE", kind: "empty" },
      { vtSymbol: "ZERO.SSE", kind: "zero-base" },
    ]);
    expect(latestChartComparisonValues(result.series)).toEqual({
      "MAIN.SSE": 0,
    });
  });
});
