import { expect, it } from "vitest";
import { streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createContextUsage } from "./contextUsage";
import { releaseUsage, usageRecords } from "./usageRuntime";

it("retains provider usage when cancelled while a tool is still running", async () => {
  const id = "usage-tool-cancel";
  const controller = new AbortController();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const tools = {
    wait: tool({
      inputSchema: z.object({}),
      execute: async () => {
        entered();
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return "cancelled";
      },
    }),
  };
  const tracker = await createContextUsage({
    sessionId: id,
    turnId: "turn",
    model: { providerId: "mock", modelId: "mock" },
    contextWindow: 10000,
    instructions: "test",
    tools,
  });
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(stream) {
          stream.enqueue({ type: "stream-start", warnings: [] });
          stream.enqueue({
            type: "tool-call",
            toolCallId: "wait",
            toolName: "wait",
            input: "{}",
          });
          stream.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: {
                total: 123,
                noCache: 23,
                cacheRead: 100,
                cacheWrite: undefined,
              },
              outputTokens: { total: 4, text: 4, reasoning: 0 },
            },
          });
          stream.close();
        },
      }),
    }),
  });
  const result = streamText({
    model,
    tools,
    messages: [{ role: "user", content: "Wait" }],
    abortSignal: controller.signal,
    prepareStep: tracker.prepareStep,
    onLanguageModelCallEnd: (event) =>
      tracker.finish(event.usage, event.content, event.performance),
  });
  const consuming = (async () => {
    for await (const chunk of result.stream) tracker.observe(chunk);
    tracker.finish();
  })();
  try {
    await running;
    // 完成回调与工具启动可交错；等实际用量到达后模拟工具执行期间的取消。
    const started = Date.now();
    while (!usageRecords(id).length) {
      if (Date.now() - started > 2000)
        throw new Error("Usage was not delivered before the tool completed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await consuming;
    expect(usageRecords(id)).toHaveLength(1);
    expect(usageRecords(id)[0].timing?.responseTimeMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      usageRecords(id)[0].timing?.timeToFirstOutputMs,
    ).toBeGreaterThanOrEqual(0);
    expect(usageRecords(id)[0]).toMatchObject({
      values: { inputTokens: 123, cacheReadTokens: 100, outputTokens: 4 },
      estimated: [],
      toolCalls: 1,
    });
  } finally {
    controller.abort();
    await consuming;
    releaseUsage(id);
  }
});
