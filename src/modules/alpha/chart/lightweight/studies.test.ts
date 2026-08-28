/**
 * 本文件测试指标 pane routing、histogram 颜色和大批量 series 转换。
 * 重点锁定最多四个独立 pane，以及 10,000 点、4 指标的转换预算。
 */

import {
  buildChartStudySeriesData,
  latestChartStudyValues,
  routeChartStudies,
} from "@/modules/alpha/chart/lightweight/studies";
import type { FinancialChartPalette } from "@/modules/alpha/chart/model";
import type {
  ChartStudyInstance,
  ChartStudyResult,
} from "@/modules/alpha/chart/studies/model";
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

function instance(id: string, type: "sma" | "rsi" = "sma"): ChartStudyInstance {
  return {
    instanceId: id,
    type,
    params: { period: 14 },
    visible: true,
    styles: { line: { color: "#abcdef", lineWidth: 2 } },
  };
}

function result(
  id: string,
  pane: "main" | "separate",
  count = 2,
): ChartStudyResult {
  return {
    instanceId: id,
    pane,
    outputs: [
      {
        id: "line",
        kind: "line",
        points: Array.from({ length: count }, (_, index) => ({
          time: {
            kind: "instant" as const,
            epochSeconds: 1_700_000_000 + index,
          },
          value: index,
        })),
      },
    ],
    levels: [],
  };
}

describe("lightweight chart studies", () => {
  it("把 overlay 固定到主图并让独立指标在成交量后连续排列", () => {
    const instances = [
      instance("sma-1"),
      instance("rsi-1", "rsi"),
      instance("rsi-2", "rsi"),
    ];
    const results = [
      result("sma-1", "main"),
      result("rsi-1", "separate"),
      result("rsi-2", "separate"),
    ];

    expect(
      routeChartStudies(results, instances, true).map((item) => item.paneIndex),
    ).toEqual([0, 2, 3]);
    expect(
      routeChartStudies(results, instances, false).map(
        (item) => item.paneIndex,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("Controller routing 不接收第 5 个独立指标 pane", () => {
    const instances = Array.from({ length: 5 }, (_, index) =>
      instance(`rsi-${index}`, "rsi"),
    );
    const results = instances.map((item) =>
      result(item.instanceId, "separate"),
    );

    expect(routeChartStudies(results, instances, false)).toHaveLength(4);
  });

  it("histogram 使用实例颜色或主题正负色并保留空点", () => {
    const data = buildChartStudySeriesData(
      {
        id: "hist",
        kind: "histogram",
        points: [
          { time: { kind: "trading-day", date: "2026-08-01" }, value: 1 },
          { time: { kind: "trading-day", date: "2026-08-02" }, value: -1 },
          { time: { kind: "trading-day", date: "2026-08-03" }, value: null },
        ],
      },
      { color: "#888888", lineWidth: 1, positiveColor: "#123456" },
      palette,
    );

    expect(data).toEqual([
      { time: { year: 2026, month: 8, day: 1 }, value: 1, color: "#123456" },
      { time: { year: 2026, month: 8, day: 2 }, value: -1, color: "#f00" },
      { time: { year: 2026, month: 8, day: 3 } },
    ]);
  });

  it("10,000 点和 4 个指标的 payload 转换低于 120ms", () => {
    const largeResults = Array.from({ length: 4 }, (_, index) =>
      result(`sma-${index}`, "main", 10_000),
    );
    const started = performance.now();
    for (const study of largeResults) {
      buildChartStudySeriesData(
        study.outputs[0],
        { color: "#abcdef", lineWidth: 2 },
        palette,
      );
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(120);
    expect(latestChartStudyValues(largeResults)["sma-3"].line).toBe(9_999);
  });
});
