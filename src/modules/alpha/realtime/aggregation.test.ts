/**
 * 本文件测试实时 K 线纯合并规则。
 * 锁定累计量、增量量、同 bucket 替换、新 bucket 追加和迟到数据拒绝。
 */

import type { MarketBar } from "@/modules/alpha/market/model";
import { mergeRealtimeBar } from "@/modules/alpha/realtime/aggregation";
import { describe, expect, it } from "vitest";

function bar(date: string, close: number, volume: number): MarketBar {
  return {
    time: { kind: "trading-day", date },
    open: close,
    high: close,
    low: close,
    close,
    volume,
    amount: volume * close,
    openInterest: null,
  };
}

describe("mergeRealtimeBar", () => {
  it("同 bucket 的累计量使用服务端完整值", () => {
    const result = mergeRealtimeBar(
      bar("2026-08-28", 10, 100),
      bar("2026-08-28", 11, 120),
      "cumulative",
    );

    expect(result).toEqual({
      mode: "replace",
      bar: bar("2026-08-28", 11, 120),
    });
  });

  it("同 bucket 的增量量累加且保留首个 open", () => {
    const previous = bar("2026-08-28", 10, 100);
    const incoming = {
      ...bar("2026-08-28", 11, 20),
      high: 12,
      low: 9,
    };

    expect(mergeRealtimeBar(previous, incoming, "incremental")).toEqual({
      mode: "replace",
      bar: expect.objectContaining({
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 120,
        amount: 1_220,
      }),
    });
  });

  it("追加新 bucket 并拒绝迟到 bucket", () => {
    const current = bar("2026-08-28", 10, 100);
    const next = bar("2026-08-29", 11, 20);
    const late = bar("2026-08-27", 9, 30);

    expect(mergeRealtimeBar(current, next, "cumulative")).toEqual({
      mode: "append",
      bar: next,
    });
    expect(mergeRealtimeBar(current, late, "cumulative")).toEqual({
      mode: "late",
      bar: null,
    });
  });
});
