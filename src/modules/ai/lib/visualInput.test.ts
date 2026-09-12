import { APICallError, streamText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { withVisualInputFallback } from "@/modules/ai/lib/visualInput";

const messages: ModelMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "compare attachments/image.png" },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: new Uint8Array([1]) },
      },
      {
        type: "file",
        mediaType: "application/pdf",
        data: { type: "data", data: new Uint8Array([2]) },
      },
    ],
  },
];
const rejected = (
  message = "Model does not support image input",
  statusCode = 400,
) =>
  new APICallError({
    message,
    statusCode,
    url: "https://provider.test",
    requestBodyValues: {},
  });
function success(): Awaited<ReturnType<MockLanguageModelV4["doStream"]>> {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "text" });
        controller.enqueue({ type: "text-delta", id: "text", delta: "ok" });
        controller.enqueue({ type: "text-end", id: "text" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}
async function consume(
  model: ReturnType<typeof withVisualInputFallback>,
  input = messages,
) {
  const chunks = [];
  for await (const chunk of streamText({
    model,
    messages: input,
    maxRetries: 0,
    onError: () => {},
  }).stream)
    chunks.push(chunk);
  return chunks;
}

it("SDK start 后仍可降级一次，保留非图片内容与原消息，状态不跨模型实例", async () => {
  const doStream = vi
    .fn()
    .mockRejectedValueOnce(rejected())
    .mockImplementation(success);
  const raw = new MockLanguageModelV4({ doStream });
  const model = withVisualInputFallback(raw);
  const original = structuredClone(messages);
  const chunks = await consume(model);
  expect(chunks.filter((chunk) => chunk.type === "start")).toHaveLength(1);
  expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
  expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(true);
  expect(doStream).toHaveBeenCalledTimes(2);
  expect(raw.doStreamCalls[1].prompt[0]).toMatchObject({
    content: [
      { type: "text", text: "compare attachments/image.png" },
      { type: "text", text: expect.stringContaining("not delivered") },
      { type: "file", mediaType: "application/pdf" },
    ],
  });
  await consume(model);
  expect(raw.doStreamCalls[2].prompt).toEqual(raw.doStreamCalls[1].prompt);
  await consume(withVisualInputFallback(raw));
  expect(raw.doStreamCalls[3].prompt).toEqual(raw.doStreamCalls[0].prompt);
  expect(messages).toEqual(original);
});

it.each([
  ["Invalid image data", 400],
  ["Unsupported image format", 415],
  ["Model does not support image/png", 400],
  ["Model does not support image formats other than PNG", 400],
  ["Model does not support image input", 401],
  ["Model does not support image input", 500],
])("普通错误不触发降级：%s", async (message, status) => {
  const raw = new MockLanguageModelV4({
    doStream: async () => {
      throw rejected(message, status);
    },
  });
  const chunks = await consume(withVisualInputFallback(raw));
  expect(raw.doStreamCalls).toHaveLength(1);
  expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
});

it("降级失败不再重试，也不记住降级状态；无图请求不重试", async () => {
  const raw = new MockLanguageModelV4({
    doStream: async () => {
      throw rejected();
    },
  });
  const model = withVisualInputFallback(raw);
  await consume(model);
  expect(raw.doStreamCalls).toHaveLength(2);
  await consume(model);
  expect(raw.doStreamCalls).toHaveLength(4);
  expect(raw.doStreamCalls[2].prompt).toEqual(raw.doStreamCalls[0].prompt);
  await consume(model, [{ role: "user", content: "text" }]);
  expect(raw.doStreamCalls).toHaveLength(5);
});

it("流建立后的错误不重放模型请求", async () => {
  const raw = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "error", error: rejected() });
          controller.close();
        },
      }),
    }),
  });
  const chunks = await consume(withVisualInputFallback(raw));
  expect(raw.doStreamCalls).toHaveLength(1);
  expect(chunks.some((chunk) => chunk.type === "error")).toBe(true);
});
