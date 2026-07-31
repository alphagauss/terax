/**
 * 本文件测试 Alpha 金融图表的数据边界。
 * 锁定日线日期不经过本地时区转换，避免交易日发生偏移。
 */

import { alphaBusinessDay } from "@/modules/alpha/components/AlphaFinancialChart";
import { describe, expect, it } from "vitest";

describe("Alpha financial chart data", () => {
  it("converts ISO datetimes to a timezone-neutral business day", () => {
    expect(alphaBusinessDay("2026-07-30T00:00:00+08:00")).toEqual({
      year: 2026,
      month: 7,
      day: 30,
    });
  });
});
