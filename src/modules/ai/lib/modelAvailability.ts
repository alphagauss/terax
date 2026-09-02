/**
 * 本文件统一计算当前配置下可供聊天选择的 AI 模型。
 * 只判断必要配置是否存在，不探测服务在线状态或账号模型权限。
 */

import {
  builtinProviderId,
  isConfigurableProvider,
  MODELS,
  type ModelRef,
  modelRefForProvider,
  modelRefKey,
  modelRefsEqual,
  providerNeedsKey,
  type ProviderId,
  type ProviderInstance,
} from "../config";

export type ModelAvailabilityConfig = {
  apiKeys: Readonly<Partial<Record<ProviderId, string | null | undefined>>>;
  providerModels: Readonly<Record<string, string | undefined>>;
  lmstudioBaseURL: string;
  mlxBaseURL: string;
  ollamaBaseURL: string;
  customProviders: readonly ProviderInstance[];
};

/**
 * 按模型目录和 Provider 配置顺序返回当前可选择的模型引用。
 * 自由模型需要模型 ID，本地 Provider 还需要服务地址；自定义兼容 Provider 的密钥可选。
 */
export function getAvailableModelRefs(
  config: ModelAvailabilityConfig,
): ModelRef[] {
  const refs: ModelRef[] = [];
  const seen = new Set<string>();
  const add = (ref: ModelRef) => {
    const key = modelRefKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const model of MODELS) {
    if (isConfigurableProvider(model.provider)) {
      const providerId = builtinProviderId(model.provider);
      const configuredModel = config.providerModels[providerId]?.trim();
      if (!configuredModel) continue;

      if (model.provider === "openrouter") {
        if (!config.apiKeys.openrouter) continue;
      } else {
        const baseURL =
          model.provider === "lmstudio"
            ? config.lmstudioBaseURL
            : model.provider === "mlx"
              ? config.mlxBaseURL
              : config.ollamaBaseURL;
        if (!baseURL.trim()) continue;
      }

      add(modelRefForProvider(model.provider, configuredModel));
      continue;
    }

    if (providerNeedsKey(model.provider) && !config.apiKeys[model.provider]) {
      continue;
    }
    add(modelRefForProvider(model.provider, model.id));
  }

  for (const provider of config.customProviders) {
    const modelId = config.providerModels[provider.id]?.trim();
    if (!provider.baseURL.trim() || !modelId) continue;
    add({ providerId: provider.id, modelId });
  }

  return refs;
}

/** 从可用集合中保留当前选择，或依次回退到默认模型和首个模型。 */
export function selectAvailableModel(
  current: ModelRef,
  preferred: ModelRef,
  available: readonly ModelRef[],
): ModelRef | null {
  if (available.some((model) => modelRefsEqual(model, current))) return current;
  if (available.some((model) => modelRefsEqual(model, preferred))) {
    return preferred;
  }
  return available[0] ?? null;
}
