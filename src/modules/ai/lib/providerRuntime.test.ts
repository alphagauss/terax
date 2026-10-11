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
  buildParameterOptions,
  type ParameterAssignment,
} from "@/modules/ai/lib/modelParameters";
import { requestCompletion } from "@/modules/editor/lib/autocomplete/provider";
import {
  buildLanguageModel,
  createProviderDownload,
} from "@/modules/ai/lib/providerRuntime";
import { generateText, streamText, stepCountIs, type ModelMessage } from "ai";
import { normalizeUsage } from "@/modules/ai/lib/usage";
import {
  convertToAgentModelMessages,
  modelHistoryPart,
  serializeSessionMessages,
  projectSessionMessages,
} from "@/modules/ai/lib/conversation";
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
  it.each(["deepseek", "zhipu", "openai-compatible"] as const)(
    "serializes %s parameter selections through the real SDK",
    async (provider) => {
      native.status = 200;
      native.body = JSON.stringify({
        id: "completion",
        created: 1,
        model: "model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "return a + b" },
            finish_reason: "stop",
          },
        ],
      });
      const connection = createProviderConnection({
        provider,
        instanceId: "test:parameters",
        credentialValue: "test-key",
        baseURL: "https://gateway.example/v1",
      });
      const parameters: ParameterAssignment[] = [
        {
          target: "provider",
          path:
            provider !== "openai-compatible"
              ? "thinking.type"
              : "chat_template_kwargs.enable_thinking",
          value: provider !== "openai-compatible" ? "disabled" : false,
        },
        { target: "provider", path: "reasoning_effort", value: "medium" },
        { target: "provider", path: "reasoning.effort", value: "low" },
        { target: "provider", path: "parallel_tool_calls", value: false },
        { target: "standard", path: "temperature", value: 0.7 },
        {
          target: "provider",
          path: "custom_options.optional_value",
          value: null,
        },
      ];
      const model = await buildLanguageModel(connection, "model");
      await generateText({
        model,
        prompt: "hello",
        ...buildParameterOptions(
          parameters,
          connection.runtime.adapter,
          provider,
        ),
        maxRetries: 0,
      });
      expect(
        await requestCompletion(
          {
            prefix: "def add(a, b):\n    ",
            suffix: "",
            filename: "test.py",
            language: "python",
            indentUnit: "    ",
          },
          { connection, modelId: "model", parameters },
          new AbortController().signal,
        ),
      ).toBe("return a + b");
      for (const [, args] of native.invoke.mock.calls) {
        const body = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(args.body)),
        );
        expect(body.reasoning_effort).toBe("medium");
        expect(body.reasoning).toEqual({ effort: "low" });
        expect(body).not.toHaveProperty("reasoningEffort");
        expect(body.parallel_tool_calls).toBe(false);
        expect(body).not.toHaveProperty("parallelToolCalls");
        expect(body.temperature).toBe(0.7);
        expect(body.custom_options).toEqual({ optional_value: null });
        expect(
          provider !== "openai-compatible"
            ? body.thinking
            : body.chat_template_kwargs,
        ).toEqual(
          provider !== "openai-compatible"
            ? { type: "disabled" }
            : { enable_thinking: false },
        );
      }
    },
  );
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
        baseURL: "https://gateway.example/v1",
      });
      const model = await buildLanguageModel(connection, "test-model");
      await expect(
        generateText({ model, prompt: "hello", maxRetries: 0 }),
      ).rejects.toMatchObject({ statusCode: 401 });
      await expect(new ModelCatalog().list(connection)).rejects.toMatchObject({
        kind: "auth",
      });
      expect(native.invoke).toHaveBeenCalledTimes(2);
      if (provider === "xai") {
        expect(native.invoke.mock.calls[0][1].url).toBe(
          `${connection.baseURL}/responses`,
        );
      }
      for (const [, args] of native.invoke.mock.calls) {
        expect(args.url).toContain("https://gateway.example/v1/");
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

describe("Zhipu compatible protocol", () => {
  it("discovers models using the same authenticated native connection", async () => {
    native.status = 200;
    native.body = JSON.stringify({ data: [{ id: "glm-test" }] });
    const connection = createProviderConnection({
      provider: "zhipu",
      instanceId: "builtin:zhipu",
      credentialValue: "test-key",
    });
    expect(await new ModelCatalog().list(connection)).toEqual(["glm-test"]);
    const args = native.invoke.mock.calls[0][1];
    expect(args.url).toBe("https://open.bigmodel.cn/api/paas/v4/models");
    expect(args.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(args.networkTarget).toEqual({
      kind: "provider",
      id: "builtin:zhipu",
    });
    expect(args.allowPrivateNetwork).toBe(false);
  });

  it("replays streamed thinking and tool history without changing the prefix and normalizes reported cache usage", async () => {
    const deliver = native.invoke.getMockImplementation();
    if (!deliver) throw new Error("Native transport mock is not initialized");
    const bodies: Array<{
      messages: Array<{
        role: string;
        content: unknown;
        reasoning_content?: string;
      }>;
      thinking?: unknown;
      stream_options?: unknown;
    }> = [];
    native.status = 200;
    native.invoke.mockImplementation(async (command, args) => {
      const body = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(args.body)),
      );
      bodies.push(body);
      const first = bodies.length === 1;
      const usage = {
        prompt_tokens: first ? 100 : 160,
        completion_tokens: 12,
        ...(body.stream
          ? { prompt_tokens_details: { cached_tokens: first ? 0 : 80 } }
          : {}),
      };
      const reasoning = first ? "先查询工具。" : "依据工具结果回答。";
      if (body.stream) {
        const deltas = first
          ? [
              { reasoning_content: reasoning },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "lookup-1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"query":"test"}' },
                  },
                ],
              },
            ]
          : [
              { reasoning_content: reasoning },
              { content: "查询" },
              { content: "完成。" },
            ];
        native.body = [
          ...deltas.map((delta) => ({
            choices: [{ index: 0, delta, finish_reason: null }],
          })),
          {
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: first ? "tool_calls" : "stop",
              },
            ],
            usage,
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("")
          .concat("data: [DONE]\n\n");
      } else {
        native.body = JSON.stringify({
          id: "followup",
          created: 1,
          model: "glm-test",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "记得查询结果。",
                reasoning_content: reasoning,
              },
              finish_reason: "stop",
            },
          ],
          usage,
        });
      }
      return deliver(command, args);
    });
    const connection = createProviderConnection({
      provider: "zhipu",
      instanceId: "builtin:zhipu",
      credentialValue: "test-key",
    });
    const model = await buildLanguageModel(connection, "glm-test");
    const parameters = buildParameterOptions(
      [
        { target: "provider", path: "thinking.type", value: "enabled" },
        { target: "provider", path: "thinking.clear_thinking", value: false },
      ],
      connection.runtime.adapter,
      connection.provider,
    );
    const execute = vi.fn(async () => "查询结果");
    const messages: ModelMessage[] = [{ role: "user", content: "查询 test" }];
    const result = streamText({
      model,
      system: "保持上下文",
      messages,
      ...parameters,
      maxRetries: 0,
      tools: {
        lookup: { inputSchema: z.object({ query: z.string() }), execute },
      },
      stopWhen: stepCountIs(3),
    });
    expect(await result.text).toBe("查询完成。");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.slice(0, 2)).toEqual(bodies[0].messages);
    expect(bodies[1].messages[2]).toMatchObject({
      role: "assistant",
      reasoning_content: "先查询工具。",
      tool_calls: [{ id: "lookup-1" }],
    });
    expect(bodies[1].messages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "lookup-1",
      content: "查询结果",
    });
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect(body.stream_options).toEqual({ include_usage: true });
    }
    const steps = await result.steps;
    expect(steps.map((step) => normalizeUsage(step.usage, 0, 0))).toEqual([
      {
        values: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 0 },
        estimated: [],
      },
      {
        values: { inputTokens: 160, outputTokens: 12, cacheReadTokens: 80 },
        estimated: [],
      },
    ]);
    // 模拟持久化往返后追加新轮，已有的思考和工具结果必须仍在请求前缀中。
    const persisted = serializeSessionMessages(
      [
        {
          id: "response",
          role: "assistant",
          parts: [modelHistoryPart(await result.responseMessages)],
        },
      ],
      { timestamp: "2026-10-11T00:00:00.000Z", turnId: "turn" },
    );
    const restored = await convertToAgentModelMessages(
      projectSessionMessages(
        "restored-session",
        JSON.parse(JSON.stringify(persisted)),
      ),
    );
    const followup = await generateText({
      model,
      system: "保持上下文",
      messages: [
        ...messages,
        ...restored,
        { role: "user", content: "还记得吗？" },
      ],
      ...parameters,
      maxRetries: 0,
    });
    expect(followup.text).toBe("记得查询结果。");
    expect(bodies[2].messages.slice(0, bodies[1].messages.length)).toEqual(
      bodies[1].messages,
    );
    expect(
      bodies[2].messages[bodies[2].messages.length - 2].reasoning_content,
    ).toBe("依据工具结果回答。");
    expect(
      normalizeUsage(followup.steps[0].usage, 0, 0).values.cacheReadTokens,
    ).toBeUndefined();
    for (const [, args] of native.invoke.mock.calls) {
      expect(args.url).toBe(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      );
      expect(args.headers).toMatchObject({ authorization: "Bearer test-key" });
    }
  });
});
