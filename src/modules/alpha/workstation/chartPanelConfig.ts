/**
 * 本文件定义工作台图表面板的可持久化配置边界。
 * 配置只包含公共行情图表选项，并为旧空对象提供显式默认值。
 */

import {
  DEFAULT_MARKET_CHART_OPTIONS,
  FINANCIAL_CHART_TYPES,
  MARKET_CHART_INTERVALS,
  type MarketChartOptions,
} from "@/modules/alpha/chart/model";
import { MARKET_ADJUSTMENTS } from "@/modules/alpha/market/model";
import { z } from "zod";

const alphaChartPanelConfigSchema = z
  .object({
    interval: z.enum(MARKET_CHART_INTERVALS).default("d"),
    adjust: z.enum(MARKET_ADJUSTMENTS).default("forward"),
    chartType: z.enum(FINANCIAL_CHART_TYPES).default("candlestick"),
  })
  .strict();

/** 创建新图表面板使用的独立默认配置。 */
export function createDefaultAlphaChartPanelConfig(): MarketChartOptions {
  return { ...DEFAULT_MARKET_CHART_OPTIONS };
}

/** 解析持久化或面板属性中的图表配置，并补齐旧版本缺失字段。 */
export function parseAlphaChartPanelConfig(value: unknown): MarketChartOptions {
  return alphaChartPanelConfigSchema.parse(value);
}
