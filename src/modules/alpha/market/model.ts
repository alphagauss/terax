/**
 * 本文件定义 Alpha 前端共用的行情领域模型。
 * 模型不依赖 API 响应、React 或具体图表引擎，供页面、场景和面板共同消费。
 */

export const MARKET_INTERVALS = ["1m", "1h", "d", "w", "tick"] as const;

export type MarketInterval = (typeof MARKET_INTERVALS)[number];

export const MARKET_ADJUSTMENTS = ["none", "forward", "backward"] as const;

export type MarketAdjust = (typeof MARKET_ADJUSTMENTS)[number];

export type MarketTime =
  | { kind: "trading-day"; date: string }
  | { kind: "instant"; epochSeconds: number };

export type MarketBar = {
  time: MarketTime;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  openInterest?: number | null;
};

export type MarketBarPage = {
  items: MarketBar[];
  hasMoreBefore: boolean;
  nextBefore: string | null;
  actualStart: string | null;
  actualEnd: string | null;
};

export type MarketBarInput = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
  openInterest: number | null;
};
