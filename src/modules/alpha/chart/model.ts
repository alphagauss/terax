/**
 * 本文件定义 Alpha 公共金融图表的受控模型。
 * 类型不依赖 Alpha API response，也不向页面暴露 Lightweight Charts 类型。
 */

import type {
  MarketAdjust,
  MarketInterval,
} from "@/modules/alpha/market/model";

export type FinancialChartType = "candlestick" | "ohlc" | "line";

export const FINANCIAL_CHART_TYPES = [
  "candlestick",
  "ohlc",
  "line",
] as const satisfies readonly FinancialChartType[];

export const MARKET_CHART_INTERVALS = ["1m", "1h", "d", "w"] as const;

export type MarketChartInterval = Exclude<MarketInterval, "tick">;

export type MarketChartOptions = {
  interval: MarketChartInterval;
  adjust: MarketAdjust;
  chartType: FinancialChartType;
};

export type MarketChartDensity = "compact" | "panel";

export const DEFAULT_MARKET_CHART_OPTIONS = {
  interval: "d",
  adjust: "forward",
  chartType: "candlestick",
} as const satisfies MarketChartOptions;

export type FinancialChartStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error";

export type FinancialChartPalette = {
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
  line: string;
};
