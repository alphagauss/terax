/**
 * 本文件验证统一模型引用、Provider 实例解析和模型能力元数据。
 * 测试锁定自定义 Provider 必须精确解析，未知实例不得静默回退。
 */

import { describe, expect, it } from "vitest";
import {
  builtinProviderId,
  getModelContextLimit,
  isModelRefAvailable,
  isProviderInstance,
  type ModelRef,
  modelRefForProvider,
  modelRefKey,
  modelRefsEqual,
  modelKeepsReasoning,
  modelNeedsKey,
  modelSupportsTemperature,
  modelUsesReasoningTokens,
  MODEL_PRICING,
  resolveModel,
  type ProviderInstance,
} from "./config";

const providerInstance: ProviderInstance = {
  id: "custom:123e4567-e89b-42d3-a456-426614174000",
  protocol: "openai-compatible",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
  contextLimit: 64_000,
};
const customModelId = "llama-3.3-70b";

describe("model references", () => {
  it("keeps provider instances and model names as separate identity fields", () => {
    const ref = modelRefForProvider("openai", "gpt-5.4-mini");
    expect(ref).toEqual({
      providerId: builtinProviderId("openai"),
      modelId: "gpt-5.4-mini",
    });
  });

  it("compares and keys the complete structured identity", () => {
    const ref = modelRefForProvider("openai", "gpt-5.4-mini");
    expect(modelRefsEqual(ref, { ...ref })).toBe(true);
    expect(modelRefKey(ref)).not.toBe(
      modelRefKey({ ...ref, providerId: builtinProviderId("openrouter") }),
    );
  });
});
describe("resolveModel", () => {
  it("resolves a model through its custom provider instance", () => {
    const ref: ModelRef = {
      providerId: providerInstance.id,
      modelId: customModelId,
    };
    const info = resolveModel(ref, [providerInstance]);
    expect(info.provider).toBe("openai-compatible");
    expect(info.providerId).toBe(providerInstance.id);
    expect(info.id).toBe(customModelId);
    expect(info.baseURL).toBe(providerInstance.baseURL);
    expect(info.catalogModel).toBe(false);
    expect(
      isModelRefAvailable(ref, [providerInstance], {
        [providerInstance.id]: customModelId,
      }),
    ).toBe(true);
  });

  it("separates connection resolution from the configured selectable model", () => {
    const alternate = {
      providerId: providerInstance.id,
      modelId: "other-model",
    };
    expect(resolveModel(alternate, [providerInstance]).id).toBe("other-model");
    expect(isModelRefAvailable(alternate, [providerInstance])).toBe(false);
  });

  it("rejects a missing provider instance", () => {
    expect(() =>
      resolveModel({ providerId: "custom:missing", modelId: "model" }, []),
    ).toThrow("Unknown provider instance");
  });

  it("does not require a built-in key for a custom provider model", () => {
    expect(
      modelNeedsKey(
        {
          providerId: providerInstance.id,
          modelId: customModelId,
        },
        [providerInstance],
      ),
    ).toBe(false);
  });

  it("resolves a built-in model from the registry", () => {
    expect(
      resolveModel(modelRefForProvider("openai", "gpt-5.4-mini")).provider,
    ).toBe("openai");
    expect(
      resolveModel(modelRefForProvider("openai", "gpt-5.4-mini")).catalogModel,
    ).toBe(true);
  });

  it.each([
    ["gpt-5.6", "openai"],
    ["gpt-5.6-terra", "openai"],
    ["gpt-5.6-luna", "openai"],
    ["claude-fable-5", "anthropic"],
    ["claude-sonnet-5", "anthropic"],
    ["grok-4.5", "xai"],
  ] as const)("resolves current model %s through %s", (modelId, provider) => {
    expect(resolveModel(modelRefForProvider(provider, modelId)).provider).toBe(
      provider,
    );
  });

  it("throws on an unknown static model id", () => {
    expect(() =>
      resolveModel(modelRefForProvider("openai", "nope-not-real")),
    ).toThrow();
  });

  it("keeps freeform model identity tied to its saved provider model", () => {
    const ref = modelRefForProvider("ollama", "qwen2.5-coder:7b");
    const info = resolveModel(ref);
    expect(info.catalogModel).toBe(false);
    expect(info.contextLimit).toBe(32_000);
    expect(
      isModelRefAvailable(ref, [], {
        [ref.providerId]: "qwen2.5-coder:7b",
      }),
    ).toBe(true);
    expect(
      isModelRefAvailable(ref, [], { [ref.providerId]: "other-model" }),
    ).toBe(false);
  });
});

