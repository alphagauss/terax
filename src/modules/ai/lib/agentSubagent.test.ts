/**
 * 本文件验证 wait=false Subagent 会延长同一 turn，并在全部完成后恢复主 Agent 循环。
 * 测试锁定活动在 Subagent 前结束、append-only 事件先 checkpoint，且最终模型正常响应。
 */

import type { UIMessage } from "@ai-sdk/react";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { SubagentTurnCoordinator } from "../agents/subagentRuntime";
import { runAgentStream } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import { modelRefForProvider } from "../config";
import { activityDurationFromPart } from "./sessionMessages";

let activeModel: MockLanguageModelV3;

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => activeModel,
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStream(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text" });
        controller.enqueue({ type: "text-delta", id: "text", delta: text });
        controller.enqueue({ type: "text-end", id: "text" });
        controller.enqueue({
          type: "finish",
          usage,
          finishReason: { unified: "stop", raw: "stop" },
        });
        controller.close();
      },
    }),
  } as never;
}

function toolCallsStream(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  reasoning?: string,
) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (reasoning) {
          controller.enqueue({ type: "reasoning-start", id: "reasoning" });
          controller.enqueue({
            type: "reasoning-delta",
            id: "reasoning",
            delta: reasoning,
          });
          controller.enqueue({ type: "reasoning-end", id: "reasoning" });
        }
        for (const call of calls) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.input),
          });
        }
        controller.enqueue({
          type: "finish",
          usage,
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        });
        controller.close();
      },
    }),
  } as never;
}

function spawnStream() {
  return toolCallsStream(
    [
      {
        id: "spawn-1",
        name: "run_subagent",
        input: { task: "Inspect the tests", wait: false },
      },
    ],
    "先委派检查。",
  );
}

function terminalToolStream() {
  return toolCallsStream([
    {
      id: "terminal-1",
      name: "get_terminal_output",
      input: {},
    },
  ]);
}

function childResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  } as never;
}

