/**
 * 本文件测试 Alpha 金融图表的数据边界。
 * 锁定交易日和绝对时间到 Lightweight Charts 横轴类型的适配。
 */

import { alphaChartTime } from "@/modules/alpha/components/AlphaFinancialChart";
import { describe, expect, it } from "vitest";

describe("Alpha financial chart data", () => {
  it("adapts normalized daily and intraday times", () => {
    expect(alphaChartTime({ kind: "trading-day", date: "2026-07-30" })).toEqual(
      {
        year: 2026,
        month: 7,
        day: 30,
      },
    );
    expect(alphaChartTime({ kind: "instant", epochSeconds: 1785375000 })).toBe(
      1785375000,
    );
  });
});
