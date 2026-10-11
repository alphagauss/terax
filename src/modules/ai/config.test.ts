/**
 * 本文件验证动态模型引用和统一 Provider 实例解析。
 * 重点锁定模型可用性来自用户配置，连接细节来自注册表或自定义实例。
 */

import { describe, expect, it } from "vitest";
import {
  builtinProviderId,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  getModelContextWindow,
  isModelRefAvailable,
  isProviderInstance,
  type ModelRef,
  modelRefForProvider,
  modelRefKey,
  modelRefsEqual,
  modelRequiresCredential,
  normalizeConfiguredModels,
  parseModelContextWindow,
  type ProviderInstance,
  type ProviderModels,
  resolveModel,
  resolveProviderInstance,
} from "./config";

const customProvider: ProviderInstance = {
  id: "custom:123e4567-e89b-42d3-a456-426614174000",
  protocol: "openai-compatible",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
};

const configured = (providerId: string, ...ids: string[]): ProviderModels => ({
  [providerId]: ids.map((id) => ({
    id,
    source: "manual",
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
  })),
});

describe("model references", () => {
  it("keeps provider instances and model IDs as explicit identity", () => {
    const ref = modelRefForProvider("openai", "future-model");
    expect(ref).toEqual({
      providerId: builtinProviderId("openai"),
      modelId: "future-model",
    });
    expect(modelRefsEqual(ref, { ...ref })).toBe(true);
    expect(modelRefKey(ref)).not.toBe(
      modelRefKey({ ...ref, providerId: builtinProviderId("openrouter") }),
    );
  });

  it("accepts arbitrary configured model IDs for built-in and custom providers", () => {
    const builtIn = modelRefForProvider("openai", "newly-released-model");
    const custom: ModelRef = {
      providerId: customProvider.id,
      modelId: "private-model",
    };
    expect(resolveModel(builtIn).provider).toBe("openai");
    expect(
      resolveModel(custom, { customProviders: [customProvider] }),
    ).toMatchObject({
      provider: "openai-compatible",
      baseURL: customProvider.baseURL,
    });
    expect(
      isModelRefAvailable(
        custom,
        configured(custom.providerId, custom.modelId),
        { customProviders: [customProvider] },
      ),
    ).toBe(true);
  });

  it("rejects missing instances and models that were not added", () => {
    const missing = { providerId: "custom:missing", modelId: "model" };
    expect(() => resolveModel(missing)).toThrow("Unknown provider instance");
    expect(
      isModelRefAvailable(modelRefForProvider("openai", "not-added"), {}),
    ).toBe(false);
  });

  it("normalizes configured models at the persistence boundary", () => {
    expect(
      normalizeConfiguredModels([
        { id: " model-a ", source: "manual" },
        { id: "model-a", source: "discovered" },
        { id: "bad\nmodel", source: "manual" },
        { id: "model-b", source: "unknown" },
      ]),
    ).toEqual([
      {
        id: "model-a",
        source: "manual",
        contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      },
    ]);
  });

  it("normalizes and resolves per-model context windows", () => {
    const providerId = builtinProviderId("openai");
    const models = normalizeConfiguredModels([
      { id: "default-window", source: "manual" },
      { id: "large-window", source: "discovered", contextWindow: 500_000 },
      { id: "invalid-window", source: "manual", contextWindow: -1 },
    ]);
    const providerModels = { [providerId]: models };

    expect(
      getModelContextWindow(
        { providerId, modelId: "default-window" },
        providerModels,
      ),
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(
      getModelContextWindow(
        { providerId, modelId: "large-window" },
        providerModels,
      ),
    ).toBe(500_000);
    expect(models[2].contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(parseModelContextWindow("250k")).toBe(250_000);
    expect(parseModelContextWindow("1.5m")).toBe(1_500_000);
    expect(parseModelContextWindow("999")).toBeNull();
  });
});

describe("provider connections", () => {
  it("resolves registry defaults, user address overrides and credential policy", () => {
    expect(resolveProviderInstance(builtinProviderId("lmstudio")).baseURL).toBe(
      "http://localhost:1234/v1",
    );
    expect(
      resolveProviderInstance(builtinProviderId("lmstudio"), {
        providerBaseURLs: { lmstudio: "http://127.0.0.1:9000/v1" },
      }).baseURL,
    ).toBe("http://127.0.0.1:9000/v1");
    expect(
      modelRequiresCredential(modelRefForProvider("openai", "model")),
    ).toBe(true);
    expect(
      modelRequiresCredential(
        { providerId: customProvider.id, modelId: "model" },
        { customProviders: [customProvider] },
      ),
    ).toBe(false);
  });

  it("validates custom Provider instance identity", () => {
    expect(isProviderInstance(customProvider)).toBe(true);
    expect(isProviderInstance({ ...customProvider, id: "custom:short" })).toBe(
      false,
    );
  });
});

describe("provider address overrides", () => {
  it("keeps cloud credentials and private-network policy when overriding or resetting the endpoint", () => {
    const connection = resolveProviderInstance("builtin:openai", {
      providerBaseURLs: { openai: " https://gateway.example/v1 " },
      providerCredentials: { openai: "test-key" },
    });
    expect(connection).toMatchObject({
      instanceId: "builtin:openai",
      baseURL: "https://gateway.example/v1",
      allowPrivateNetwork: false,
      credential: { value: "test-key", required: true },
      runtime: { adapter: "openai" },
    });
    const reset = resolveProviderInstance("builtin:openai", {
      providerBaseURLs: { openai: "  " },
    });
    expect(reset.baseURL).toBe("https://api.openai.com/v1");
    expect(connection.baseURL).toBe("https://gateway.example/v1");
    expect(
      resolveProviderInstance("builtin:lmstudio").allowPrivateNetwork,
    ).toBe(true);
  });
});
