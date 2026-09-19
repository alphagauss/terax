import {
  InvalidToolInputError,
  streamText,
  toUIMessageStream,
  TypeValidationError,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatAiError } from "./errors";

describe("formatAiError", () => {
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
      files: JSON.stringify([
        {
          path: "count_line.py",
          edits: [{ old_text: "x".repeat(2_000), new_text: "new" }],
        },
      ]),
    };
    const parsed = z.object({ files: z.array(z.object({})) }).safeParse(value);
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
        "Invalid input for tool apply_patch: files: expected array, received string. Pass JSON arrays and objects directly, not as JSON-encoded strings. Call the tool again with input that matches the schema. The tool was not executed.",
      );
      expect(formatAiError(input)).not.toContain("count_line.py");
    }
  });

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