describe("provider instances", () => {
  it("accepts only complete app-generated provider identities", () => {
    expect(isProviderInstance(providerInstance)).toBe(true);
    expect(
      isProviderInstance({ ...providerInstance, id: "custom:short" }),
    ).toBe(false);
    expect(
      isProviderInstance({ ...providerInstance, contextLimit: Number.NaN }),
    ).toBe(false);
  });
});

describe("getModelContextLimit", () => {
  it("uses the per-provider override for custom models", () => {
    expect(
      getModelContextLimit(customModelId, providerInstance.contextLimit),
    ).toBe(64_000);
  });

  it("reads the static table for known models", () => {
    expect(getModelContextLimit("claude-opus-4-7")).toBe(1_000_000);
  });

  it.each([
    ["gpt-5.6", 1_050_000],
    ["gpt-5.6-terra", 1_050_000],
    ["gpt-5.6-luna", 1_050_000],
    ["claude-fable-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["grok-4.5", 500_000],
  ] as const)("uses the published context limit for %s", (modelId, limit) => {
    expect(getModelContextLimit(modelId)).toBe(limit);
  });
});

describe("current model pricing", () => {
  it.each([
    ["gpt-5.6", 5, 30, 0.5],
    ["gpt-5.6-terra", 2.5, 15, 0.25],
    ["gpt-5.6-luna", 1, 6, 0.1],
    ["claude-fable-5", 10, 50, 1],
    ["claude-sonnet-5", 3, 15, 0.3],
    ["grok-4.5", 2, 6, 0.5],
  ] as const)(
    "uses the published token pricing for %s",
    (modelId, input, output, cacheRead) => {
      expect(MODEL_PRICING[modelId]).toEqual({ input, output, cacheRead });
    },
  );
});

describe("modelKeepsReasoning", () => {
  it("keeps reasoning for custom freeform providers", () => {
    const info = resolveModel(
      { providerId: providerInstance.id, modelId: customModelId },
      [providerInstance],
    );
    expect(modelKeepsReasoning(info)).toBe(true);
  });

  it("drops reasoning for plain non-reasoning models", () => {
    expect(
      modelKeepsReasoning(
        resolveModel(modelRefForProvider("openai", "gpt-5.4-mini")),
      ),
    ).toBe(false);
  });

  it("keeps reasoning for tagged reasoning models", () => {
    expect(
      modelKeepsReasoning(
        resolveModel(modelRefForProvider("anthropic", "claude-opus-4-7")),
      ),
    ).toBe(true);
  });
});

describe("model sampling capabilities", () => {
  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6"],
    ["anthropic", "claude-fable-5"],
    ["anthropic", "claude-sonnet-5"],
  ] as const)("omits temperature for %s/%s", (provider, modelId) => {
    expect(modelSupportsTemperature(provider, modelId)).toBe(false);
  });

  it("keeps temperature for models that accept sampling parameters", () => {
    expect(modelSupportsTemperature("openai", "gpt-4.1-mini")).toBe(true);
    expect(modelSupportsTemperature("xai", "grok-4.5")).toBe(true);
  });

  it("defaults unknown provider models to temperature support", () => {
    expect(modelSupportsTemperature("openai-compatible", "custom-model")).toBe(
      true,
    );
  });

  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6-luna"],
    ["anthropic", "claude-sonnet-5"],
    ["xai", "grok-4.5"],
    ["groq", "openai/gpt-oss-20b"],
  ] as const)(
    "allocates a reasoning output budget for %s/%s",
    (provider, modelId) => {
      expect(modelUsesReasoningTokens(provider, modelId)).toBe(true);
    },
  );
});
