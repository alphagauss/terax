/**
 * 本文件测试工作台图表面板的指标配置序列化与恢复。
 * 重点锁定 instance ID、顺序、参数、样式和独立 pane 上限。
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
  it("旧配置补空指标，新配置恢复身份、顺序、参数和样式", () => {
    expect(createDefaultAlphaChartPanelConfig().studies).toEqual([]);
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
