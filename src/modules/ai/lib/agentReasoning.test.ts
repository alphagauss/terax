/**
 * 本文件验证主 Agent 多步骤推理与活动耗时的流式关联。
 * 测试锁定复用 reasoning ID 时的分段耗时、空正文事件和无 reasoning 工具的活动边界。
 */

import { AgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import { modelRefForProvider } from "@/modules/ai/config";
import { runAgentStream } from "@/modules/ai/lib/agent";
import {
  activityDurationFromPart,
  reasoningDurationFromPart,
  serializeSessionMessages,
} from "@/modules/ai/lib/conversation";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { usageRecords } from "@/modules/ai/lib/usageRuntime";
import type { UIMessage } from "@ai-sdk/react";
import { readUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

let activeModel: MockLanguageModelV4;

vi.mock("@/modules/ai/lib/providerRuntime", () => ({
  buildConfiguredLanguageModel: async () => activeModel,
  createProviderDownload: () => undefined,
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
  web?: boolean;
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
            toolName: options.web ? "web_search" : "get_terminal_output",
            input: options.web ? JSON.stringify({ query: "terax" }) : "{}",
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
  it("空白终态仅追加恢复消息且保持请求前缀和工具定义稳定", async () => {
    activeModel = new MockLanguageModelV4({
      doStream: () =>
        activeModel.doStreamCalls.length === 1
          ? activityStream({ reasoning: true })
          : activityStream({ reasoning: false, text: "最终答复。" }),
    });
    const messages: UIMessage[] = [
      {
        id: "user-recovery",
        role: "user",
        parts: [{ type: "text", text: "继续检查" }],
      },
    ];
    const onFinishMeta = vi.fn();
    const result = await runAgentStream({
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "empty-response-recovery"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxConcurrentSubagents: 3,
      turnCoordinator: new AgentTurnCoordinator(),
      toolContext: {
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "empty-response-recovery",
        getPermissionMode: () => "ask",
      } as never,
      uiMessages: messages,
      onCheckpoint: vi.fn(),
      onFinishMeta,
    });

    let finalMessage: UIMessage | undefined;
    const errors = vi.fn();
    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream({ originalMessages: messages }),
      onError: errors,
    })) {
      finalMessage = message;
    }

    expect(errors).not.toHaveBeenCalled();
    expect(onFinishMeta).toHaveBeenCalledWith({
      hitStepCap: false,
      finishReason: "stop",
    });
    expect(activeModel.doStreamCalls).toHaveLength(2);
    const first = activeModel.doStreamCalls[0];
    const second = activeModel.doStreamCalls[1];
    expect(second.prompt.slice(0, first.prompt.length)).toEqual(first.prompt);
    expect(second.tools).toEqual(first.tools);
    expect(JSON.stringify(second.prompt.slice(first.prompt.length))).toContain(
      "did not include a valid tool call",
    );
    const visibleText = finalMessage?.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    expect(visibleText).toBe("最终答复。");
    expect(visibleText).not.toContain("did not include a valid tool call");
  });

  it("恢复后仍无工具调用或最终正文时报告失败", async () => {
    activeModel = new MockLanguageModelV4({
      doStream: () => activityStream({ reasoning: true }),
    });
    const messages: UIMessage[] = [
      {
        id: "user-empty-failure",
        role: "user",
        parts: [{ type: "text", text: "继续检查" }],
      },
    ];
    const onFinishMeta = vi.fn();
    const result = await runAgentStream({
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "empty-response-failure"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxConcurrentSubagents: 3,
      turnCoordinator: new AgentTurnCoordinator(),
      toolContext: {
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "empty-response-failure",
        getPermissionMode: () => "ask",
      } as never,
      uiMessages: messages,
      onCheckpoint: vi.fn(),
      onFinishMeta,
    });

    const errors = vi.fn();
    for await (const _message of readUIMessageStream({
      stream: result.toUIMessageStream({ originalMessages: messages }),
      onError: errors,
    })) {
      // 消费完整流，确保终态错误已经发布。
    }

    expect(activeModel.doStreamCalls).toHaveLength(2);
    expect(String(errors.mock.calls[0]?.[0])).toContain(
      "The model returned neither a valid tool call nor a final response after retrying.",
    );
    expect(onFinishMeta).not.toHaveBeenCalled();
  });

  it("模型中途报错时保留已收到的正文，取消本轮且不报告正常完成", async () => {
    activeModel = new MockLanguageModelV4({
      doStream: async () =>
        activeModel.doStreamCalls.length === 1
          ? activityStream({ reasoning: false, toolCallId: "terminal-1" })
          : {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "stream-start", warnings: [] });
                  controller.enqueue({ type: "text-start", id: "partial" });
                  controller.enqueue({
                    type: "text-delta",
                    id: "partial",
                    delta: "已收到的正文",
                  });
                  controller.enqueue({
                    type: "error",
                    error: new Error("connection lost"),
                  });
                  controller.close();
                },
              }),
            },
    });
    const coordinator = new AgentTurnCoordinator();
    const cancelAll = coordinator.cancelAll.bind(coordinator);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const cancel = vi
      .spyOn(coordinator, "cancelAll")
      .mockImplementation(async () => {
        await cleanup;
        await cancelAll();
      });
    const onFinishMeta = vi.fn();
    const errors = vi.fn();
    const result = await runAgentStream({
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "interrupted-stream"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxConcurrentSubagents: 3,
      turnCoordinator: coordinator,
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "interrupted-stream",
        getPermissionMode: () => "ask",
        supportsApprovals: true,
      },
      uiMessages: [
        {
          id: "user",
          role: "user",
          parts: [{ type: "text", text: "Inspect" }],
        },
      ],
      onCheckpoint: vi.fn(),
      onFinishMeta,
    });
    let message: UIMessage | undefined;
    const consuming = (async () => {
      for await (const update of readUIMessageStream({
        stream: result.toUIMessageStream(),
        onError: errors,
      })) {
        message = update;
      }
    })();
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      // Chat 收到 error 就可能提交并释放会话，必须先完成后台任务清理。
      expect(errors).not.toHaveBeenCalled();
    } finally {
      finishCleanup();
      await consuming;
    }
    expect(message?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "已收到的正文" }),
    );
    expect(errors).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(onFinishMeta).not.toHaveBeenCalled();
    const records = usageRecords("interrupted-stream");
    expect(records).toHaveLength(2);
    expect(records[0].values).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(records[0].estimated).toEqual([]);
    expect(records[1].estimated).toContain("outputTokens");
    expect(records[1].values.outputTokens).toBeGreaterThan(0);
    if (!message) throw new Error("Missing interrupted assistant message");
    const saved = serializeSessionMessages([message], {
      timestamp: "now",
      turnId: "turn",
      turnStatus: "failed",
    });
    expect(
      saved
        .filter(
          (record) => record.role === "model" || record.role === "assistant",
        )
        .map((record) => ("call_id" in record ? record.call_id : undefined)),
    ).toEqual(records.map((record) => record.callId));
  });

  it("keeps activity boundaries stable across blank text and direct tools", async () => {
    activeModel = new MockLanguageModelV4({
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
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "mock-model-reasoning"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxConcurrentSubagents: 3,
      turnCoordinator: new AgentTurnCoordinator(),
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
    if (!finalMessage) throw new Error("Missing completed assistant message");
    const records = serializeSessionMessages([finalMessage], {
      timestamp: "now",
      turnId: "turn",
    });
    expect(
      records
        .filter((record) => record.role === "model")
        .map((record) => record.call_id),
    ).toEqual(
      usageRecords("00000000-0000-4000-8000-000000000004").map(
        (record) => record.callId,
      ),
    );
  });
});


