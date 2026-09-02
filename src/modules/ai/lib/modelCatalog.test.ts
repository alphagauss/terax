/**
 * 本文件测试动态模型目录的协议适配、缓存和失败分类。
 * 重点锁定密钥不进入缓存身份、并发请求合并及手动刷新绕过缓存。
 */

import { describe, expect, it, vi } from "vitest";
import { createProviderConnection } from "../providerRegistry";
import {
  buildModelCatalogRequest,
  ModelCatalog,
  type ModelCatalogError,
  parseModelCatalogPage,
} from "./modelCatalog";

const openaiConnection = createProviderConnection({
  instanceId: "builtin:openai",
  provider: "openai" as const,
  credentialValue: "secret",
});

describe("model catalog protocol adapters", () => {
  it("uses provider-specific authentication and response shapes", () => {
    expect(buildModelCatalogRequest(openaiConnection)).toMatchObject({
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: "Bearer secret" },
      allowPrivateNetwork: false,
    });
    expect(
      buildModelCatalogRequest(
        createProviderConnection({
          instanceId: "builtin:anthropic",
          provider: "anthropic",
          credentialValue: "secret",
        }),
      ).headers,
    ).toMatchObject({
      "anthropic-version": "2023-06-01",
      "x-api-key": "secret",
    });
    expect(
      buildModelCatalogRequest(
        createProviderConnection({
          instanceId: "custom:test",
          provider: "openai-compatible",
          baseURL: "http://localhost:1234/v1/",
        }),
      ),
    ).toMatchObject({
      url: "http://localhost:1234/v1/models",
      allowPrivateNetwork: true,
    });
    const google = new URL(
      buildModelCatalogRequest(
        createProviderConnection({
          instanceId: "builtin:google",
          provider: "google",
          credentialValue: "secret",
        }),
        "next",
      ).url,
    );
    expect(Object.fromEntries(google.searchParams)).toMatchObject({
      key: "secret",
      pageSize: "1000",
      pageToken: "next",
    });
  });

  it("normalizes the supported catalog response shapes", () => {
    expect(
      parseModelCatalogPage("openai", {
        data: [{ id: "model-a" }, { id: "model-b" }],
      }).models,
    ).toEqual(["model-a", "model-b"]);
    expect(
      parseModelCatalogPage("google", {
        models: [{ name: "models/gemini-test", inputTokenLimit: 32_000 }],
      }).models,
    ).toEqual(["gemini-test"]);
    expect(
      parseModelCatalogPage("xai", {
        models: [{ id: "grok-test", output_modalities: ["text"] }],
      }).models,
    ).toEqual(["grok-test"]);
    expect(
      parseModelCatalogPage("anthropic", {
        data: [{ id: "claude-test" }],
        has_more: true,
        last_id: "claude-test",
      }),
    ).toEqual({ models: ["claude-test"], nextPageToken: "claude-test" });
    expect(
      parseModelCatalogPage("openai", [{ id: "mistral-test" }]).models,
    ).toEqual(["mistral-test"]);
  });

  it.each([
    ["xai", "https://api.x.ai/v1/language-models"],
    ["cerebras", "https://api.cerebras.ai/v1/models"],
    ["groq", "https://api.groq.com/openai/v1/models"],
    ["deepseek", "https://api.deepseek.com/models"],
    ["mistral", "https://api.mistral.ai/v1/models"],
    ["openrouter", "https://openrouter.ai/api/v1/models"],
  ] as const)("uses the official %s catalog endpoint", (provider, url) => {
    expect(
      buildModelCatalogRequest(
        createProviderConnection({
          instanceId: `builtin:${provider}`,
          provider,
          credentialValue: "secret",
        }),
      ).url,
    ).toBe(url);
  });
});

describe("ModelCatalog", () => {
  it("deduplicates active requests, caches success, and refreshes explicitly", async () => {
    let now = 1;
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: Array.from(new TextEncoder().encode('{"data":[{"id":"model-a"}]}')),
    }));
    const catalog = new ModelCatalog(request, () => now);

    const first = catalog.list(openaiConnection);
    const concurrent = catalog.list(openaiConnection);
    expect(first).toBe(concurrent);
    await expect(first).resolves.toEqual(["model-a"]);
    await catalog.list(openaiConnection);
    expect(request).toHaveBeenCalledTimes(1);

    now += 1;
    await catalog.list(openaiConnection, true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("classifies authentication failures without caching them", async () => {
    const request = vi.fn(async () => ({
      status: 401,
      headers: {},
      body: [],
    }));
    const catalog = new ModelCatalog(request);

    await expect(catalog.list(openaiConnection)).rejects.toMatchObject({
      kind: "auth",
    } satisfies Partial<ModelCatalogError>);
    await expect(catalog.list(openaiConnection)).rejects.toMatchObject({
      kind: "auth",
    } satisfies Partial<ModelCatalogError>);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("isolates an active request after credentials are invalidated", async () => {
    let finishOld!: (value: {
      status: number;
      headers: Record<string, string>;
      body: number[];
    }) => void;
    const response = (id: string) => ({
      status: 200,
      headers: {},
      body: Array.from(new TextEncoder().encode(`{"data":[{"id":"${id}"}]}`)),
    });
    const oldRequest = new Promise<ReturnType<typeof response>>((resolve) => {
      finishOld = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(() => oldRequest)
      .mockResolvedValueOnce(response("new-model"));
    const catalog = new ModelCatalog(request);

    const stale = catalog.list(openaiConnection);
    catalog.invalidate(openaiConnection.instanceId);
    await expect(catalog.list(openaiConnection)).resolves.toEqual([
      "new-model",
    ]);
    finishOld(response("old-model"));
    await stale;
    await expect(catalog.list(openaiConnection)).resolves.toEqual([
      "new-model",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
