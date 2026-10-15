/**
 * 本文件验证 Subagent 与用户引导共用当前 turn，安全边界接入后恢复主 Agent 循环。
 * 测试锁定活动在 Subagent 前结束、append-only 事件先 checkpoint，且最终模型正常响应。
 */

import { AgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import { modelRefForProvider } from "@/modules/ai/config";
import {
  runAgentStream,
  type SubagentModelConfiguration,
} from "@/modules/ai/lib/agent";
import {
  activityDurationFromPart,
  convertToAgentModelMessages,
  modelHistoryPart,
  projectSessionMessages,
  type SessionMessage,
  serializeSessionMessages,
} from "@/modules/ai/lib/conversation";
import {
  getFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { native } from "@/modules/ai/lib/native";
import { buildConfiguredLanguageModel } from "@/modules/ai/lib/providerRuntime";
import { usageRecords } from "@/modules/ai/lib/usageRuntime";
import type { UIMessage } from "@ai-sdk/react";
import { type ModelMessage, readUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

let activeModel: MockLanguageModelV4;

vi.mock("@/modules/ai/lib/providerRuntime", () => ({
  buildConfiguredLanguageModel: vi.fn(async () => activeModel),
  createProviderDownload: () => undefined,
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStream(text: string, reasoning?: string) {
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
  calls: Array<{ id: string; name: string; input: unknown }>,
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

function rootCalls() {
  return activeModel.doStreamCalls.filter(
    (call) => !JSON.stringify(call.prompt).includes("## SUBAGENT ROLE"),
  );
}

type StreamHandler = (
  options: Parameters<MockLanguageModelV4["doStream"]>[0],
) =>
  | ReturnType<MockLanguageModelV4["doStream"]>
  | Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

function mockModel(options: {
  doStream: StreamHandler;
  childStream?: StreamHandler;
}) {
  return new MockLanguageModelV4({
    doStream: async (call) =>
      options.childStream &&
      JSON.stringify(call.prompt).includes("## SUBAGENT ROLE")
        ? options.childStream(call)
        : options.doStream(call),
  });
}

describe.sequential("Agent background subagents", () => {
  it("每个子任务读取新配置，同一子任务的工具循环保持模型参数快照", async () => {
    const parent = modelRefForProvider("lmstudio", "parent");
    const config: SubagentModelConfiguration = {
      model: modelRefForProvider("lmstudio", "first-child"),
      keys: EMPTY_PROVIDER_KEYS,
      modelParameters: [
        { target: "standard", path: "temperature", value: 0.1 },
      ],
    };
    const childTemperatures: (number | undefined)[] = [];
    const readConfig = vi.fn(() => config);
    const factoryStart = vi.mocked(buildConfiguredLanguageModel).mock.calls
      .length;
    activeModel = mockModel({
      doStream: () =>
        rootCalls().length <= 2
          ? toolCallsStream([
              {
                id: `spawn-${rootCalls().length}`,
                name: "run_subagent",
                input: { task: "Inspect", wait: true },
              },
            ])
          : textStream("Done"),
      childStream: (call) => {
        childTemperatures.push(call.temperature);
        if (childTemperatures.length === 1) {
          config.model.modelId = "second-child";
          config.modelParameters = [
            { target: "standard", path: "temperature", value: 0.9 },
          ];
          return terminalToolStream();
        }
        return textStream("Child done");
      },
    });
    const result = await runAgentStream({
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: parent,
      getSubagentConfiguration: readConfig,
      systemPrompt: "Stable parent prompt",
      allowedTools: ["run_subagent", "get_terminal_output"],
      maxConcurrentSubagents: 1,
      turnCoordinator: new AgentTurnCoordinator(),
      toolContext: {
        getCwd: () => "/workspace",
        getSessionId: () => "child-config-snapshot",
        getPermissionMode: () => "ask",
        supportsApprovals: true,
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
      },
      uiMessages: [
        {
          id: "user",
          role: "user",
          parts: [{ type: "text", text: "Inspect twice" }],
        },
      ],
      onCheckpoint: async () => {},
    });
    expect(readConfig).not.toHaveBeenCalled();
    for await (const _chunk of result.toUIMessageStream()) {
      /* 消费完整工具循环。 */
    }
    expect(readConfig).toHaveBeenCalledTimes(2);
    expect(readConfig).toHaveBeenNthCalledWith(1, parent);
    expect(readConfig).toHaveBeenNthCalledWith(2, parent);
    expect(childTemperatures).toEqual([0.1, 0.1, 0.9]);
    expect(
      vi
        .mocked(buildConfiguredLanguageModel)
        .mock.calls.slice(factoryStart)
        .map(([model]) => model.modelId),
    ).toEqual(["parent", "first-child", "second-child"]);
  });

  it("Subagent 参数流实时发布编辑预估，提交事实归属父会话且不泄露子任务正文流", async () => {
    const sessionId = "stream-file-edit";
    const preview = vi.spyOn(native, "agentPrepareMutation").mockResolvedValue({
      files: [
        {
          path: "/workspace/a.txt",
          identity: "/workspace/a.txt",
          before: "",
          after: "new\nline\n",
          isNewFile: true,
          replacements: 0,
        },
      ],
    });
    const commit = vi.spyOn(native, "agentCommitMutation").mockResolvedValue({
      files: [{ path: "/workspace/a.txt", bytesWritten: 9, replacements: 0 }],
    });
    let finishInput!: () => void;
    let childCalls = 0;
    const displays = vi.fn();
    activeModel = mockModel({
      doStream: () =>
        rootCalls().length === 1
          ? toolCallsStream([
              {
                id: "spawn-edit",
                name: "run_subagent",
                input: { task: "Write a file", wait: true },
              },
            ])
          : textStream("Parent done"),
      childStream: async () => {
        if (++childCalls > 1)
          return textStream("Child done", "Private child reasoning");
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "tool-input-start",
                id: "child-edit",
                toolName: "write_file",
              });
              controller.enqueue({
                type: "tool-input-delta",
                id: "child-edit",
                delta: '{"path":"a.txt","content":"new\\n',
              });
              finishInput = () => {
                controller.enqueue({
                  type: "tool-input-delta",
                  id: "child-edit",
                  delta: 'line\\n"}',
                });
                controller.enqueue({
                  type: "tool-input-end",
                  id: "child-edit",
                });
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "child-edit",
                  toolName: "write_file",
                  input: JSON.stringify({
                    path: "a.txt",
                    content: "new\nline\n",
                  }),
                });
                controller.enqueue({
                  type: "finish",
                  usage,
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                });
                controller.close();
              };
            },
          }),
        } as never;
      },
    });
    try {
      const result = await runAgentStream({
        turnId: crypto.randomUUID(),
        keys: EMPTY_PROVIDER_KEYS,
        model: modelRefForProvider("lmstudio", "stream-edits"),
        systemPrompt: "Stable prompt",
        allowedTools: ["run_subagent", "write_file"],
        maxConcurrentSubagents: 1,
        turnCoordinator: new AgentTurnCoordinator(),
        toolContext: {
          getCwd: () => "/workspace",
          getSessionId: () => sessionId,
          getPermissionMode: () => "full-access",
          supportsApprovals: true,
          getTerminalContext: () => null,
          isActiveTerminalPrivate: () => false,
        },
        uiMessages: [
          {
            id: "user",
            role: "user",
            parts: [{ type: "text", text: "Write" }],
          },
        ],
        onSubagentDisplay: displays,
        onCheckpoint: async () => {},
      });
      const chunks: unknown[] = [];
      const consuming = (async () => {
        for await (const chunk of result.toUIMessageStream())
          chunks.push(chunk);
      })();
      await vi.waitFor(() => expect(finishInput).toBeDefined());
      const taskId = displays.mock.calls[0][0].taskId as string;
      const runtime = getFileEditRuntime(sessionId);
      await vi.waitFor(() =>
        expect(runtime.getCall("child-edit", taskId)).toMatchObject({
          approximate: true,
          added: 1,
        }),
      );
      expect(displays.mock.lastCall?.[0]).toMatchObject({
        phase: "tool",
        steps: [
          {
            id: "child-edit",
            toolName: "write_file",
            summary: ["a.txt"],
            status: "running",
          },
        ],
      });
      expect(preview).not.toHaveBeenCalled();
      finishInput();
      await consuming;
      expect(runtime.getCall("child-edit", taskId)).toMatchObject({
        approximate: false,
        added: 2,
        removed: 0,
      });
      expect(runtime.snapshot().files[0]).toMatchObject({
        path: "a.txt",
        after: "new\nline\n",
      });
      expect(JSON.stringify(chunks)).not.toContain("Private child reasoning");
    } finally {
      preview.mockRestore();
      commit.mockRestore();
      releaseFileEditRuntime(sessionId);
    }
  });

  it.each([true, false])(
    "审批响应=%s 时先落实工具结果，再接入引导",
    async (approved) => {
      const execute = vi.spyOn(native, "shellExec").mockResolvedValue({
        process_id: "approval-process",
        status: "exited",
        stdout: "test tool result",
        stderr: "",
        exit_code: 0,
        elapsed_ms: 1,
        truncated: false,
        dropped_bytes: 0,
        next_offset: 0,
        available_from: 0,
        cwd: "/workspace",
        cwd_after: null,
        wait_for_matched: null,
      });
      const coordinator = new AgentTurnCoordinator();
      coordinator.inbox.open();
      const receipt = coordinator.inbox.steer({
        id: "guidance-after-approval",
        role: "user",
        parts: [{ type: "text", text: "New guidance" }],
      });
      const checkpoint = vi.fn();
      const canonical: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Previous reasoning",
              providerOptions: { test: { signature: "reasoning-signature" } },
            },
            { type: "text", text: "Request permission" },
            {
              type: "tool-call",
              toolCallId: "shell-call",
              toolName: "shell_exec",
              input: { command: "curl https://example.com" },
              providerOptions: { test: { id: "tool-call" } },
            },
            {
              type: "tool-approval-request",
              toolCallId: "shell-call",
              approvalId: "permission",
              signature: "approval-signature",
            },
          ],
        },
      ];
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
            { type: "reasoning", text: "Previous reasoning", state: "done" },
            { type: "data-reasoning-duration", data: { durationMs: 17 } },
            { type: "text", text: "Request permission", state: "done" },
            {
              type: "tool-shell_exec",
              toolCallId: "shell-call",
              state: "approval-responded",
              input: { command: "curl https://example.com" },
              approval: {
                id: "permission",
                approved,
                reason: approved ? undefined : "User denied this tool call.",
                signature: "approval-signature",
              },
            },
            modelHistoryPart(canonical, "prior-call"),
          ],
        },
      ];
      activeModel = mockModel({
        doStream: ({ prompt }) => {
          if (rootCalls().length === 1) {
            expect(JSON.stringify(prompt)).toContain('"type":"tool-result"');
            expect(JSON.stringify(prompt)).not.toContain("New guidance");
          } else {
            expect(JSON.stringify(prompt)).toContain("New guidance");
          }
          return textStream("answer", "Fresh reasoning");
        },
      });
      try {
        const result = await runAgentStream({
          turnId: crypto.randomUUID(),
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
          onCheckpoint: checkpoint,
        });
        let streamed: UIMessage | undefined;
        for await (const message of readUIMessageStream({
          stream: result.toUIMessageStream(),
          message: structuredClone(messages[1]),
          terminateOnError: true,
        }))
          streamed = message;
        const prefix = checkpoint.mock.calls[0][0][0] as UIMessage;
        const options = {
          timestamp: "2026-09-06T00:00:00Z",
          turnId: "approval-turn",
        };
        expect(
          serializeSessionMessages(
            [
              {
                ...prefix,
                parts: streamed?.parts.slice(0, prefix.parts.length) ?? [],
              },
            ],
            options,
          ),
        ).toEqual(serializeSessionMessages([prefix], options));
        await expect(receipt).resolves.toBe("consumed");
        expect(rootCalls()).toHaveLength(2);
        expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
        expect(streamed).toBeDefined();
        if (!streamed) throw new Error("Missing completed approval message");
        const live = await convertToAgentModelMessages([messages[0], streamed]);
        const records: SessionMessage[] = JSON.parse(
          JSON.stringify(
            serializeSessionMessages([messages[0], streamed], options),
          ),
        );
        const restored = await convertToAgentModelMessages(
          projectSessionMessages("approval-restored", records),
        );
        const calls = records.flatMap((record) =>
          record.role === "model" &&
          record.call_id &&
          record.call_id !== "prior-call"
            ? [record.call_id]
            : [],
        );
        expect(calls).toEqual(
          usageRecords("approval-session")
            .slice(-2)
            .map((record) => record.callId),
        );
        expect(restored).toEqual(JSON.parse(JSON.stringify(live)));
        expect(
          restored.flatMap((item) =>
            item.role === "tool"
              ? item.content.filter(
                  (part) => part.type === "tool-approval-response",
                )
              : [],
          ),
        ).toHaveLength(1);
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
      activeModel = mockModel({
        doStream: () =>
          rootCalls().length === 1
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
        childStream: () =>
          new Promise((resolve) => {
            finishChild = resolve as (value: never) => void;
          }),
      });
      const result = await runAgentStream({
        turnId: crypto.randomUUID(),
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
      if (!wait) await vi.waitFor(() => expect(rootCalls().length).toBe(2));
      const receipt = coordinator.inbox.steer({
        id: "guidance",
        role: "user",
        parts: [{ type: "text", text: "Focus on the parser" }],
      });
      expect(receipt).not.toBeNull();
      if (wait) {
        expect(checkpoint).not.toHaveBeenCalled();
        finishChild(textStream("done"));
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
      if (!wait) finishChild(textStream("done"));
      await consuming;
      expect(
        JSON.stringify(rootCalls()[rootCalls().length - 1]?.prompt),
      ).toContain("Focus on the parser");
      expect(coordinator.isIdle).toBe(true);
    },
  );

  it("waits before terminal commit, checkpoints the result, and resumes the model", async () => {
    let resolveChild!: (value: never) => void;
    const childStarted = new Promise<void>((resolve) => {
      activeModel = mockModel({
        doStream: ({ prompt }) => {
          const rootCall = rootCalls().length;
          if (rootCall === 1) return spawnStream();
          if (rootCall === 2) return textStream("Provisional answer");
          if (rootCall === 3) {
            expect(JSON.stringify(prompt)).toContain("subagent_result");
            return terminalToolStream();
          }
          return textStream("Final answer");
        },
        childStream: () => {
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
      turnId: crypto.randomUUID(),
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
    resolveChild(textStream("Tests are healthy."));
    await consuming;

    expect(rootCalls()).toHaveLength(4);
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
    activeModel = mockModel({
      doStream: ({ prompt }) => {
        const rootCall = rootCalls().length;
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
      childStream: ({ prompt }) =>
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
      turnId: crypto.randomUUID(),
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

    let streamed: UIMessage | undefined;
    const consuming = (async () => {
      for await (const message of readUIMessageStream({
        stream: result.toUIMessageStream({ originalMessages: messages }),
      })) {
        streamed = message;
      }
    })();

    await vi.waitFor(() => expect(childResolvers.size).toBe(3));
    childResolvers.get("first background task")?.(textStream("first result"));
    childResolvers.get("blocking task")?.(textStream("blocking result"));
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledTimes(1));
    childResolvers.get("second background task")?.(textStream("second result"));
    await vi.waitFor(() => expect(coordinator.inbox.hasPending).toBe(true));
    releaseFirstCheckpoint();
    await consuming;

    expect(checkpoint).toHaveBeenCalledTimes(2);
    const checkpointCalls = checkpoint.mock.calls as unknown as Array<
      [UIMessage[]]
    >;
    expect(checkpointCalls[0][0]).toHaveLength(1);
    expect(checkpointCalls[1][0][0].parts).toContainEqual(
      expect.objectContaining({ type: "data-subagent-result" }),
    );
    for (const [prefix] of checkpointCalls) {
      expect(streamed?.parts.slice(0, prefix[0].parts.length)).toEqual(
        prefix[0].parts,
      );
    }
    expect(rootCalls()).toHaveLength(3);
  });

  it("defers background result injection while another tool awaits approval", async () => {
    activeModel = mockModel({
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
      childStream: async () => textStream("background result"),
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
      turnId: crypto.randomUUID(),
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
    await vi.waitFor(() => expect(coordinator.inbox.hasPending).toBe(true));
    await coordinator.cancelAll();
  });

  it("pauses without another request when the main Agent reaches its step limit", async () => {
    const finishMeta = vi.fn();
    activeModel = mockModel({
      doStream: () =>
        rootCalls().length <= 8
          ? toolCallsStream([
              {
                id: `terminal-${rootCalls().length}`,
                name: "get_terminal_output",
                input: rootCalls().length === 1 ? '{"invalid":true}' : {},
              },
            ])
          : textStream("Paused with a progress summary."),
    });
    const opts: Parameters<typeof runAgentStream>[0] = {
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "main-step-limit"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxAgentSteps: 8,
      maxConcurrentSubagents: 1,
      turnCoordinator: new AgentTurnCoordinator(),
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "main-step-limit",
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
      onFinishMeta: finishMeta,
      onCheckpoint: async () => {},
    };
    const result = await runAgentStream(opts);
    let completed: UIMessage | undefined;
    for await (const update of readUIMessageStream({
      stream: result.toUIMessageStream(),
    }))
      completed = update;

    expect(rootCalls()).toHaveLength(8);
    for (const call of rootCalls())
      expect(call.tools).toEqual(rootCalls()[0].tools);
    expect(finishMeta).toHaveBeenCalledWith(
      expect.objectContaining({ hitStepCap: true }),
    );
    expect(completed).toBeDefined();
    if (!completed) throw new Error("Missing completed message");
    const prefix = rootCalls()[7].prompt;
    const history = [...opts.uiMessages, completed];
    const nextUser: UIMessage = {
      id: "next",
      role: "user",
      parts: [{ type: "text", text: "continue" }],
    };
    const runNext = async (messages: UIMessage[]) => {
      const next = await runAgentStream({
        ...opts,
        turnId: crypto.randomUUID(),
        turnCoordinator: new AgentTurnCoordinator(),
        uiMessages: [...messages, nextUser],
      });
      for await (const _chunk of next.toUIMessageStream()) {
        /* 消费续接请求。 */
      }
      return rootCalls()[rootCalls().length - 1];
    };
    const inMemory = await runNext(history);
    expect(inMemory.prompt.slice(0, prefix.length)).toEqual(prefix);
    const records = JSON.parse(
      JSON.stringify(
        serializeSessionMessages(history, {
          turnId: opts.turnId,
          timestamp: "2026-09-20T00:00:00Z",
        }),
      ),
    );
    const restored = await runNext(projectSessionMessages("restored", records));
    expect(restored.prompt).toEqual(inMemory.prompt);
    expect(restored.tools).toEqual(inMemory.tools);
  });

  it("keeps the main Agent running without a step cap when configured as unlimited", async () => {
    const finishMeta = vi.fn();
    activeModel = mockModel({
      doStream: () =>
        rootCalls().length <= 9
          ? toolCallsStream([
              {
                id: `unlimited-terminal-${rootCalls().length}`,
                name: "get_terminal_output",
                input: {},
              },
            ])
          : textStream("Completed after continued tool use."),
    });
    const result = await runAgentStream({
      turnId: crypto.randomUUID(),
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "main-unlimited"),
      systemPrompt: "Stable prompt",
      allowedTools: ["get_terminal_output"],
      maxAgentSteps: null,
      maxConcurrentSubagents: 1,
      turnCoordinator: new AgentTurnCoordinator(),
      toolContext: {
        getCwd: () => "/workspace",
        getTerminalContext: () => "terminal output",
        isActiveTerminalPrivate: () => false,
        getSessionId: () => "main-unlimited",
        getPermissionMode: () => "ask",
        supportsApprovals: true,
      },
      uiMessages: [
        {
          id: "user",
          role: "user",
          parts: [{ type: "text", text: "Inspect until complete" }],
        },
      ],
      onFinishMeta: finishMeta,
      onCheckpoint: async () => {},
    });

    for await (const _chunk of result.toUIMessageStream()) {
      /* 消费完整无限步骤工具循环。 */
    }

    expect(rootCalls()).toHaveLength(10);
    expect(finishMeta).toHaveBeenCalledWith(
      expect.objectContaining({ hitStepCap: false }),
    );
  });

  it.each([false, true])(
    "stops a limited Subagent with stable tools, including an unwanted summary tool call: %s",
    async (summaryCallsTool) => {
      const displays = vi.fn();
      const terminalRead = vi.fn(() => "terminal output");
      let childCalls = 0;
      activeModel = mockModel({
        doStream: () =>
          rootCalls().length === 1
            ? toolCallsStream([
                {
                  id: "limited-child",
                  name: "run_subagent",
                  input: { task: "Inspect deeply", wait: true },
                },
              ])
            : textStream("Parent handled the incomplete result."),
        childStream: () =>
          ++childCalls <= 8
            ? toolCallsStream([
                {
                  id: `child-terminal-${childCalls}`,
                  name: "get_terminal_output",
                  input: {},
                },
              ])
            : summaryCallsTool
              ? toolCallsStream([
                  {
                    id: "forbidden-summary-call",
                    name: "get_terminal_output",
                    input: {},
                  },
                ])
              : textStream(
                  "Incomplete: inspected the available output; further checks remain.",
                ),
      });
      const result = await runAgentStream({
        turnId: crypto.randomUUID(),
        keys: EMPTY_PROVIDER_KEYS,
        model: modelRefForProvider("anthropic", "subagent-step-limit"),
        systemPrompt: "Stable prompt",
        allowedTools: ["run_subagent", "get_terminal_output"],
        maxSubagentSteps: 8,
        maxConcurrentSubagents: 1,
        turnCoordinator: new AgentTurnCoordinator(),
        toolContext: {
          getCwd: () => "/workspace",
          getTerminalContext: terminalRead,
          isActiveTerminalPrivate: () => false,
          getSessionId: () => "subagent-step-limit",
          getPermissionMode: () => "ask",
          supportsApprovals: true,
        },
        uiMessages: [
          {
            id: "user",
            role: "user",
            parts: [{ type: "text", text: "Delegate" }],
          },
        ],
        onSubagentDisplay: displays,
        onCheckpoint: async () => {},
      });

      for await (const _chunk of result.toUIMessageStream()) {
        /* 消费完整父子工具循环。 */
      }

      expect(
        displays.mock.calls[displays.mock.calls.length - 1]?.[0],
      ).toMatchObject({
        status: "incomplete",
        error: "Subagent reached its step limit before completing the task.",
      });
      expect(childCalls).toBe(9);
      expect(terminalRead).toHaveBeenCalledTimes(8);
      const summaryCall = activeModel.doStreamCalls
        .filter((call) =>
          JSON.stringify(call.prompt).includes("## SUBAGENT ROLE"),
        )
        .slice(-1)[0];
      expect(JSON.stringify(summaryCall?.prompt)).toContain(
        "reached its tool-step limit",
      );
      const firstChild = activeModel.doStreamCalls.find((call) =>
        JSON.stringify(call.prompt).includes("## SUBAGENT ROLE"),
      );
      expect(summaryCall?.tools).toEqual(firstChild?.tools);
      expect(summaryCall?.toolChoice).toEqual(firstChild?.toolChoice);
      const childRequests = activeModel.doStreamCalls.filter((call) =>
        JSON.stringify(call.prompt).includes("## SUBAGENT ROLE"),
      );
      for (const call of childRequests.slice(0, -1)) {
        expect(
          call.prompt[call.prompt.length - 1]?.providerOptions,
        ).toMatchObject({
          anthropic: { cacheControl: { type: "ephemeral" } },
        });
        expect(call.tools).toEqual(firstChild?.tools);
      }
      // 请求仅保留系统和当前尾部两个断点，不能随工具循环累积。
      for (const call of childRequests)
        expect(
          (JSON.stringify(call.prompt).match(/cacheControl/g) ?? []).length,
        ).toBe(2);
      const previous = childRequests[childRequests.length - 2];
      const content = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (key, value) =>
            key === "providerOptions" && value?.anthropic?.cacheControl
              ? undefined
              : value,
          ),
        );
      expect(
        content(summaryCall?.prompt.slice(0, previous.prompt.length)),
      ).toEqual(content(previous.prompt));
      if (!summaryCallsTool)
        expect(JSON.stringify(rootCalls().slice(-1)[0]?.prompt)).toContain(
          "Incomplete: inspected the available output; further checks remain.",
        );
    },
  );
});