it("keeps SDK prefixes and tool definitions stable through web search", async () => {
  activeModel = new MockLanguageModelV4({ doStream: () => activeModel.doStreamCalls.length === 1
    ? activityStream({ reasoning: false, toolCallId: "web-call", web: true })
    : activityStream({ reasoning: false, text: "Found a source." }) });
  const search = vi.fn().mockResolvedValue([{ title: "Source", url: "https://example.com", content: "Fact", truncated: false }]);
  const result = await runAgentStream({
    turnId: "web-turn", keys: EMPTY_PROVIDER_KEYS, model: modelRefForProvider("lmstudio", "mock"), systemPrompt: "Stable prompt", allowedTools: ["web_search", "web_fetch"], maxConcurrentSubagents: 3, turnCoordinator: new AgentTurnCoordinator(),
    toolContext: { getCwd: () => "/workspace", getSessionId: () => "web-prefix", getPermissionMode: () => "ask", getTerminalContext: () => null, isActiveTerminalPrivate: () => false, supportsApprovals: true, webServices: { search } },
    uiMessages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Search for terax" }] }], onCheckpoint: vi.fn(),
  });
  let final: UIMessage | undefined;
  const errors: unknown[] = [];
  for await (const message of readUIMessageStream({ stream: result.toUIMessageStream(), onError: (error) => errors.push(error) })) final = message;
  expect(errors).toEqual([]);
  expect(search).toHaveBeenCalledTimes(1);
  expect(activeModel.doStreamCalls).toHaveLength(2);
  const [first, second] = activeModel.doStreamCalls;
  expect(second.prompt.slice(0, first.prompt.length)).toEqual(first.prompt);
  expect(second.tools).toEqual(first.tools);
  expect(JSON.stringify(second.prompt)).toContain("https://example.com");
  expect(JSON.stringify(second.prompt)).toContain("untrusted data");
  expect(final?.parts.some((part) => part.type === "text" && part.text === "Found a source.")).toBe(true);
});
