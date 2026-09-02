/**
 * 本文件测试聊天模型可用性计算。
 * 锁定密钥、连接地址和模型 ID 共同决定选择器候选项的业务边界。
 */

import { describe, expect, it } from "vitest";
import {
  builtinProviderId,
  type ConfiguredModel,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  type ProviderInstance,
} from "../config";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import {
  getAvailableModelRefs,
  selectAvailableModel,
} from "./modelAvailability";

const baseConfig = {
  apiKeys: EMPTY_PROVIDER_KEYS,
  providerModels: {},
  providerBaseURLs: {},
  customProviders: [],
};

const configuredModel = (
  id: string,
  source: ConfiguredModel["source"],
): ConfiguredModel => ({
  id,
  source,
  contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
});

describe("getAvailableModelRefs", () => {
  it("returns no models when no provider is configured", () => {
    expect(getAvailableModelRefs(baseConfig)).toEqual([]);
  });

  it("includes only cloud providers with complete required configuration", () => {
    const refs = getAvailableModelRefs({
      ...baseConfig,
      apiKeys: {
        ...EMPTY_PROVIDER_KEYS,
        anthropic: "configured",
        openrouter: "configured",
      },
      providerModels: {
        [builtinProviderId("anthropic")]: [
          configuredModel("claude-current", "discovered"),
        ],
        [builtinProviderId("openrouter")]: [
          configuredModel("openai/current", "manual"),
        ],
      },
    });

    expect(
      refs.some((ref) => ref.providerId === builtinProviderId("openai")),
    ).toBe(false);
    expect(
      refs.some((ref) => ref.providerId === builtinProviderId("anthropic")),
    ).toBe(true);
    expect(refs).toContainEqual({
      providerId: builtinProviderId("openrouter"),
      modelId: "openai/current",
    });
  });

  it("returns every user-added model for a configured provider", () => {
    const refs = getAvailableModelRefs({
      ...baseConfig,
      apiKeys: { ...EMPTY_PROVIDER_KEYS, openai: "configured" },
      providerModels: {
        [builtinProviderId("openai")]: [
          configuredModel("model-a", "discovered"),
          configuredModel("model-b", "manual"),
        ],
      },
    });

    expect(refs).toEqual([
      { providerId: builtinProviderId("openai"), modelId: "model-a" },
      { providerId: builtinProviderId("openai"), modelId: "model-b" },
    ]);
  });

  it("requires both endpoint and model for local and custom providers", () => {
    const customProvider: ProviderInstance = {
      id: "custom:12345678-1234-4123-8123-123456789abc",
      protocol: "openai-compatible",
      name: "Custom",
      baseURL: "https://example.com/v1",
    };
    const refs = getAvailableModelRefs({
      ...baseConfig,
      providerBaseURLs: { lmstudio: "" },
      providerModels: {
        [builtinProviderId("lmstudio")]: [
          configuredModel("local-model", "manual"),
        ],
        [customProvider.id]: [configuredModel("custom-model", "discovered")],
      },
      customProviders: [customProvider],
    });

    expect(refs).toEqual([
      { providerId: customProvider.id, modelId: "custom-model" },
    ]);
  });
});

describe("selectAvailableModel", () => {
  it("falls back from an unavailable selection to the preferred or first model", () => {
    const unavailable = {
      providerId: builtinProviderId("openai"),
      modelId: "gpt-5.4-mini",
    };
    const first = {
      providerId: builtinProviderId("anthropic"),
      modelId: "claude-sonnet-5",
    };
    const preferred = {
      providerId: builtinProviderId("google"),
      modelId: "gemini-3.5-flash",
    };

    expect(
      selectAvailableModel(unavailable, preferred, [first, preferred]),
    ).toBe(preferred);
    expect(selectAvailableModel(unavailable, unavailable, [first])).toBe(first);
    expect(selectAvailableModel(unavailable, unavailable, [])).toBeNull();
  });
});
