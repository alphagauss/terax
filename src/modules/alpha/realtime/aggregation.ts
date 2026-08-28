/**
 * 本文件实现实时 K 线增量的引擎无关合并规则。
 * 同 bucket 支持累计量或增量量，新 bucket 追加，迟到 bucket 明确拒绝。
 */

import type { MarketBar } from "@/modules/alpha/market/model";
import { marketTimeKey } from "@/modules/alpha/market/normalize";

export type RealtimeBarMerge =
  | { mode: "replace" | "append"; bar: MarketBar }
  | { mode: "late"; bar: null };

/** 合并一条完整价格增量，并按协议解释 volume 与 amount。 */
export function mergeRealtimeBar(
  previous: MarketBar | null,
  incoming: MarketBar,
  volumeMode: "cumulative" | "incremental",
): RealtimeBarMerge {
  if (!previous) return { mode: "append", bar: incoming };
  const previousTime = marketTimeKey(previous.time);
  const incomingTime = marketTimeKey(incoming.time);
  if (incomingTime < previousTime) return { mode: "late", bar: null };
  if (incomingTime > previousTime) return { mode: "append", bar: incoming };
  if (volumeMode === "cumulative") {
    return { mode: "replace", bar: incoming };
  }
  return {
    mode: "replace",
    bar: {
      ...incoming,
      open: previous.open,
      high: Math.max(previous.high, incoming.high),
      low: Math.min(previous.low, incoming.low),
      volume:
        previous.volume === null && incoming.volume === null
          ? null
          : (previous.volume ?? 0) + (incoming.volume ?? 0),
      amount:
        previous.amount === null && incoming.amount === null
          ? null
          : (previous.amount ?? 0) + (incoming.amount ?? 0),
    },
  };
}
