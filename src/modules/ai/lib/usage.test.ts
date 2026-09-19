import { afterEach, describe, expect, it } from "vitest";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { createContextUsage } from "./contextUsage";
import { normalizeUsage, summarizeOutput } from "./usage";
import {
  acknowledgeUsage,
  pendingUsage,
  releaseUsage,
  restoreUsage,
  usageRecords,
} from "./usageRuntime";
import {
  projectSessionMessages,
  convertToAgentModelMessages,
} from "./conversation";

const sessionId = "usage-test";
const model = { providerId: "test", modelId: "model-a" };
const options = {
  sessionId,
  turnId: "turn-1",
  model,
  contextWindow: 100_000,
  instructions: "系统提示",
};
const usage: LanguageModelUsage = {
  inputTokens: 1000,
  inputTokenDetails: {
    noCacheTokens: 200,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
  },
  outputTokens: 100,
  outputTokenDetails: { textTokens: 60, reasoningTokens: 40 },
  totalTokens: 1100,
  raw: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 40 },
  },
};
const messages: ModelMessage[] = [{ role: "user", content: "请分析中文内容" }];
afterEach(() => releaseUsage(sessionId));

describe("request usage", () => {
  it("retains supported fields without collecting cache writes or raw payloads", () => {
    expect(normalizeUsage(usage, 1, 2)).toMatchObject({
      estimated: [],
      values: { cacheReadTokens: 700, inputTokens: 1000, outputTokens: 100 },
    });
    expect(normalizeUsage(usage, 1, 2).values).not.toHaveProperty(
      "cacheWriteTokens",
    );
    expect(normalizeUsage(usage, 1, 2)).not.toHaveProperty("raw");
    const missing = normalizeUsage(undefined, 80, 8);
    expect(missing.values).toMatchObject({
      inputTokens: 80,
      outputTokens: 8,
    });
    expect(missing.values.cacheReadTokens).toBeUndefined();
    expect(missing.estimated).toEqual(["inputTokens", "outputTokens"]);
  });

  it("does not mistake SDK default zeroes for provider-reported cache or reasoning usage", () => {
    const normalized = normalizeUsage(
      {
        ...usage,
        raw: { prompt_tokens: 1000, completion_tokens: 100 },
        inputTokenDetails: {
          noCacheTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
      },
      1,
      1,
    );
    expect(normalized.values).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(normalized.values.cacheReadTokens).toBeUndefined();
    expect(normalized.values).not.toHaveProperty("reasoningTokens");
    expect(normalized.values).not.toHaveProperty("textTokens");
  });

  it("trusts SDK positive cache usage even for a provider-specific raw shape", () => {
    expect(
      normalizeUsage(
        {
          ...usage,
          raw: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            custom_cache: 700,
          },
        },
        1,
        2,
      ).values.cacheReadTokens,
    ).toBe(700);
    expect(
      normalizeUsage(
        {
          ...usage,
          inputTokenDetails: { ...usage.inputTokenDetails, cacheReadTokens: 0 },
          raw: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
        1,
        2,
      ).values.cacheReadTokens,
    ).toBe(0);
  });

  it("counts each main and child request once, restores facts without model pollution", async () => {
    const root = await createContextUsage(options);
    await root.prepareStep({ messages });
    root.finish(usage);
    root.finish(usage);
    const child = await createContextUsage({ ...options, taskId: "task-1" });
    await child.prepareStep({ messages });
    child.finish(usage);
    const batch = pendingUsage(sessionId, new Date().toISOString());
    expect(batch).toHaveLength(2);
    acknowledgeUsage(sessionId, batch.length);
    expect(pendingUsage(sessionId, "")).toHaveLength(0);
    releaseUsage(sessionId);
    restoreUsage(sessionId, JSON.parse(JSON.stringify(batch)));
    const restored = usageRecords(sessionId);
    expect(summarizeOutput(restored).outputTokens).toBe(200);
    expect(restored.filter((record) => !record.taskId)).toHaveLength(1);
    expect(
      await convertToAgentModelMessages(
        projectSessionMessages(sessionId, batch),
      ),
    ).toEqual([]);
  });

  it("preserves completed usage and estimates an interrupted request including tool arguments", async () => {
    const tracker = await createContextUsage(options);
    await tracker.prepareStep({ messages });
    tracker.finish(usage);
    await tracker.prepareStep({
      messages: [...messages, { role: "assistant", content: "分析结果" }],
    });
    tracker.observe({ type: "text-delta", text: "中断前的内容" });
    tracker.observe({
      type: "tool-input-delta",
      id: "call",
      delta: '{"path":',
    });
    tracker.observe({
      type: "tool-call",
      toolCallId: "call",
      input: { path: "中文" },
    });
    tracker.observe({
      type: "tool-call",
      toolCallId: "call",
      input: { path: "中文" },
    });
    tracker.finish();
    const records = usageRecords(sessionId);
    expect(records).toHaveLength(2);
    expect(records[0].estimated).toEqual([]);
    expect(records[1].values.inputTokens).toBeGreaterThan(1000);
    expect(records[1].values.outputTokens).toBe(
      Math.ceil(
        ("中断前的内容".length + JSON.stringify({ path: "中文" }).length) * 0.8,
      ),
    );
    const summary = summarizeOutput(records);
    expect(records[0].toolCalls).toBe(0);
    expect(records[1].toolCalls).toBe(1);
    expect(summary.toolCalls).toBe(1);
    expect(summary.estimated).toBe(true);
  });

  it("restores the actual prefix baseline but invalidates it for a new model or changed history", async () => {
    const tracker = await createContextUsage(options);
    await tracker.prepareStep({ messages });
    tracker.finish(usage);
    const saved = pendingUsage(sessionId, "now");
    const run = async (modelId: string, input: ModelMessage[]) => {
      restoreUsage(sessionId, saved);
      const next = await createContextUsage({
        ...options,
        turnId: "turn-2",
        model: { ...model, modelId },
      });
      await next.prepareStep({ messages: input });
      next.finish();
      return usageRecords(sessionId)[1];
    };
    expect((await run("model-a", messages)).values.inputTokens).toBe(1000);
    expect((await run("model-b", messages)).values.inputTokens).toBeLessThan(
      1000,
    );
    expect(
      (await run("model-a", [{ role: "user", content: "改变的历史" }])).values
        .inputTokens,
    ).toBeLessThan(1000);
  });

  it("records oversized requests without trimming or rejecting the context", async () => {
    const tracker = await createContextUsage({
      ...options,
      contextWindow: 2000,
    });
    const history: ModelMessage[] = [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答".repeat(1000) },
      { role: "user", content: "当前问题" },
    ];
    expect((await tracker.prepareStep({ messages: history })).messages).toBe(
      history,
    );
    tracker.finish(usage);
    const oversized: ModelMessage[] = [
      { role: "user", content: "中文".repeat(3000) },
    ];
    expect((await tracker.prepareStep({ messages: oversized })).messages).toBe(
      oversized,
    );
    tracker.finish();
    expect(usageRecords(sessionId)).toHaveLength(2);
  });
});
