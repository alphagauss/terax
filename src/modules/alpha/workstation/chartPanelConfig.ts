/**
 * 本文件定义工作台图表面板的可持久化配置边界。
 * 配置包含公共行情图表选项、实时开关、有界指标实例和最多三个对比标的，并为缺失字段补默认值。
 */

import {
  type ChartComparisonConfig,
  DEFAULT_MARKET_CHART_OPTIONS,
  FINANCIAL_CHART_TYPES,
  MARKET_CHART_INTERVALS,
  MAX_CHART_COMPARISONS,
  type MarketChartOptions,
} from "@/modules/alpha/chart/model";
import {
  type ChartStudyInstance,
  chartStudyInstanceSchema,
  MAX_CHART_STUDIES,
  MAX_SEPARATE_CHART_STUDIES,
} from "@/modules/alpha/chart/studies/model";
import { MARKET_ADJUSTMENTS } from "@/modules/alpha/market/model";
import { normalizeAlphaVtSymbol } from "@/modules/alpha/workstation/model";
import { z } from "zod";

export type AlphaChartPanelConfig = MarketChartOptions & {
  realtime: boolean;
  studies: ChartStudyInstance[];
  comparisons: ChartComparisonConfig[];
};

const chartComparisonsSchema = z
  .array(
    z
      .object({
        vtSymbol: z
          .string()
          .transform((value) => normalizeAlphaVtSymbol(value))
          .pipe(z.string()),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
  )
  .max(MAX_CHART_COMPARISONS)
  .default([])
  .superRefine((comparisons, context) => {
    const symbols = comparisons.map((comparison) => comparison.vtSymbol);
    if (new Set(symbols).size !== symbols.length) {
      context.addIssue({ code: "custom", message: "对比标的重复" });
    }
  });

const chartStudiesSchema = z
  .array(chartStudyInstanceSchema)
  .max(MAX_CHART_STUDIES)
  .default([])
  .superRefine((instances, context) => {
    const instanceIds = instances.map((instance) => instance.instanceId);
    if (new Set(instanceIds).size !== instanceIds.length) {
      context.addIssue({ code: "custom", message: "指标 instance ID 重复" });
    }
    const separateCount = instances.filter(
      (instance) => instance.type === "rsi" || instance.type === "macd",
    ).length;
    if (separateCount > MAX_SEPARATE_CHART_STUDIES) {
      context.addIssue({ code: "custom", message: "独立指标 pane 数量超限" });
    }
  });

const alphaChartPanelConfigSchema = z
  .object({
    interval: z.enum(MARKET_CHART_INTERVALS).default("d"),
    adjust: z.enum(MARKET_ADJUSTMENTS).default("forward"),
    chartType: z.enum(FINANCIAL_CHART_TYPES).default("candlestick"),
    showVolume: z.boolean().default(true),
    paneRatios: z
      .object({
        main: z.number().positive().default(8),
        volume: z.number().positive().default(2),
      })
      .catchall(z.number().positive())
      .default({ main: 8, volume: 2 }),
    realtime: z.boolean().default(false),
    studies: chartStudiesSchema,
    comparisons: chartComparisonsSchema,
  })
  .strict();

/** 创建新图表面板使用的独立默认配置。 */
export function createDefaultAlphaChartPanelConfig(): AlphaChartPanelConfig {
  return {
    ...DEFAULT_MARKET_CHART_OPTIONS,
    paneRatios: { ...DEFAULT_MARKET_CHART_OPTIONS.paneRatios },
    realtime: false,
    studies: [],
    comparisons: [],
  };
}

/** 解析当前持久化或面板属性中的图表配置，并补齐可选字段默认值。 */
export function parseAlphaChartPanelConfig(
  value: unknown,
): AlphaChartPanelConfig {
  const parsed = alphaChartPanelConfigSchema.parse(value);
  return {
    ...parsed,
    paneRatios: { ...parsed.paneRatios },
    studies: parsed.studies.map((study) => ({
      ...study,
      params: { ...study.params },
      styles: Object.fromEntries(
        Object.entries(study.styles).map(([key, style]) => [key, { ...style }]),
      ),
    })),
    comparisons: parsed.comparisons.map((comparison) => ({ ...comparison })),
  };
}
