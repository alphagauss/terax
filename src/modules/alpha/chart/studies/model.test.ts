/**
 * 本文件测试 Alpha 图表指标的协议归一化与稳定计算签名。
 * 重点锁定未知输出、时间错位、重复实例和样式零请求成本边界。
 */

import {
  normalizeChartStudyCalculation,
  normalizeChartStudyDefinitions,
  normalizeVisibleStudyInstances,
  studyCalculationSignature,
  type ChartStudyInstance,
} from "@/modules/alpha/chart/studies/model";
import { describe, expect, it } from "vitest";

function instance(
  overrides: Partial<ChartStudyInstance> = {},
): ChartStudyInstance {
  return {
    instanceId: "sma-1",
    type: "sma",
    params: { period: 20 },
    visible: true,
    styles: { line: { color: "#fff", lineWidth: 1 } },
    ...overrides,
  };
}

describe("chart study model", () => {
  it("归一化服务端 definition 且不接收用户文案", () => {
    expect(
      normalizeChartStudyDefinitions([
        {
          type: "sma",
          pane: "main",
          params: [
            {
              key: "period",
              default_value: 20,
              min: 1,
              max: 500,
              step: 1,
            },
          ],
          outputs: [{ id: "line", kind: "line" }],
          levels: [],
        },
      ]),
    ).toEqual([
      {
        type: "sma",
        pane: "main",
        params: [
          { key: "period", defaultValue: 20, min: 1, max: 500, step: 1 },
        ],
        outputs: [{ id: "line", kind: "line" }],
        levels: [],
      },
    ]);
  });

  it("把日线点归一为引擎无关时间并保留空值", () => {
    expect(
      normalizeChartStudyCalculation(
        {
          actual_start: "2026-08-01",
          actual_end: "2026-08-02",
          items: [
            {
              instance_id: "rsi-1",
              pane: "separate",
              outputs: [
                {
                  id: "line",
                  kind: "line",
                  points: [
                    { time: "2026-08-01", value: null },
                    { time: "2026-08-02", value: 51 },
                  ],
                },
              ],
              levels: [30, 70],
            },
          ],
        },
        "d",
      ).items[0].outputs[0].points,
    ).toEqual([
      { time: { kind: "trading-day", date: "2026-08-01" }, value: null },
      { time: { kind: "trading-day", date: "2026-08-02" }, value: 51 },
    ]);
  });

  it("拒绝未知 series kind、重复实例和非法时间", () => {
    const base = {
      actual_start: "2026-08-01",
      actual_end: "2026-08-01",
      items: [
        {
          instance_id: "study-1",
          pane: "main",
          outputs: [
            {
              id: "line",
              kind: "line",
              points: [{ time: "2026-08-01", value: 1 }],
            },
          ],
          levels: [],
        },
      ],
    };

    expect(() =>
      normalizeChartStudyCalculation(
        {
          ...base,
          items: [
            {
              ...base.items[0],
              outputs: [{ ...base.items[0].outputs[0], kind: "area" }],
            },
          ],
        },
        "d",
      ),
    ).toThrow();
    expect(() =>
      normalizeChartStudyCalculation(
        { ...base, items: [base.items[0], base.items[0]] },
        "d",
      ),
    ).toThrow();
    expect(() =>
      normalizeChartStudyCalculation(
        {
          ...base,
          items: [
            {
              ...base.items[0],
              outputs: [
                {
                  ...base.items[0].outputs[0],
                  points: [{ time: "invalid", value: 1 }],
                },
              ],
            },
          ],
        },
        "d",
      ),
    ).toThrow();
  });

  it("计算签名稳定排序且排除显隐、颜色和线宽以外的隐藏实例", () => {
    const first = normalizeVisibleStudyInstances([
      instance({
        instanceId: "sma-2",
        params: { period: 50, source: 1 },
        styles: { line: { color: "#f00", lineWidth: 4 } },
      }),
      instance({ instanceId: "sma-1", params: { period: 20 } }),
      instance({ instanceId: "hidden", visible: false }),
    ]);
    const second = normalizeVisibleStudyInstances([
      instance({ instanceId: "sma-1", params: { period: 20 } }),
      instance({
        instanceId: "sma-2",
        params: { source: 1, period: 50 },
        styles: { line: { color: "#0f0", lineWidth: 1 } },
      }),
    ]);

    expect(first.map((item) => item.instanceId)).toEqual(["sma-1", "sma-2"]);
    expect(studyCalculationSignature(first)).toBe(
      studyCalculationSignature(second),
    );
  });
});
