/**
 * 本文件测试金融图表使用的市场元数据纯函数。
 * 重点锁定非十进制最小跳动、交易所时区和涨跌颜色约定不受运行环境影响。
 */

import {
  formatMarketTimestamp,
  marketDirectionColors,
  pricePrecisionFromMinMove,
} from "@/modules/alpha/market/metadata";
import { describe, expect, it } from "vitest";

describe("Alpha market metadata", () => {
  it.each([
    [null, null],
    [0, null],
    [-0.01, null],
    [1, 0],
    [0.25, 2],
    [0.05, 2],
    [0.01, 2],
    [0.001, 3],
    [0.000000001, 8],
  ])("把最小价格跳动 %s 转换为有界精度 %s", (minMove, precision) => {
    expect(pricePrecisionFromMinMove(minMove)).toBe(precision);
  });

  it("按后端 IANA 时区格式化盘中时间而不使用系统时区", () => {
    const epochSeconds = Date.parse("2026-07-30T01:30:00Z") / 1_000;

    expect(
      formatMarketTimestamp(epochSeconds, "Asia/Shanghai", "en-GB", "time"),
    ).toBe("09:30");
    expect(
      formatMarketTimestamp(epochSeconds, "America/New_York", "en-GB", "time"),
    ).toBe("21:30");
  });

  it("按市场约定映射同一组成功色和风险色", () => {
    expect(marketDirectionColors("#0f0", "#f00", "up-green")).toEqual({
      up: "#0f0",
      down: "#f00",
    });
    expect(marketDirectionColors("#0f0", "#f00", "up-red")).toEqual({
      up: "#f00",
      down: "#0f0",
    });
  });
});
