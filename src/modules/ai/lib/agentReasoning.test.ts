/**
 * 本文件验证主 Agent 多步骤推理与活动耗时的流式关联。
 * 测试锁定复用 reasoning ID 时的分段耗时、空正文事件和无 reasoning 工具的活动边界。
 */

import type { UIMessage } from "@ai-sdk/react";
import { readUIMessageStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { SubagentTurnCoordinator } from "../agents/subagentRuntime";
import { modelRefForProvider } from "../config";
import { runAgentStream } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import {
  activityDurationFromPart,
  reasoningDurationFromPart,
} from "./sessionMessages";

let activeModel: MockLanguageModelV3;

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => activeModel,
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};

function activityStream(options: {
  reasoning: boolean;
  blankText?: boolean;
  text?: string;
  toolCallId?: string;
}) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (options.reasoning) {
          controller.enqueue({ type: "reasoning-start", id: "reasoning" });
          controller.enqueue({
            type: "reasoning-delta",
            id: "reasoning",
            delta: "检查终端。",
          });
          controller.enqueue({ type: "reasoning-end", id: "reasoning" });
        }
        if (options.blankText) {
          controller.enqueue({ type: "text-start", id: "empty-text" });
          controller.enqueue({
            type: "text-delta",
            id: "empty-text",
            delta: "\n\n",
          });
          controller.enqueue({ type: "text-end", id: "empty-text" });
        }
        if (options.text) {
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: options.text,
          });
          controller.enqueue({ type: "text-end", id: "text" });
        }
        if (options.toolCallId) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: options.toolCallId,
            toolName: "get_terminal_output",
            input: "{}",
          });
        }
        controller.enqueue({
          type: "finish",
          usage,
          finishReason: {
            unified: options.toolCallId ? "tool-calls" : "stop",
            raw: options.toolCallId ? "tool_calls" : "stop",
          },
        });
        controller.close();
      },
    }),
  } as never;
}

describe("Agent reasoning duration", () => {
  it("keeps activity boundaries stable across blank text and direct tools", async () => {
    activeModel = new MockLanguageModelV3({
      doStream: () => {
        const call = activeModel.doStreamCalls.length;
        if (call === 1) {
          return activityStream({
            reasoning: true,
            blankText: true,
            toolCallId: "terminal-1",
          });
        }
        if (call === 2) {
          return activityStream({
            reasoning: true,
            text: "阶段正文。",
            toolCallId: "terminal-2",
          });
        }
        return activityStream({ reasoning: false, text: "完成。" });
      },
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
    const activityIndexes =
      finalMessage?.parts.flatMap((part, index) =>
        activityDurationFromPart(part) !== undefined ? [index] : [],
      ) ?? [];
    const terminalIndexes =
      finalMessage?.parts.flatMap((part, index) =>
        part.type === "tool-get_terminal_output" ? [index] : [],
      ) ?? [];
    const textIndexes =
      finalMessage?.parts.flatMap((part, index) =>
        part.type === "text" && part.text.trim().length > 0 ? [index] : [],
      ) ?? [];
    expect(activityIndexes).toHaveLength(2);
    expect(terminalIndexes).toHaveLength(2);
    expect(textIndexes).toHaveLength(2);
    expect(terminalIndexes[0]).toBeLessThan(activityIndexes[0]);
    expect(textIndexes[0]).toBeLessThan(activityIndexes[0]);
    expect(activityIndexes[0]).toBeLessThan(terminalIndexes[1]);
    expect(terminalIndexes[1]).toBeLessThan(activityIndexes[1]);
    expect(textIndexes[1]).toBeLessThan(activityIndexes[1]);
  });
});
