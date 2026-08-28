/**
 * 本文件定义 Alpha 图表指标的引擎无关边界模型。
 * 服务端 wire time 在此复用行情时间归一化，计算查询键只包含数据与参数语义。
 */

import type { MarketInterval, MarketTime } from "@/modules/alpha/market/model";
import {
  marketTimeKey,
  normalizeMarketTime,
} from "@/modules/alpha/market/normalize";
import { z } from "zod";

export const CHART_STUDY_TYPES = ["sma", "ema", "boll", "rsi", "macd"] as const;
export const MAX_CHART_STUDIES = 8;
export const MAX_SEPARATE_CHART_STUDIES = 4;

const studyTypeSchema = z.enum(CHART_STUDY_TYPES);
const studyPaneSchema = z.enum(["main", "separate"]);
const studySeriesKindSchema = z.enum(["line", "histogram"]);
const studyInstanceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const studyLineWidthSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
const studyStyleSchema = z
  .object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    lineWidth: studyLineWidthSchema,
    positiveColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    negativeColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict();

const studyParamWireSchema = z
  .object({
    key: z.string().min(1).max(32),
    default_value: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
  })
  .superRefine((param, context) => {
    if (param.min > param.max) {
      context.addIssue({ code: "custom", message: "指标参数范围非法" });
    }
    if (param.default_value < param.min || param.default_value > param.max) {
      context.addIssue({ code: "custom", message: "指标默认参数越界" });
    }
  });

const studyOutputDefinitionWireSchema = z.object({
  id: z.string().min(1).max(32),
  kind: studySeriesKindSchema,
});

const studyDefinitionWireSchema = z
  .object({
    type: studyTypeSchema,
    pane: studyPaneSchema,
    params: z.array(studyParamWireSchema).max(8),
    outputs: z.array(studyOutputDefinitionWireSchema).min(1).max(8),
    levels: z.array(z.number().finite()).max(8),
  })
  .superRefine((definition, context) => {
    const paramKeys = definition.params.map((param) => param.key);
    const outputIds = definition.outputs.map((output) => output.id);
    if (new Set(paramKeys).size !== paramKeys.length) {
      context.addIssue({ code: "custom", message: "指标参数 key 重复" });
    }
    if (new Set(outputIds).size !== outputIds.length) {
      context.addIssue({ code: "custom", message: "指标 output ID 重复" });
    }
  });

export const studyDefinitionsWireSchema = z
  .array(studyDefinitionWireSchema)
  .max(CHART_STUDY_TYPES.length)
  .superRefine((definitions, context) => {
    const types = definitions.map((definition) => definition.type);
    if (new Set(types).size !== types.length) {
      context.addIssue({
        code: "custom",
        message: "指标 definition type 重复",
      });
    }
  });

const studyPointWireSchema = z.object({
  time: z.string().min(1).max(64),
  value: z.number().finite().nullable(),
});

const studySeriesWireSchema = z.object({
  id: z.string().min(1).max(32),
  kind: studySeriesKindSchema,
  points: z.array(studyPointWireSchema).max(4_000),
});

const studyResultWireSchema = z
  .object({
    instance_id: studyInstanceIdSchema,
    pane: studyPaneSchema,
    outputs: z.array(studySeriesWireSchema).min(1).max(8),
    levels: z.array(z.number().finite()).max(8),
  })
  .superRefine((result, context) => {
    const outputIds = result.outputs.map((output) => output.id);
    if (new Set(outputIds).size !== outputIds.length) {
      context.addIssue({ code: "custom", message: "指标结果 output ID 重复" });
    }
  });

export const studyCalculationWireSchema = z
  .object({
    actual_start: z.string().min(1).max(64).nullable(),
    actual_end: z.string().min(1).max(64).nullable(),
    items: z.array(studyResultWireSchema).max(8),
  })
  .superRefine((response, context) => {
    const instanceIds = response.items.map((item) => item.instance_id);
    if (new Set(instanceIds).size !== instanceIds.length) {
      context.addIssue({
        code: "custom",
        message: "指标结果 instance ID 重复",
      });
    }
  });

export type ChartStudyType = (typeof CHART_STUDY_TYPES)[number];
export type ChartStudyPane = z.infer<typeof studyPaneSchema>;
export type ChartStudySeriesKind = z.infer<typeof studySeriesKindSchema>;

export type ChartStudyDefinition = {
  type: ChartStudyType;
  pane: ChartStudyPane;
  params: Array<{
    key: string;
    defaultValue: number;
    min: number;
    max: number;
    step: number;
  }>;
  outputs: Array<{ id: string; kind: ChartStudySeriesKind }>;
  levels: number[];
};

export const chartStudyInstanceSchema = z
  .object({
    instanceId: studyInstanceIdSchema,
    type: studyTypeSchema,
    params: z.record(z.string().min(1).max(32), z.number().finite()),
    visible: z.boolean(),
    styles: z.record(z.string().min(1).max(32), studyStyleSchema),
  })
  .strict()
  .superRefine((instance, context) => {
    if (Object.keys(instance.params).length > 8) {
      context.addIssue({ code: "custom", message: "指标参数数量超限" });
    }
    if (Object.keys(instance.styles).length > 8) {
      context.addIssue({ code: "custom", message: "指标样式数量超限" });
    }
  });

export type ChartStudyInstance = z.infer<typeof chartStudyInstanceSchema>;
export type ChartStudyStyle = z.infer<typeof studyStyleSchema>;

export type ChartStudyCalculationInstance = Pick<
  ChartStudyInstance,
  "instanceId" | "type" | "params"
