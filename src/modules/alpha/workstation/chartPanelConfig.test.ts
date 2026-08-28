/**
 * 本文件测试工作台图表面板的指标与对比配置序列化。
 * 重点锁定指标上限以及对比标的默认值、唯一性、数量和颜色边界。
 */

import {
  createDefaultAlphaChartPanelConfig,
  parseAlphaChartPanelConfig,
} from "@/modules/alpha/workstation/chartPanelConfig";
import { describe, expect, it } from "vitest";

function rsi(instanceId: string) {
  return {
    instanceId,
    type: "rsi" as const,
    params: { period: 14 },
    visible: true,
    styles: { line: { color: "#b06fff", lineWidth: 2 as const } },
  };
}

describe("Alpha chart panel config", () => {
  it("缺失可选字段使用默认值，并恢复指标身份、顺序、参数和样式", () => {
    expect(createDefaultAlphaChartPanelConfig().studies).toEqual([]);
    expect(createDefaultAlphaChartPanelConfig().comparisons).toEqual([]);
    const parsed = parseAlphaChartPanelConfig({
      interval: "d",
      adjust: "forward",
      chartType: "candlestick",
      showVolume: true,
      paneRatios: { main: 7, volume: 2, "rsi-2": 3 },
      studies: [
        rsi("rsi-2"),
        {
          instanceId: "sma-1",
          type: "sma",
          params: { period: 20 },
          visible: false,
          styles: { line: { color: "#e0a43c", lineWidth: 3 } },
        },
      ],
    });

    expect(parsed.studies.map((study) => study.instanceId)).toEqual([
      "rsi-2",
      "sma-1",
    ]);
    expect(parsed.studies[1]).toMatchObject({
      params: { period: 20 },
      visible: false,
      styles: { line: { color: "#e0a43c", lineWidth: 3 } },
    });
    expect(parsed.paneRatios["rsi-2"]).toBe(3);
  });

  it("恢复最多三个唯一对比标的并拒绝非法颜色", () => {
    const base = createDefaultAlphaChartPanelConfig();
    const comparisons = [
      { vtSymbol: "000001.SZSE", color: "#4daafc" },
      { vtSymbol: "600000.SSE", color: "#d9a441" },
      { vtSymbol: "000300.SSE", color: "#a56de2" },
    ];

    expect(
      parseAlphaChartPanelConfig({ ...base, comparisons }).comparisons,
    ).toEqual(comparisons);
    expect(() =>
      parseAlphaChartPanelConfig({
        ...base,
        comparisons: [
          ...comparisons,
          { vtSymbol: "399001.SZSE", color: "#fff" },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAlphaChartPanelConfig({
        ...base,
        comparisons: [comparisons[0], { ...comparisons[0] }],
      }),
    ).toThrow();
    expect(() =>
      parseAlphaChartPanelConfig({
        ...base,
        comparisons: [{ vtSymbol: "000001.SZSE", color: "red" }],
      }),
    ).toThrow();
    expect(() =>
      parseAlphaChartPanelConfig({
        ...base,
        comparisons: [{ vtSymbol: "000001", color: "#4daafc" }],
      }),
    ).toThrow();
  });

  it("拒绝重复身份和第 5 个独立指标", () => {
    const base = createDefaultAlphaChartPanelConfig();
    expect(() =>
      parseAlphaChartPanelConfig({
        ...base,
        studies: [rsi("same"), rsi("same")],
      }),
    ).toThrow();
    expect(() =>
      parseAlphaChartPanelConfig({
        ...base,
        studies: Array.from({ length: 5 }, (_, index) => rsi(`rsi-${index}`)),
      }),
    ).toThrow();
  });
});
