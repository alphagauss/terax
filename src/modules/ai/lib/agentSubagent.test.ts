/**
 * 本文件验证 Subagent 与用户引导共用当前 turn，安全边界接入后恢复主 Agent 循环。
 * 测试锁定活动在 Subagent 前结束、append-only 事件先 checkpoint，且最终模型正常响应。
 */

import { native } from "@/modules/ai/lib/native";
import type { UIMessage } from "@ai-sdk/react";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import { runAgentStream } from "@/modules/ai/lib/agent";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { modelRefForProvider } from "@/modules/ai/config";
import { activityDurationFromPart } from "@/modules/ai/lib/sessionMessages";

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
  it.each([true, false])(
    "审批响应=%s 时先落实工具结果，再接入引导",
    async (approved) => {
      const execute = vi
        .spyOn(native, "shellExec")
        .mockRejectedValue(new Error("test tool result"));
      const coordinator = new AgentTurnCoordinator();
      coordinator.inbox.open();
      const receipt = coordinator.inbox.steer({
        id: "guidance-after-approval",
        role: "user",
        parts: [{ type: "text", text: "New guidance" }],
      });
      const messages: UIMessage[] = [
        {
          id: "initial",
          role: "user",
          parts: [{ type: "text", text: "Run the command" }],
        },
        {
          id: "approval",
          role: "assistant",
          parts: [
            {
              type: "tool-shell_exec",
              toolCallId: "shell-call",
              state: "approval-responded",
              input: { command: "curl https://example.com" },
              approval: {
                id: "permission",
                approved,
                reason: approved ? undefined : "User denied this tool call.",
              },
            },
          ],
        },
      ];
      activeModel = new MockLanguageModelV3({
        doStream: ({ prompt }) => {
          if (activeModel.doStreamCalls.length === 1) {
            expect(JSON.stringify(prompt)).toContain('"type":"tool-result"');
            expect(JSON.stringify(prompt)).not.toContain("New guidance");
          } else {
            expect(JSON.stringify(prompt)).toContain("New guidance");
          }
          return textStream("answer");
        },
      });
      try {
        const result = await runAgentStream({
          keys: EMPTY_PROVIDER_KEYS,
          model: modelRefForProvider("lmstudio", "approval-resume"),
          systemPrompt: "Stable prompt",
          allowedTools: ["shell_exec"],
          maxConcurrentSubagents: 3,
          turnCoordinator: coordinator,
          toolContext: {
            getCwd: () => "/workspace",
            getTerminalContext: () => null,
            isActiveTerminalPrivate: () => false,
            getSessionId: () => "approval-session",
            getPermissionMode: () => "ask",
            supportsApprovals: true,
          },
          uiMessages: messages,
          onCheckpoint: vi.fn(),
        });
        const chunks: Array<{ type: string }> = [];
        for await (const chunk of result.toUIMessageStream())
          chunks.push(chunk);
        expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([]);
        await expect(receipt).resolves.toBe("consumed");
        expect(activeModel.doStreamCalls).toHaveLength(2);
        expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      } finally {
        execute.mockRestore();
        await coordinator.cancelAll();
      }
    },
  );

  it.each([true, false])(
    "前台等待=%s 时，引导只在安全边界接入并先保存后展示",
    async (wait) => {
      const coordinator = new AgentTurnCoordinator();
      let finishChild!: (value: never) => void;
      let releaseCheckpoint!: () => void;
      const checkpointGate = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      const checkpoint = vi.fn(async (_messages, event) => {
        if (event.event === "user_steering") await checkpointGate;
      });
      activeModel = new MockLanguageModelV3({
        doStream: () =>
          activeModel.doStreamCalls.length === 1
            ? toolCallsStream(
                [
                  {
                    id: "spawn-guided",
                    name: "run_subagent",
                    input: { task: "Inspect", wait },
                  },
                ],
                "开始检查",
              )
            : textStream("answer"),
        doGenerate: () =>
          new Promise((resolve) => {
            finishChild = resolve as (value: never) => void;
          }),
      });
      const result = await runAgentStream({
        keys: EMPTY_PROVIDER_KEYS,
        model: modelRefForProvider("lmstudio", "guided"),
        systemPrompt: "Stable prompt",
        allowedTools: ["run_subagent"],
        maxConcurrentSubagents: 3,
        turnCoordinator: coordinator,
        toolContext: {
          getCwd: () => "/workspace",
          getTerminalContext: () => null,
          isActiveTerminalPrivate: () => false,
          getSessionId: () => "guided-session",
          getPermissionMode: () => "ask",
          supportsApprovals: true,
        },
        uiMessages: [
          {
            id: "initial",
            role: "user",
            parts: [{ type: "text", text: "inspect" }],
          },
        ],
        onCheckpoint: checkpoint,
      });
      const chunks: Array<{ type: string }> = [];
      const consuming = (async () => {
        for await (const chunk of result.toUIMessageStream())
          chunks.push(chunk);
      })();
      await vi.waitFor(() => expect(finishChild).toBeDefined());
      if (!wait)
        await vi.waitFor(() =>
          expect(activeModel.doStreamCalls.length).toBe(2),
        );
      const receipt = coordinator.inbox.steer({
        id: "guidance",
        role: "user",
        parts: [{ type: "text", text: "Focus on the parser" }],
      });
      expect(receipt).not.toBeNull();
      if (wait) {
        expect(checkpoint).not.toHaveBeenCalled();
        finishChild(childResult("done"));
      }
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalled());
      expect(checkpoint.mock.calls[0][1].event).toBe("user_steering");
      expect(chunks.some((chunk) => chunk.type === "data-user-steering")).toBe(
        false,
      );
      releaseCheckpoint();
      await expect(receipt).resolves.toBe("consumed");
      await vi.waitFor(() =>
        expect(
          chunks.some((chunk) => chunk.type === "data-user-steering"),
        ).toBe(true),
      );
      if (!wait) finishChild(childResult("done"));
      await consuming;
      expect(
        JSON.stringify(
          activeModel.doStreamCalls[activeModel.doStreamCalls.length - 1]
            ?.prompt,
        ),
      ).toContain("Focus on the parser");
      expect(coordinator.isIdle).toBe(true);
    },
  );

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
      turnCoordinator: new AgentTurnCoordinator(),
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000001",
        getPermissionMode: () => "ask",
        supportsApprovals: true,
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
    const coordinator = new AgentTurnCoordinator();
    const result = await runAgentStream({
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "mock-model-checkpoint"),
      systemPrompt: "Stable prompt",
      allowedTools: ["run_subagent"],
      maxConcurrentSubagents: 3,
      turnCoordinator: coordinator,
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => null,
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000002",
        getPermissionMode: () => "ask",
        supportsApprovals: true,
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
    await vi.waitFor(() => expect(coordinator.inbox.hasPending).toBe(true));
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
            input: { command: "curl https://example.com" },
          },
        ]),
      doGenerate: async () => childResult("background result"),
    });
    const coordinator = new AgentTurnCoordinator();
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
      turnCoordinator: coordinator,
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => null,
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "00000000-0000-4000-8000-000000000003",
        getPermissionMode: () => "ask",
        supportsApprovals: true,
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
    expect(coordinator.inbox.hasPending).toBe(true);
    await coordinator.cancelAll();
  });
});
