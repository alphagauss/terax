/**
 * 本文件统一计算当前配置下可供聊天选择的 AI 模型。
 * 只判断必要配置是否存在，不探测服务在线状态或账号模型权限。
 */

import {
  builtinProviderId,
  type ModelRef,
  modelRefForProvider,
  modelRefKey,
  modelRefsEqual,
  PROVIDERS,
  type ProviderBaseURLs,
  type ProviderId,
  type ProviderInstance,
  type ProviderModels,
  resolveProviderInstance,
} from "../config";
import { isProviderConnectionReady } from "../providerRegistry";

export type ModelAvailabilityConfig = {
  apiKeys: Readonly<Partial<Record<ProviderId, string | null | undefined>>>;
  providerModels: Readonly<ProviderModels>;
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
};

/**
 * 按 Provider 配置顺序返回用户已添加且连接条件完整的模型引用。
 * 本地 Provider 需要服务地址；自定义兼容 Provider 的密钥可选。
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

  for (const provider of PROVIDERS) {
    const providerId = builtinProviderId(provider.id);
    const models = config.providerModels[providerId] ?? [];
    if (models.length === 0) continue;
    const connection = resolveProviderInstance(providerId, {
      providerBaseURLs: config.providerBaseURLs,
      providerCredentials: config.apiKeys,
    });
    if (!isProviderConnectionReady(connection)) continue;
    for (const model of models) {
      add(modelRefForProvider(provider.id, model.id));
    }
  }

  for (const provider of config.customProviders) {
    const connection = resolveProviderInstance(provider.id, {
      customProviders: config.customProviders,
    });
    if (!isProviderConnectionReady(connection)) continue;
    for (const model of config.providerModels[provider.id] ?? []) {
      add({ providerId: provider.id, modelId: model.id });
    }
  }

  return refs;
}

/** 从可用集合中保留当前选择，或依次回退到默认模型和首个模型。 */
export function selectAvailableModel(
  current: ModelRef | null,
  preferred: ModelRef | null,
  available: readonly ModelRef[],
): ModelRef | null {
  if (current && available.some((model) => modelRefsEqual(model, current))) {
    return current;
  }
  if (
    preferred &&
    available.some((model) => modelRefsEqual(model, preferred))
  ) {
    return preferred;
  }
  return available[0] ?? null;
}
