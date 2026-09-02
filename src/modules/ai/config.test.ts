/**
 * 本文件验证动态模型引用和统一 Provider 实例解析。
 * 重点锁定模型可用性来自用户配置，连接细节来自注册表或自定义实例。
 */

import { describe, expect, it } from "vitest";
import {
  builtinProviderId,
  isModelRefAvailable,
  isProviderInstance,
  type ModelRef,
  modelRefForProvider,
  modelRefKey,
  modelRefsEqual,
  modelRequiresCredential,
  normalizeConfiguredModels,
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
  [providerId]: ids.map((id) => ({ id, source: "manual" })),
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
    ).toEqual([{ id: "model-a", source: "manual" }]);
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
