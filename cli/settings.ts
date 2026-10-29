/**
 * 本文件读取终端 Agent 所需的现行共享配置与凭据。
 * 命令行选择只作用于本次运行，不修改桌面的全局默认模型或权限。
 */

import { readProviderBaseURLs } from "@/modules/ai/providerRegistry";

import type { ShellIdentity } from "@/modules/ai/lib/native";
import { readModelUsages } from "@/modules/ai/lib/modelUsage";

import i18n from "i18next";
import { invokeNative } from "@/lib/nativeHost";
import {
  clampAgentSteps,
  clampMaxConcurrentSubagents,
  isModelRef,
  isProviderInstance,
  modelRequiresCredential,
  normalizeConfiguredModels,
  normalizeMainAgentSteps,
  MAX_SUBAGENT_STEPS_DEFAULT,
  providerFromBuiltinId,
  type ModelRef,
  type ProviderModels,
} from "@/modules/ai/config";
import {
  getAllKeys,
  getAllProviderInstanceKeys,
} from "@/modules/ai/lib/keyring";
import { resolveAgentExecutionEnvironment } from "@/modules/ai/lib/prompt";
import en from "@/i18n/locales/en/tui.json";
import enAi from "@/i18n/locales/en/ai.json";
import zh from "@/i18n/locales/zh-CN/tui.json";
import zhAi from "@/i18n/locales/zh-CN/ai.json";

/** 从现有设置解析单次 Agent 配置；显式模型仍须属于已知 Provider 实例。 */
export async function loadTerminalSettings(modelOption?: string) {
  const settings = await invokeNative<Record<string, unknown>>(
    "shared_store_read",
    { store: "settings" },
  );
  await i18n.init({
    lng: settings.language === "en" ? "en" : "zh-CN",
    fallbackLng: "en",
    resources: {
      en: { translation: en, ai: enAi },
      "zh-CN": { translation: zh, ai: zhAi },
    },
    interpolation: { escapeValue: false },
  });
  const t = (key: keyof typeof en, values?: Record<string, string | number>) =>
    i18n.t(key, values);
  const customProviders = Array.isArray(settings.customProviders)
    ? settings.customProviders.filter(isProviderInstance)
    : [];
  const providerModels: ProviderModels = {};
  if (settings.providerModels && typeof settings.providerModels === "object") {
    for (const [id, models] of Object.entries(settings.providerModels))
      providerModels[id] = normalizeConfiguredModels(models);
  }
  const providerBaseURLs = readProviderBaseURLs(settings);
  let model: ModelRef | null = isModelRef(settings.defaultModel)
    ? settings.defaultModel
    : null;
  if (modelOption) {
    const separator = modelOption.indexOf("/");
    if (separator < 1 || separator === modelOption.length - 1)
      throw new Error(t("invalidModel"));
    const provider = modelOption.slice(0, separator);
    model = {
      providerId:
        provider.startsWith("builtin:") || provider.startsWith("custom:")
          ? provider
          : `builtin:${provider}`,
      modelId: modelOption.slice(separator + 1),
    };
  }
  if (!model) throw new Error(t("missingModel"));
  const selectedModel = model;
  const provider = providerFromBuiltinId(model.providerId);
  if (
    !provider &&
    !customProviders.some((item) => item.id === model.providerId)
  )
    throw new Error(t("invalidModel"));
  const [keys, instanceKeys] = await Promise.all([
    getAllKeys(),
    getAllProviderInstanceKeys(customProviders),
  ]);
  // 显式环境凭据仅驻留本次进程，不写回配置或命令行参数。
  if (process.env.TERAX_API_KEY) {
    if (provider) keys[provider] = process.env.TERAX_API_KEY;
    else instanceKeys[model.providerId] = process.env.TERAX_API_KEY;
  }
  if (
    modelRequiresCredential(model, { customProviders }) &&
    !(provider ? keys[provider] : instanceKeys[model.providerId])
  )
    throw new Error(t("missingKey"));
  const shells = await invokeNative<ShellIdentity[]>("shell_environment");
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux";
  const concurrency =
    typeof settings.maxConcurrentSubagents === "number"
      ? clampMaxConcurrentSubagents(settings.maxConcurrentSubagents)
      : 3;
  const maxAgentSteps = normalizeMainAgentSteps(
    typeof settings.maxAgentSteps === "number" ? settings.maxAgentSteps : null,
  );
  const maxSubagentSteps = clampAgentSteps(
    typeof settings.maxSubagentSteps === "number"
      ? settings.maxSubagentSteps
      : MAX_SUBAGENT_STEPS_DEFAULT,
    MAX_SUBAGENT_STEPS_DEFAULT,
  );
  return {
    t,
    model,
    configuration: {
      getKeys: () => keys,
      getModel: () => selectedModel,
      getEnvironment: () =>
        resolveAgentExecutionEnvironment({ kind: "local" }, platform, shells),
      getCustomInstructions: () =>
        typeof settings.customInstructions === "string"
          ? settings.customInstructions
          : "",
      getDefaultSubagentModel: () => readModelUsages(settings).subagent.model,
      getMaxConcurrentSubagents: () => concurrency,
      getMaxAgentSteps: () => maxAgentSteps,
      getMaxSubagentSteps: () => maxSubagentSteps,
      getProviderBaseURLs: () => providerBaseURLs,
      getProviderModels: () => providerModels,
      getCustomProviders: () => customProviders,
      getProviderInstanceKeys: () => instanceKeys,
    },
  };
}

export type TerminalText = Awaited<
  ReturnType<typeof loadTerminalSettings>
>["t"];