>;

export type ChartStudyResult = {
  instanceId: string;
  pane: ChartStudyPane;
  outputs: Array<{
    id: string;
    kind: ChartStudySeriesKind;
    points: Array<{ time: MarketTime; value: number | null }>;
  }>;
  levels: number[];
};

export type ChartStudyCalculation = {
  actualStart: string | null;
  actualEnd: string | null;
  items: ChartStudyResult[];
};

const DEFAULT_STUDY_COLORS: Record<ChartStudyType, Record<string, string>> = {
  sma: { line: "#e0a43c" },
  ema: { line: "#19b6c9" },
  boll: { mid: "#8b94a7", upper: "#5a89c9", lower: "#5a89c9" },
  rsi: { line: "#b06fff" },
  macd: { macd: "#3d8bff", signal: "#e0a43c", hist: "#8b94a7" },
};

/** 根据服务端 definition 创建可直接持久化的默认指标实例。 */
export function createChartStudyInstance(
  definition: ChartStudyDefinition,
  instanceId: string,
): ChartStudyInstance {
  return chartStudyInstanceSchema.parse({
    instanceId,
    type: definition.type,
    params: Object.fromEntries(
      definition.params.map((param) => [param.key, param.defaultValue]),
    ),
    visible: true,
    styles: Object.fromEntries(
      definition.outputs.map((output) => [
        output.id,
        {
          color: DEFAULT_STUDY_COLORS[definition.type][output.id] ?? "#8b94a7",
          lineWidth: 2,
        },
      ]),
    ),
  });
}

/** 使用 definition 在前端快速校验参数，服务端仍保留权威校验。 */
export function validateChartStudyParams(
  definition: ChartStudyDefinition,
  params: Record<string, number>,
): boolean {
  if (
    Object.keys(params).length !== definition.params.length ||
    definition.params.some((param) => {
      const value = params[param.key];
      if (!Number.isFinite(value) || value < param.min || value > param.max) {
        return true;
      }
      const steps = (value - param.min) / param.step;
      return Math.abs(steps - Math.round(steps)) > 1e-9;
    })
  ) {
    return false;
  }
  return (
    definition.type !== "macd" ||
    (params.fast !== undefined &&
      params.slow !== undefined &&
      params.fast < params.slow)
  );
}

/** 返回当前配置中独立 pane 指标的数量。 */
export function countSeparateChartStudies(
  instances: readonly ChartStudyInstance[],
): number {
  return instances.filter(
    (instance) => instance.type === "rsi" || instance.type === "macd",
  ).length;
}

/** 把服务端 definition 字段转换为前端稳定的 camelCase 模型。 */
export function normalizeChartStudyDefinitions(
  input: unknown,
): ChartStudyDefinition[] {
  return studyDefinitionsWireSchema.parse(input).map((definition) => ({
    type: definition.type,
    pane: definition.pane,
    params: definition.params.map((param) => ({
      key: param.key,
      defaultValue: param.default_value,
      min: param.min,
      max: param.max,
      step: param.step,
    })),
    outputs: definition.outputs,
    levels: definition.levels,
  }));
}

/**
 * 归一化服务端指标点，并锁定每个 output 的时间严格升序且互相对齐。
 */
export function normalizeChartStudyCalculation(
  input: unknown,
  interval: MarketInterval,
): ChartStudyCalculation {
  const response = studyCalculationWireSchema.parse(input);
  const items = response.items.map((item) => {
    let expectedTimeKeys: number[] | null = null;
    const outputs = item.outputs.map((output) => {
      const points = output.points.map((point) => ({
        time: normalizeMarketTime(point.time, interval),
        value: point.value,
      }));
      const timeKeys = points.map((point) => marketTimeKey(point.time));
      if (
        timeKeys.some((key, index) => index > 0 && key <= timeKeys[index - 1])
      ) {
        throw new Error(`指标 ${item.instance_id} 时间不是严格升序`);
      }
      if (
        expectedTimeKeys !== null &&
        (timeKeys.length !== expectedTimeKeys.length ||
          timeKeys.some((key, index) => key !== expectedTimeKeys?.[index]))
      ) {
        throw new Error(`指标 ${item.instance_id} 输出时间未对齐`);
      }
      expectedTimeKeys = timeKeys;
      return { id: output.id, kind: output.kind, points };
    });
    return {
      instanceId: item.instance_id,
      pane: item.pane,
      outputs,
      levels: item.levels,
    };
  });
  return {
    actualStart: response.actual_start,
    actualEnd: response.actual_end,
    items,
  };
}

/**
 * 过滤隐藏实例并稳定排序计算参数，样式和 pane 尺寸不会进入服务端查询键。
 */
export function normalizeVisibleStudyInstances(
  instances: readonly ChartStudyInstance[],
): ChartStudyCalculationInstance[] {
  const visible = instances
    .filter((instance) => instance.visible)
    .map((instance) => {
      const params = Object.fromEntries(
        Object.entries(instance.params)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => {
            if (!Number.isFinite(value)) {
              throw new Error(`指标 ${instance.instanceId} 参数 ${key} 非法`);
            }
            return [key, value];
          }),
      );
      return { instanceId: instance.instanceId, type: instance.type, params };
    })
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const instanceIds = visible.map((instance) => instance.instanceId);
  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error("可见指标 instance ID 重复");
  }
  return visible;
}

/** 返回 React Query 可直接使用的稳定计算签名。 */
export function studyCalculationSignature(
  instances: readonly ChartStudyCalculationInstance[],
): string {
  return JSON.stringify(instances);
}
