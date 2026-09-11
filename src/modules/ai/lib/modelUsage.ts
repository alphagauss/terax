/**
 * 定义 AI 应用的模型使用配置、精确存储键和请求快照。
 * 模型定义全局共享，选值按模块和完整模型身份隔离；宿主显式提供跟随模型。
 */
import { isModelRef, modelRefKey, type ModelRef } from "@/modules/ai/config";
import {
  readParameterSelections,
  resolveModelParameters,
  type ModelParameterDefinitions,
  type ModelParameterSelections,
} from "@/modules/ai/lib/modelParameters";

export const MODEL_USAGE_IDS = ["completion", "subagent"] as const;
export type ModelUsageId =
  | (typeof MODEL_USAGE_IDS)[number]
  | `channel:${string}`;

export function channelModelUsageId(connectionId: string): `channel:${string}` {
  return `channel:${connectionId}`;
}
export type ModelUsage = {
  model: ModelRef | null;
  parameterSelections: ModelParameterSelections;
};
export type ModelUsages = Record<(typeof MODEL_USAGE_IDS)[number], ModelUsage> &
  Partial<Record<`channel:${string}`, ModelUsage>>;

/** 新连接没有覆盖记录时使用入口提供的默认模型与模型默认参数。 */
export function getModelUsage(
  usages: ModelUsages,
  id: ModelUsageId,
): ModelUsage {
  return usages[id] ?? { model: null, parameterSelections: {} };
}
export const MODEL_USAGE_PREFIX = "modelUsage:";

export function modelUsageModelKey(id: ModelUsageId): string {
  return `${MODEL_USAGE_PREFIX}${id}:model`;
}

export function modelUsageParametersPrefix(id: ModelUsageId): string {
  return `${MODEL_USAGE_PREFIX}${id}:parameters:`;
}

/** 只读取现行格式，保留显式模型身份，不把失效引用改为跟随模式。 */
export function readModelUsages(values: Record<string, unknown>): ModelUsages {
  const ids = new Set<ModelUsageId>(MODEL_USAGE_IDS);
  for (const key of Object.keys(values)) {
    const match = /^modelUsage:(channel:[^:]+):(?:model$|parameters:)/.exec(
      key,
    );
    if (match) ids.add(match[1] as `channel:${string}`);
  }
  return Object.fromEntries(
    [...ids].map((id) => {
      const model = values[modelUsageModelKey(id)];
      const prefix = modelUsageParametersPrefix(id);
      return [
        id,
        {
          model: isModelRef(model) ? { ...model } : null,
          parameterSelections: Object.fromEntries(
            Object.entries(values)
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, value]) => [
                key.slice(prefix.length),
                readParameterSelections(value),
              ]),
          ),
        },
      ];
    }),
  ) as ModelUsages;
}

/** 运行入口冻结实际模型与参数值；跟随只选择模型，不继承其他使用者的参数。 */
export function resolveModelUsage(
  usage: ModelUsage,
  definitions: ModelParameterDefinitions,
  fallbackModel: ModelRef | null,
) {
  const model = usage.model ?? fallbackModel;
  if (!model) return null;
  const key = modelRefKey(model);
  return {
    model: { ...model },
    parameters: resolveModelParameters(
      definitions[key] ?? [],
      usage.parameterSelections[key],
    ),
  };
}
