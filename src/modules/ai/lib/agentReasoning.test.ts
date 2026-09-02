/**
 * 本文件验证主 Agent 多步骤推理耗时的流式关联。
 * 测试锁定 provider 在不同工具步骤复用 reasoning ID 时，每段推理仍保留独立耗时。
 */

import type { UIMessage } from "@ai-sdk/react";
import { readUIMessageStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { SubagentTurnCoordinator } from "../agents/subagentRuntime";
import { modelRefForProvider } from "../config";
import { runAgentStream } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import { reasoningDurationFromPart } from "./sessionMessages";

let activeModel: MockLanguageModelV3;

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => activeModel,
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};

function reasoningStream(options: { toolCall: boolean }) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "reasoning-start", id: "reasoning" });
        controller.enqueue({
          type: "reasoning-delta",
          id: "reasoning",
          delta: options.toolCall ? "先读取终端。" : "现在总结。",
        });
        controller.enqueue({ type: "reasoning-end", id: "reasoning" });
        if (options.toolCall) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: "terminal-1",
            toolName: "get_terminal_output",
            input: "{}",
          });
        } else {
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: "完成。",
          });
          controller.enqueue({ type: "text-end", id: "text" });
        }
        controller.enqueue({
          type: "finish",
          usage,
          finishReason: {
            unified: options.toolCall ? "tool-calls" : "stop",
            raw: options.toolCall ? "tool_calls" : "stop",
          },
        });
        controller.close();
      },
    }),
  } as never;
}

describe("Agent reasoning duration", () => {
  it("keeps one duration beside each reasoning part when IDs repeat", async () => {
    activeModel = new MockLanguageModelV3({
      doStream: () =>
        reasoningStream({ toolCall: activeModel.doStreamCalls.length === 1 }),
    });
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "检查终端" }],
      },
    ];
    const result = await runAgentStream({
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "mock-model-reasoning"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxConcurrentSubagents: 3,
      subagentCoordinator: new SubagentTurnCoordinator(),
      toolContext: {
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000004",
        getPermissionMode: () => "ask",
      } as never,
      uiMessages: messages,
      onCheckpoint: vi.fn(),
    });

    let finalMessage: UIMessage | undefined;
    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream({ originalMessages: messages }),
    })) {
      finalMessage = message;
    }

    const reasoningIndexes = finalMessage?.parts.flatMap((part, index) =>
      part.type === "reasoning" ? [index] : [],
    );
    expect(reasoningIndexes).toHaveLength(2);
    for (const index of reasoningIndexes ?? []) {
      expect(
        reasoningDurationFromPart(finalMessage?.parts[index + 1]),
      ).toBeTypeOf("number");
    }
  });
});
