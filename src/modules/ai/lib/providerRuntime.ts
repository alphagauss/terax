/**
 * 本文件按 Provider 注册表中的 runtime adapter 创建 AI SDK 模型。
 * 连接解析与凭据校验先于客户端创建，具体供应商不会进入 Agent 或编辑器调用链。
 */

import type { Experimental_DownloadFunction, LanguageModel } from "ai";
import {
  type ModelRef,
  normalizeModelId,
  type ProviderBaseURLs,
  type ProviderInstance,
  resolveProviderInstance,
} from "@/modules/ai/config";
import {
  getProvider,
  isProviderConnectionReady,
  type ResolvedProviderConnection,
  type RuntimeAdapterId,
} from "@/modules/ai/providerRegistry";
import type {
  ProviderInstanceKeys,
  ProviderKeys,
} from "@/modules/ai/lib/keyring";
import { createHttpFetch } from "@/lib/http";

/** SDK 需要本地下载远端附件时沿用 Provider 出口，但不继承模型服务器的私网权限。 */
export function createProviderDownload(
  providerId: string,
  signal?: AbortSignal,
): Experimental_DownloadFunction {
  const fetch = createHttpFetch({
    networkTarget: { kind: "provider", id: providerId },
    timeoutMs: 30_000,
    maxResponseBytes: 64 * 1024 * 1024,
  });
  return (downloads) =>
    Promise.all(
      downloads.map(async ({ url, isUrlSupportedByModel }) => {
        if (isUrlSupportedByModel) return null;
        const response = await fetch(url, { signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Attachment request failed (${response.status})`);
        }
        return {
          data: new Uint8Array(await response.arrayBuffer()),
          mediaType: response.headers.get("content-type") ?? undefined,
        };
      }),
    );
}

type RuntimeFactory = (
  connection: ResolvedProviderConnection,
  modelId: string,
  apiKey: string | undefined,
  fetch: typeof globalThis.fetch,
) => Promise<LanguageModel>;

const RUNTIME_FACTORIES: Record<RuntimeAdapterId, RuntimeFactory> = {
  openai: async (connection, modelId, apiKey, fetch) => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey, baseURL: connection.baseURL, fetch })(
      modelId,
    );
  },
  anthropic: async (connection, modelId, apiKey, fetch) => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey, baseURL: connection.baseURL, fetch })(
      modelId,
    );
  },
  google: async (connection, modelId, apiKey, fetch) => {
    const { createGoogle } = await import("@ai-sdk/google");
    return createGoogle({
      apiKey,
      fetch,
      baseURL: connection.baseURL,
    })(modelId);
  },
  xai: async (connection, modelId, apiKey, fetch) => {
    const { createXai } = await import("@ai-sdk/xai");
    return createXai({ apiKey, baseURL: connection.baseURL, fetch })(modelId);
  },
  cerebras: async (connection, modelId, apiKey, fetch) => {
    const { createCerebras } = await import("@ai-sdk/cerebras");
    return createCerebras({ apiKey, baseURL: connection.baseURL, fetch })(
      modelId,
    );
  },
  groq: async (connection, modelId, apiKey, fetch) => {
    const { createGroq } = await import("@ai-sdk/groq");
    return createGroq({ apiKey, baseURL: connection.baseURL, fetch })(modelId);
  },
  "openai-compatible": async (connection, modelId, apiKey, fetch) => {
    const { createOpenAICompatible } = await import(
      "@ai-sdk/openai-compatible"
    );
    return createOpenAICompatible({
      name: connection.provider,
      includeUsage: true,
      baseURL: connection.baseURL,
      apiKey,
      headers: connection.runtime.headers,
      fetch,
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
  return RUNTIME_FACTORIES[connection.runtime.adapter](
    connection,
    id,
    apiKey,
    createHttpFetch({
      networkTarget: { kind: "provider", id: connection.instanceId },
      allowPrivateNetwork: connection.allowPrivateNetwork,
      timeoutMs: null,
      maxResponseBytes: 64 * 1024 * 1024,
    }),
  );
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
