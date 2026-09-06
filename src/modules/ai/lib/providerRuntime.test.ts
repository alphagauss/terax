/**
 * 本文件验证真实 SDK 工厂通过原生 HTTP 发起请求，目录和推理保持相同连接身份。
 * 使用原生事件替身锁定错误正文、流式文本与工具调用的跨 IPC 解析，不访问外网。
 */
import {
  createProviderConnection,
  type ProviderId,
} from "@/modules/ai/providerRegistry";
import { ModelCatalog } from "@/modules/ai/lib/modelCatalog";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { transcribeAudio } from "@/modules/ai/lib/stt";
import {
  buildLanguageModel,
  createProviderDownload,
} from "@/modules/ai/lib/providerRuntime";
import { generateText, streamText } from "ai";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), body: "", status: 401 }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
  invoke: native.invoke,
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("WebView fetch must not be used");
    }),
  );
  native.status = 401;
  native.body = JSON.stringify({
    error: { message: "credential rejected", type: "authentication_error" },
  });
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command, args) => {
    if (command !== "http_request") return;
    const send = args.onEvent.onmessage;
    send({ kind: "started" });
    send({
      kind: "headers",
      status: native.status,
      headers: {
        "content-type":
          native.status === 200 ? "text/event-stream" : "application/json",
      },
    });
    // 任意字节边界拆分，覆盖多字节文本和 SSE 记录跨 IPC 消息的情况。
    const bytes = new TextEncoder().encode(native.body);
    for (let offset = 0; offset < bytes.length; offset += 7)
      send({
        kind: "chunk",
        bytes: Array.from(bytes.slice(offset, offset + 7)),
      });
    send({ kind: "end" });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("provider native transport", () => {
  it("preserves multipart audio and the speech service route across native IPC", async () => {
    native.status = 200;
    native.body = "transcript";
    const audio = new Blob([new Uint8Array([0, 128, 255])], {
      type: "audio/webm",
    });
    expect(
      await transcribeAudio(audio, "groq", {
        ...EMPTY_PROVIDER_KEYS,
        groq: "test-key",
      }),
    ).toBe("transcript");
    const request = native.invoke.mock.calls[0][1];
    const form = await new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: Uint8Array.from(request.body),
    }).formData();
    expect(
      new Uint8Array(await (form.get("file") as File).arrayBuffer()),
    ).toEqual(new Uint8Array([0, 128, 255]));
    expect(request.networkTarget).toEqual({ kind: "speech", id: "groq" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each<ProviderId>([
    "openai",
    "anthropic",
    "google",
    "xai",
    "cerebras",
    "groq",
    "openai-compatible",
  ])(
    "routes %s SDK requests and catalog through the same connection",
    async (provider) => {
      const connection = createProviderConnection({
        provider,
        instanceId: `test:${provider}`,
        credentialValue: "test-key",
        baseURL: "http://127.0.0.1:1234/v1",
      });
      const model = await buildLanguageModel(connection, "test-model");
      await expect(
        generateText({ model, prompt: "hello", maxRetries: 0 }),
      ).rejects.toMatchObject({ statusCode: 401 });
      await expect(new ModelCatalog().list(connection)).rejects.toMatchObject({
        kind: "auth",
      });
      expect(native.invoke).toHaveBeenCalledTimes(2);
      for (const [, args] of native.invoke.mock.calls) {
        expect(args.networkTarget).toEqual({
          kind: "provider",
          id: connection.instanceId,
        });
        expect(args.allowPrivateNetwork).toBe(connection.allowPrivateNetwork);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("downloads unsupported remote attachments with the provider route and public-address restrictions", async () => {
    native.status = 200;
    native.body = "attachment";
    const download = createProviderDownload("custom:local-model");
    const result = await download([
      {
        url: new URL("https://example.com/file"),
        isUrlSupportedByModel: false,
      },
    ]);
    expect(result[0]?.data).toEqual(new TextEncoder().encode("attachment"));
    expect(native.invoke.mock.calls[0][1]).toMatchObject({
      networkTarget: { kind: "provider", id: "custom:local-model" },
      allowPrivateNetwork: false,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("parses OpenAI response text and tools after chunked native delivery", async () => {
    native.status = 200;
    native.body = [
      {
        type: "response.created",
        response: { id: "resp", created_at: 1, model: "test-model" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg" },
      },
      { type: "response.output_text.delta", item_id: "msg", delta: "你好" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc",
          call_id: "call",
          name: "lookup",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc",
        output_index: 1,
        delta: '{"query":"test"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc",
          call_id: "call",
          name: "lookup",
          arguments: '{"query":"test"}',
          status: "completed",
        },
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 2 } },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const model = await buildLanguageModel(
      createProviderConnection({
        provider: "openai",
        instanceId: "builtin:openai",
        credentialValue: "test-key",
      }),
      "test-model",
    );
    const result = streamText({
      model,
      prompt: "hello",
      maxRetries: 0,
      tools: { lookup: { inputSchema: z.object({ query: z.string() }) } },
    });
    expect(await result.text).toBe("你好");
    expect(await result.toolCalls).toMatchObject([
      { toolCallId: "call", toolName: "lookup", input: { query: "test" } },
    ]);
  });
});
