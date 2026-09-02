/**
 * 本文件按 Provider 注册表中的 runtime adapter 创建 AI SDK 模型。
 * 连接解析与凭据校验先于客户端创建，具体供应商不会进入 Agent 或编辑器调用链。
 */

import type { LanguageModel } from "ai";
import {
  type ModelRef,
  normalizeModelId,
  type ProviderBaseURLs,
  type ProviderInstance,
  resolveProviderInstance,
} from "../config";
import {
  getProvider,
  isProviderConnectionReady,
  type ResolvedProviderConnection,
  type RuntimeAdapterId,
} from "../providerRegistry";
import type { ProviderInstanceKeys, ProviderKeys } from "./keyring";
import { createProxyFetch } from "./proxyFetch";

const privateNetworkFetch = createProxyFetch({ allowPrivateNetwork: true });

type RuntimeFactory = (
  connection: ResolvedProviderConnection,
  modelId: string,
  apiKey: string | undefined,
) => Promise<LanguageModel>;

const RUNTIME_FACTORIES: Record<RuntimeAdapterId, RuntimeFactory> = {
  openai: async (connection, modelId, apiKey) => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey, baseURL: connection.baseURL })(modelId);
  },
  anthropic: async (connection, modelId, apiKey) => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey, baseURL: connection.baseURL })(modelId);
  },
  google: async (connection, modelId, apiKey) => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({
      apiKey,
      baseURL: connection.baseURL,
    })(modelId);
  },
  xai: async (connection, modelId, apiKey) => {
    const { createXai } = await import("@ai-sdk/xai");
    return createXai({ apiKey, baseURL: connection.baseURL })(modelId);
  },
  cerebras: async (connection, modelId, apiKey) => {
    const { createCerebras } = await import("@ai-sdk/cerebras");
    return createCerebras({ apiKey, baseURL: connection.baseURL })(modelId);
  },
  groq: async (connection, modelId, apiKey) => {
    const { createGroq } = await import("@ai-sdk/groq");
    return createGroq({ apiKey, baseURL: connection.baseURL })(modelId);
  },
  "openai-compatible": async (connection, modelId, apiKey) => {
    const { createOpenAICompatible } = await import(
      "@ai-sdk/openai-compatible"
    );
    return createOpenAICompatible({
      name: connection.provider,
      baseURL: connection.baseURL,
      apiKey,
      headers: connection.runtime.headers,
      fetch: connection.allowPrivateNetwork ? privateNetworkFetch : undefined,
    })(modelId);
  },
};

/** 根据统一连接创建语言模型，未就绪的连接在网络请求前失败。 */
export function buildLanguageModel(
  connection: ResolvedProviderConnection,
  modelId: string,
): Promise<LanguageModel> {
  const id = normalizeModelId(modelId);
  if (!id) throw new Error("Model ID is invalid");
  if (!isProviderConnectionReady(connection)) {
    const definition = getProvider(connection.provider);
    if (!connection.baseURL) {
      throw new Error(`${definition.label} has no base URL configured.`);
    }
    throw new Error(
      `No credential configured for ${definition.label}. Open Settings to add one.`,
    );
  }
  const apiKey =
    connection.credential.adapter === "api-key"
      ? (connection.credential.value ?? undefined)
      : undefined;
  return RUNTIME_FACTORIES[connection.runtime.adapter](connection, id, apiKey);
}

export type RuntimeProviderConfig = {
  providerBaseURLs?: Readonly<ProviderBaseURLs>;
  customProviders?: readonly ProviderInstance[];
  providerInstanceKeys?: ProviderInstanceKeys;
};

/** 解析模型引用和对应凭据后创建语言模型。 */
export function buildConfiguredLanguageModel(
  modelRef: ModelRef,
  keys: ProviderKeys,
  config: RuntimeProviderConfig = {},
): Promise<LanguageModel> {
  const connection = resolveProviderInstance(modelRef.providerId, {
    customProviders: config.customProviders,
    providerBaseURLs: config.providerBaseURLs,
    providerCredentials: keys,
    providerInstanceCredentials: config.providerInstanceKeys,
  });
  return buildLanguageModel(connection, modelRef.modelId);
}
