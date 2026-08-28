/**
 * 本文件定义 Alpha 实时行情的前端运行时边界。
 * 类型保持图表引擎无关，连接、sequence 和订阅对象都不参与持久化。
 */

import type {
  MarketAdjust,
  MarketBar,
  MarketInterval,
} from "@/modules/alpha/market/model";

export type MarketDataKey = {
  vtSymbol: string;
  interval: Exclude<MarketInterval, "tick">;
  adjust: MarketAdjust;
};

export type MarketRealtimeStatus =
  | "connecting"
  | "live"
  | "delayed"
  | "stale"
  | "reconnecting"
  | "disconnected";

export type MarketRealtimeState = {
  status: MarketRealtimeStatus;
};

export type MarketRealtimeSnapshot = {
  type: "snapshot";
  sequence: number;
  bars: readonly MarketBar[];
};

export type MarketRealtimeDelta = {
  type: "bar";
  sequence: number;
  bar: MarketBar;
  isFinal: boolean;
  previousFinal: boolean;
  volumeMode: "cumulative" | "incremental";
};

export type MarketRealtimeDataEvent =
  | MarketRealtimeSnapshot
  | MarketRealtimeDelta;

export type MarketDataRuntime = {
  readonly dataKey: string;
  getState(): MarketRealtimeState;
  subscribeState(listener: (state: MarketRealtimeState) => void): () => void;
  subscribeData(listener: (event: MarketRealtimeDataEvent) => void): () => void;
};

export type MarketDataBinding = MarketDataRuntime & {
  release(): void;
};

/** 返回协议和缓存共用的稳定完整数据键。 */
export function marketDataKeyId(key: MarketDataKey): string {
  return `${key.vtSymbol}|${key.interval}|${key.adjust}`;
}