describe.sequential("Agent background subagents", () => {
  it("waits before terminal commit, checkpoints the result, and resumes the model", async () => {
    let resolveChild!: (value: never) => void;
    const childStarted = new Promise<void>((resolve) => {
      activeModel = new MockLanguageModelV3({
        doStream: ({ prompt }) => {
          const rootCall = activeModel.doStreamCalls.length;
          if (rootCall === 1) return spawnStream();
          if (rootCall === 2) return textStream("Provisional answer");
          if (rootCall === 3) {
            expect(JSON.stringify(prompt)).toContain("subagent_result");
            return terminalToolStream();
          }
          return textStream("Final answer");
        },
        doGenerate: () => {
          resolve();
          return new Promise((done) => {
            resolveChild = done as (value: never) => void;
          });
        },
      });
    });
    const checkpoint = vi.fn();
    const onSubagentDisplay = vi.fn();
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Use a subagent" }],
      },
    ];
    const result = await runAgentStream({
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "mock-model-background"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output", "run_subagent"],
      maxConcurrentSubagents: 3,
      subagentCoordinator: new SubagentTurnCoordinator(),
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000001",
        getPermissionMode: () => "ask",
      },
      uiMessages: messages,
      onSystemPrompt: vi.fn(),
      onCheckpoint: checkpoint,
      onSubagentDisplay,
    });

    const chunks: unknown[] = [];
    const consuming = (async () => {
      for await (const chunk of result.toUIMessageStream({
        originalMessages: messages,
      })) {
        chunks.push(chunk);
      }
    })();

    await childStarted;
    resolveChild(childResult("Tests are healthy."));
    await consuming;

    expect(activeModel.doStreamCalls).toHaveLength(4);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    const checkpointParts = checkpoint.mock.calls[0][0][0]?.parts ?? [];
    const activityIndex = checkpointParts.findIndex(
      (part: UIMessage["parts"][number]) =>
        activityDurationFromPart(part) !== undefined,
    );
    const subagentIndex = checkpointParts.findIndex(
      (part: UIMessage["parts"][number]) => part.type === "tool-run_subagent",
    );
    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeLessThan(subagentIndex);
    expect(checkpoint.mock.calls[0][1]).toEqual(
      expect.objectContaining({ event: "subagent_result" }),
    );
    expect(onSubagentDisplay.mock.calls[0][0]).toMatchObject({
      toolCallId: "spawn-1",
      status: "running",
      phase: "thinking",
    });
    expect(
      onSubagentDisplay.mock.calls[
        onSubagentDisplay.mock.calls.length - 1
      ]?.[0],
    ).toMatchObject({
      status: "completed",
      result: "Tests are healthy.",
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "data-subagent-result" }),
    );
    expect(
      chunks.some(
        (chunk) =>
          typeof chunk === "object" &&
          chunk !== null &&
          "delta" in chunk &&
          chunk.delta === "Final answer",
      ),
    ).toBe(true);
  });

  it("drains results that finish during a checkpoint before the next provider call", async () => {
    const childResolvers = new Map<string, (value: never) => void>();
    let releaseFirstCheckpoint!: () => void;
    const checkpoint = vi.fn(() => {
      if (checkpoint.mock.calls.length !== 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstCheckpoint = resolve;
      });
    });
    activeModel = new MockLanguageModelV3({
      doStream: ({ prompt }) => {
        const rootCall = activeModel.doStreamCalls.length;
        if (rootCall === 1) {
          return toolCallsStream([
            {
              id: "background-1",
              name: "run_subagent",
              input: { task: "first background task", wait: false },
            },
            {
              id: "background-2",
              name: "run_subagent",
              input: { task: "second background task", wait: false },
            },
          ]);
        }
        if (rootCall === 2) {
          return toolCallsStream([
            {
              id: "wait-1",
              name: "run_subagent",
              input: { task: "blocking task", wait: true },
            },
          ]);
        }
        expect(JSON.stringify(prompt)).toContain("first result");
        expect(JSON.stringify(prompt)).toContain("second result");
        return textStream("All delegated work is complete.");
      },
      doGenerate: ({ prompt }) =>
        new Promise((resolve) => {
          const serialized = JSON.stringify(prompt);
          const task = [
            "first background task",
            "second background task",
            "blocking task",
          ].find((candidate) => serialized.includes(candidate));
          if (!task) throw new Error("Unexpected Subagent prompt");
          childResolvers.set(task, resolve as (value: never) => void);
        }),
    });
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Delegate three tasks" }],
      },
    ];
    const coordinator = new SubagentTurnCoordinator();
    const result = await runAgentStream({
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "mock-model-checkpoint"),
      systemPrompt: "Stable prompt",
      allowedTools: ["run_subagent"],
      maxConcurrentSubagents: 3,
      subagentCoordinator: coordinator,
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => null,
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000002",
        getPermissionMode: () => "ask",
      },
      uiMessages: messages,
      onCheckpoint: checkpoint,
    });

    const consuming = (async () => {
      for await (const _chunk of result.toUIMessageStream({
        originalMessages: messages,
      })) {
        // 消费完整流，断言通过 mock provider 和 checkpoint 调用完成。
      }
    })();

    await vi.waitFor(() => expect(childResolvers.size).toBe(3));
    childResolvers.get("first background task")?.(childResult("first result"));
    childResolvers.get("blocking task")?.(childResult("blocking result"));
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledTimes(1));
    childResolvers.get("second background task")?.(
      childResult("second result"),
    );
    await vi.waitFor(() => expect(coordinator.hasPendingResults).toBe(true));
    releaseFirstCheckpoint();
    await consuming;

    expect(checkpoint).toHaveBeenCalledTimes(2);
    const checkpointCalls = checkpoint.mock.calls as unknown as Array<
      [UIMessage[]]
    >;
    expect(checkpointCalls[0][0]).toHaveLength(1);
    expect(checkpointCalls[1][0]).toEqual([]);
    expect(activeModel.doStreamCalls).toHaveLength(3);
  });

  it("defers background result injection while another tool awaits approval", async () => {
    activeModel = new MockLanguageModelV3({
      doStream: () =>
        toolCallsStream([
          {
            id: "background-1",
            name: "run_subagent",
            input: { task: "background task", wait: false },
          },
          {
            id: "approval-1",
            name: "shell_exec",
            input: { command: "echo approval" },
          },
        ]),
      doGenerate: async () => childResult("background result"),
    });
    const coordinator = new SubagentTurnCoordinator();
    const checkpoint = vi.fn();
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Delegate and run a command" }],
      },
    ];
    const result = await runAgentStream({
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "mock-model-approval"),
      systemPrompt: "Stable prompt",
      allowedTools: ["shell_exec", "run_subagent"],
      maxConcurrentSubagents: 3,
      subagentCoordinator: coordinator,
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => null,
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000003",
        getPermissionMode: () => "ask",
      },
      uiMessages: messages,
      onCheckpoint: checkpoint,
    });

    const chunks: Array<{ type?: string }> = [];
    for await (const chunk of result.toUIMessageStream({
      originalMessages: messages,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toContain(
      "tool-approval-request",
    );
    expect(checkpoint).not.toHaveBeenCalled();
    expect(coordinator.hasPendingResults).toBe(true);
    await coordinator.cancelAll();
  });
});
