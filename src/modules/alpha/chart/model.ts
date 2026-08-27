/**
 * 本文件定义 Alpha 公共金融图表的受控模型。
 * 类型不依赖 Alpha API response，也不向页面暴露 Lightweight Charts 类型。
 */

export type FinancialChartType = "candlestick" | "ohlc" | "line";

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
