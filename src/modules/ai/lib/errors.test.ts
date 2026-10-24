import {
  InvalidToolInputError,
  isStepCount,
  streamText,
  TypeValidationError,
  toUIMessageStream,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { formatAiError, reportInvalidToolInput } from "./errors";

describe("formatAiError", () => {
  it("redacts and bounds schema errors in both UI and model receipts", async () => {
    const secret = "sk-ant-abcdefghijklmnop";
    const value = { [secret]: true };
    const parsed = z.strictObject({}).safeParse(value);
    if (parsed.success) throw new Error("expected invalid input");
    const error = new InvalidToolInputError({
      toolName: "apply_patch",
      toolInput: JSON.stringify(value),
      cause: new TypeValidationError({ value, cause: parsed.error }),
    });
    expect(formatAiError(error)).toContain("[redacted]");
    expect(formatAiError(error)).not.toContain(secret);
    await reportInvalidToolInput({ error });
    expect(error.message).toBe(formatAiError(error));
    const oversized = new InvalidToolInputError({
      toolName: "apply_patch",
      toolInput: "{}",
      cause: new TypeValidationError({
        value: {},
        cause: { issues: [{ path: [], message: "x".repeat(2000) }] },
      }),
    });
    await reportInvalidToolInput({ error: oversized });
    expect(oversized.message.length).toBeLessThanOrEqual(800);
    expect(formatAiError(oversized)).toBe(oversized.message);
  });

  it("gives count guidance instead of a structural example for an invalid count", () => {
    const value = { edits: [{ expected_replacements: 0 }] };
    const parsed = z
      .object({
        edits: z.array(
          z.object({ expected_replacements: z.number().int().min(1) }),
        ),
      })
      .safeParse(value);
    if (parsed.success) throw new Error("expected invalid input");
    const message = formatAiError(
      new InvalidToolInputError({
        toolName: "apply_patch",
        toolInput: JSON.stringify(value),
        cause: new TypeValidationError({ value, cause: parsed.error }),
      }),
    );
    expect(message).toContain("positive integer");
    expect(message).toContain("replace_all=true");
    expect(message).not.toContain("Example:");
  });
  it("surfaces nested provider model errors", () => {
    expect(
      formatAiError({
        type: "error",
        sequence_number: 2,
        error: {
          code: "model_not_found",
          message:
            "The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
          type: "invalid_request_error",
        },
      }),
    ).toBe(
      "Model unavailable: The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
    );
  });

  it("extracts structured response bodies from SDK errors", () => {
    expect(
      formatAiError({
        message: "Bad Request",
        responseBody: JSON.stringify({
          error: {
            code: "rate_limit_exceeded",
            message: "Please retry after 10 seconds.",
          },
        }),
      }),
    ).toBe("Rate limit reached: Please retry after 10 seconds.");
  });

  it("preserves useful local errors", () => {
    expect(formatAiError(new Error("No API key configured for OpenAI."))).toBe(
      "No API key configured for OpenAI.",
    );
  });

  it("redacts credential-like values", () => {
    expect(
      formatAiError(
        new Error(
          "Authorization Bearer secret-token-value and key sk-ant-abcdefghijklmnop were rejected.",
        ),
      ),
    ).toBe("Authorization Bearer [redacted] and key [redacted] were rejected.");
  });

  it("uses an actionable fallback for unknown error shapes", () => {
    expect(formatAiError({ unexpected: true })).toBe(
      "The AI provider rejected the request. Check the selected model and provider settings, then try again.",
    );
  });

  it("summarizes invalid tool input without echoing a large payload", () => {
    const value = {
      edits: JSON.stringify([
        {
          path: "count_line.py",
          edits: [{ old_text: "x".repeat(2_000), new_text: "new" }],
        },
      ]),
    };
    const parsed = z.object({ edits: z.array(z.object({})) }).safeParse(value);
    if (parsed.success) throw new Error("expected invalid test input");
    const validation = new TypeValidationError({ value, cause: parsed.error });
    const error = new InvalidToolInputError({
      toolName: "apply_patch",
      toolInput: JSON.stringify(value),
      cause: validation,
    });
    const transported = JSON.parse(
      JSON.stringify({
        name: error.name,
        toolName: error.toolName,
        cause: {
          name: validation.name,
          value,
          cause: { issues: parsed.error.issues },
        },
      }),
    );

    for (const input of [error, transported]) {
      expect(formatAiError(input)).toBe(
        "Invalid input for tool apply_patch: edits: expected array, received string. Pass JSON arrays and objects directly, not as JSON-encoded strings. Call the tool again with input that matches the schema. The tool was not executed.",
      );
      expect(formatAiError(input)).not.toContain("count_line.py");
    }
  });

  it.each([
    [60000, "expected number <= 30000, received 60000"],
    [120000, "expected number <= 30000, received 120000"],
    [-1, "expected number >= 0, received -1"],
  ])(
    "reports numeric bounds even without a useful issue message (%s)",
    async (value, detail) => {
      const input = { yield_time_ms: value };
      const parsed = z
        .object({ yield_time_ms: z.number().int().min(0).max(30000) })
        .safeParse(input);
      if (parsed.success) throw new Error("expected invalid test input");
      const issues = parsed.error.issues.map((issue) => ({
        ...issue,
        message: "Invalid input",
      }));
      const error = new InvalidToolInputError({
        toolName: "shell_exec",
        toolInput: JSON.stringify(input),
        cause: new TypeValidationError({ value: input, cause: { issues } }),
      });
      const transported = JSON.parse(
        JSON.stringify({
          name: error.name,
          toolName: "shell_exec",
          cause: {
            name: "AI_TypeValidationError",
            value: input,
            cause: { issues },
          },
        }),
      );
      const expected = `Invalid input for tool shell_exec: yield_time_ms: ${detail}. Call the tool again with input that matches the schema. The tool was not executed.`;
      expect(formatAiError(error)).toBe(expected);
      expect(formatAiError(transported)).toBe(expected);
      expect(await reportInvalidToolInput({ error })).toBeNull();
      expect(error.message).toBe(expected);
    },
  );

  it("does not treat incomplete error objects as validated tool failures", () => {
    for (const error of [
      {
        name: "AI_InvalidToolInputError",
        toolName: "apply_patch",
        message: "incomplete",
      },
      {
        name: "AI_InvalidToolInputError",
        toolName: 123,
        message: "incomplete",
      },
      {
        name: "AI_InvalidToolInputError",
        toolName: "apply_patch",
        cause: { name: "AI_TypeValidationError", message: "incomplete" },
      },
    ])
      expect(formatAiError(error)).toBe("incomplete");
  });

  it("returns concise tool errors without executing invalid input or changing request prefixes", async () => {
    const execute = vi.fn();
    const inputs = [
      '{"edits":[{"path":"a.py"}',
      JSON.stringify({
        edits: [
          {
            old_text: "private-source-marker",
            new_text: "private-replacement-marker",
          },
        ],
        path: "a.py",
      }),
      JSON.stringify({ yield_time_ms: 60000 }),
      JSON.stringify({
        path: "private-target",
        content: "private-source-marker",
      }),
    ];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const input = inputs[step++];
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (input) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `call-${step}`,
                  toolName:
                    step === 4
                      ? "write_file"
                      : step === 3
                        ? "shell_exec"
                        : "apply_patch",
                  input,
                });
              }
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: input ? "tool-calls" : "stop",
                  raw: undefined,
                },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const options = {
      model,
      instructions: "Stable instructions",
      tools: {
        shell_exec: {
          inputSchema: z.object({
            yield_time_ms: z.number().int().min(0).max(30000),
          }),
          execute,
        },
        apply_patch: {
          inputSchema: z.strictObject({
            edits: z.array(
              z.strictObject({
                path: z.string(),
                old_text: z.string(),
                new_text: z.string(),
              }),
            ),
          }),
          execute,
        },
        write_file: {
          inputSchema: z.strictObject({
            path: z.string(),
            content: z.string(),
            mode: z.enum(["create", "rewrite"]),
          }),
          execute,
        },
      },
      repairToolCall: reportInvalidToolInput,
      stopWhen: isStepCount(5),
    };
    const messages = [{ role: "user" as const, content: "edit" }];
    const result = streamText({ ...options, messages });
    await result.consumeStream();
    const responseMessages = await result.responseMessages;
    expect(execute).not.toHaveBeenCalled();
    const outputs = responseMessages.flatMap((message) =>
      message.role === "tool"
        ? message.content.map((part) =>
            part.type === "tool-result" ? part.output : null,
          )
        : [],
    );
    expect(outputs).toEqual([
      {
        type: "error-text",
        value: expect.stringContaining("input is not valid JSON"),
      },
      {
        type: "error-text",
        value: expect.stringContaining(
          "edits[0].path: expected string, received undefined",
        ),
      },
      {
        type: "error-text",
        value: expect.stringContaining(
          "yield_time_ms: expected number <= 30000, received 60000",
        ),
      },
      {
        type: "error-text",
        value: expect.stringContaining('Specify mode="create"'),
      },
    ]);
    for (const output of outputs) {
      expect(JSON.stringify(output)).toContain("The tool was not executed.");
      expect(JSON.stringify(output)).not.toContain("private-source-marker");
    }
    for (let index = 1; index < 5; index++) {
      const previous = model.doStreamCalls[index - 1];
      const current = model.doStreamCalls[index];
      expect(current.prompt.slice(0, previous.prompt.length)).toEqual(
        previous.prompt,
      );
      expect(current.tools).toEqual(previous.tools);
    }
    // 恢复已保存的错误回执时保持原前缀，不在 prepareStep 中改写历史。
    const restored = streamText({
      ...options,
      messages: [...messages, ...JSON.parse(JSON.stringify(responseMessages))],
    });
    await restored.consumeStream();
    const previous = model.doStreamCalls[4];
    expect(
      model.doStreamCalls[5].prompt.slice(0, previous.prompt.length),
    ).toEqual(previous.prompt);
  });

  it("preserves provider details through the AI SDK UI stream", async () => {
    const providerError = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        message:
          "The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
      },
    };
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "error", error: providerError });
            controller.close();
          },
        }),
      },
    });
    const result = streamText({
      model,
      prompt: "hello",
      onError: () => {},
    });
    const chunks: UIMessageChunk[] = [];
    await toUIMessageStream({
      stream: result.stream,
      onError: formatAiError,
    }).pipeTo(
      new WritableStream({
        write: (chunk) => {
          chunks.push(chunk);
        },
      }),
    );

    expect(chunks).toContainEqual({
      type: "error",
      errorText:
        "Model unavailable: The model `gpt-5.6-luna` is in limited preview and is not available on this account.",
    });
  });
});
