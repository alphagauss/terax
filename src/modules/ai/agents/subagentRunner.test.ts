/** 验证真实 SDK 子任务续跑的前缀、引导与取消边界。 */

import { modelRefForProvider } from "@/modules/ai/config";
import type { RunAgentOptions } from "@/modules/ai/lib/agent";
import type { SessionMessage } from "@/modules/ai/lib/conversation";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { native } from "@/modules/ai/lib/native";
import {
  pendingUsage,
  releaseUsage,
  restoreUsage,
  usageRecords,
} from "@/modules/ai/lib/usageRuntime";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { buildSubagentTaskRunner } from "./subagentRunner";
import { AgentTurnCoordinator } from "./subagentRuntime";
import { restoreSubagentSessions, SubagentSessions } from "./subagentSession";
import { buildManagedSubagentTools } from "./subagentTools";

let model: MockLanguageModelV4;
vi.mock("@/modules/ai/lib/providerRuntime", () => ({
  buildConfiguredLanguageModel: async () => model,
  createProviderDownload: () => undefined,
}));
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
function stream(
  text: string,
  toolCallId?: string,
  toolName = "get_terminal_output",
  toolInput = "{}",
) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (toolCallId)
          controller.enqueue({
            type: "tool-call",
            toolCallId,
            toolName,
            input: toolInput,
            providerMetadata: { test: { signature: "signed-call" } },
          });
        controller.enqueue({ type: "text-start", id: "text" });
        controller.enqueue({ type: "text-delta", id: "text", delta: text });
        controller.enqueue({ type: "text-end", id: "text" });
        controller.enqueue({
          type: "finish",
          usage,
          finishReason: {
            unified: toolCallId ? "tool-calls" : "stop",
            raw: toolCallId ? "tool_calls" : "stop",
          },
        });
        controller.close();
      },
    }),
  } as never;
}
function runner(
  store: SubagentSessions,
  accepting = new Set<string>(),
  overrides: Partial<RunAgentOptions> = {},
  permissionMode: "ask" | "full-access" = "ask",
) {
  return buildSubagentTaskRunner({
    store,
    accepting,
    permissionMode,
    opts: {
      turnId: "parent-turn",
      keys: EMPTY_PROVIDER_KEYS,
      model: modelRefForProvider("lmstudio", "model"),
      systemPrompt: "stable system",
      allowedTools: [],
      toolContext: {
        getCwd: () => "/workspace",
        getSessionId: () => "child-test",
        getPermissionMode: () => "ask",
      },
      ...overrides,
    } as unknown as RunAgentOptions,
  });
}
const input = (task: string) => ({
  taskId: "child",
  toolCallId: crypto.randomUUID(),
  task,
  label: "Inspect",
  abortSignal: new AbortController().signal,
  onProgress: vi.fn(),
});
afterEach(() => releaseUsage("child-test"));
// 缓存断点是请求投影，不属于模型内容前缀；其数量必须有界。
function withoutCacheMarkers<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, value) => {
      if (key !== "providerOptions" || !value) return value;
      const options = structuredClone(value);
      if (options.anthropic) {
        delete options.anthropic.cacheControl;
        if (!Object.keys(options.anthropic).length) delete options.anthropic;
      }
      return Object.keys(options).length ? options : undefined;
    }),
  );
}

it.each(["lmstudio", "anthropic"] as const)(
  "keeps %s request prefixes stable through tools, steering and restored continuation",
  async (provider) => {
    let calls = 0;
    const journal: SessionMessage[] = [];
    const store = new SubagentSessions(async (content) => {
      journal.push({
        role: "subagent",
        content,
        timestamp: new Date().toISOString(),
        turn_id: "parent",
      });
    });
    model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1)
          required(store.tasks.get("child")).pending.push({
            id: "steer",
            message: "also inspect tests",
          });
        return stream("answer", calls <= 5 ? `tool-${calls}` : undefined);
      },
    });
    const options = {
      model: modelRefForProvider(provider, "model"),
      allowedTools: ["get_terminal_output"] as const,
      toolContext: {
        getCwd: () => "/workspace",
        supportsApprovals: false,
        getSessionId: () => "child-test",
        getPermissionMode: () => "ask",
        getTerminalContext: () => "terminal",
        isActiveTerminalPrivate: () => false,
      } as RunAgentOptions["toolContext"],
    };
    await runner(store, undefined, options)(input("first"));
    const firstRun = required(store.tasks.get("child")).runId;
    const restored = new SubagentSessions();
    for (const [id, task] of restoreSubagentSessions(journal))
      restored.tasks.set(id, task);
    const before = await restored.history(
      required(restored.tasks.get("child")),
    );
    expect(JSON.stringify(before)).not.toContain("cacheControl");
    await runner(restored, undefined, options)(input("second"));
    const requests = model.doStreamCalls;
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      expect(request.tools).toEqual(requests[0].tools);
      expect(
        (JSON.stringify(request.prompt).match(/cacheControl/g) ?? []).length,
      ).toBe(provider === "anthropic" ? 2 : 0);
      if (index)
        expect(
          withoutCacheMarkers(
            request.prompt.slice(0, requests[index - 1].prompt.length),
          ),
        ).toEqual(withoutCacheMarkers(requests[index - 1].prompt));
    }
    expect(JSON.stringify(requests[1].prompt)).toContain("also inspect tests");
    expect(JSON.stringify(requests[1].prompt)).toContain("signed-call");
    expect(
      (await restored.history(required(restored.tasks.get("child")))).slice(
        0,
        before.length,
      ),
    ).toEqual(before);
    const usage = usageRecords("child-test");
    expect(usage.slice(0, -1).every((call) => call.runId === firstRun)).toBe(
      true,
    );
    expect(usage[usage.length - 1].runId).toBe(
      required(restored.tasks.get("child")).runId,
    );
    expect(
      required(restored.tasks.get("child"))
        .records.filter((record) => record.role === "model")
        .map((record) => record.call_id),
    ).toEqual(usage.map((call) => call.callId));
    restoreUsage("child-test", pendingUsage("child-test", "now"));
    expect(usageRecords("child-test")).toEqual(usage);
  },
);

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing task");
  return value;
}

it("manages only owned tasks, keeps stable IDs and blocks exhausted resumes", async () => {
  const store = new SubagentSessions();
  model = new MockLanguageModelV4({ doStream: async () => stream("done") });
  const tools = buildManagedSubagentTools({
    turnId: "parent",
    keys: EMPTY_PROVIDER_KEYS,
    model: modelRefForProvider("lmstudio", "model"),
    systemPrompt: "stable",
    allowedTools: ["run_subagent", "subagent_task"],
    maxConcurrentSubagents: 1,
    turnCoordinator: new AgentTurnCoordinator(),
    openSubagentSessions: async () => store,
    toolContext: {
      getSessionId: () => "child-test",
      getPermissionMode: () => "ask",
    },
  } as unknown as RunAgentOptions);
  const invoke = async (
    name: "run_subagent" | "subagent_task",
    input: unknown,
  ) => {
    const execute = tools[name]?.execute;
    if (!execute) throw new Error("Missing tool");
    return (await execute(input as never, {
      toolCallId: crypto.randomUUID(),
      messages: [],
      context: {},
    })) as {
      taskId: string;
      status: string;
      history: unknown[];
      tasks: unknown[];
    };
  };
  expect(
    (
      await invoke("subagent_task", {
        action: "send",
        taskId: "foreign",
        message: "continue",
      })
    ).status,
  ).toBe("rejected");
  const started = await invoke("run_subagent", { task: "first", wait: true });
  expect(started.status).toBe("completed");
  const continued = await invoke("subagent_task", {
    action: "send",
    taskId: started.taskId,
    message: "second",
    wait: true,
  });
  expect(continued.taskId).toBe(started.taskId);
  expect(continued.status).toBe("completed");
  expect(
    await invoke("subagent_task", { action: "wait", taskId: started.taskId }),
  ).toMatchObject({
    taskId: started.taskId,
    status: "completed",
    result: "done",
  });
  expect(
    (await invoke("subagent_task", { action: "get", taskId: started.taskId }))
      .history,
  ).toHaveLength(4);
  expect(
    (await invoke("subagent_task", { action: "list" })).tasks,
  ).toHaveLength(1);
  expect(await invoke("subagent_task", { action: "list" })).toMatchObject({
    concurrency: { limit: 1, running: 0 },
  });
  expect(await invoke("subagent_task", { action: "get", taskId: "missing" })).toMatchObject({
    status: "rejected", error: "Task not found in this chat.",
  });
  const cleanup = vi.spyOn(native, "shellStopTask").mockResolvedValue();
  try {
    expect(await invoke("subagent_task", { action: "stop", taskId: started.taskId })).toMatchObject({
      status: "completed", cleanup: "completed",
    });
    expect(cleanup).toHaveBeenCalledWith("child-test", started.taskId);
    cleanup.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(invoke("subagent_task", { action: "stop", taskId: started.taskId })).rejects.toThrow("cleanup failed");
  } finally {
    cleanup.mockRestore();
  }
  required(store.tasks.get(started.taskId)).status = "context_exhausted";
  expect(
    (
      await invoke("subagent_task", {
        action: "send",
        taskId: started.taskId,
        message: "retry",
      })
    ).status,
  ).toBe("rejected");
  expect(model.doStreamCalls).toHaveLength(2);
});

it("waits for individual cancellation before resuming the same task", async () => {
  const store = new SubagentSessions();
  const coordinator = new AgentTurnCoordinator();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      entered();
      await new Promise<void>((resolve) => {
        if (abortSignal?.aborted) resolve();
        else
          abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return stream("cancelled");
    },
  });
  const result = await coordinator.start({
    task: "first",
    toolCallId: "spawn",
    wait: false,
    limit: 1,
    run: runner(store),
  });
  if (!("taskId" in result)) throw new Error("Task rejected");
  await started;
  await coordinator.stop(result.taskId);
  expect(coordinator.isRunning(result.taskId)).toBe(false);
  expect(required(store.tasks.get(result.taskId)).status).toBe("cancelled");
  model = new MockLanguageModelV4({ doStream: async () => stream("resumed") });
  const resumed = await coordinator.start({
    taskId: result.taskId,
    task: "continue",
    toolCallId: "resume",
    wait: true,
    limit: 1,
    run: runner(store),
  });
  expect(resumed).toMatchObject({
    taskId: result.taskId,
    status: "completed",
    result: "resumed",
  });
});

it("retains exhausted history and distinguishes ordinary failures", async () => {
  const exhausted = new SubagentSessions();
  model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("context_length_exceeded");
    },
  });
  await expect(runner(exhausted)(input("too long"))).rejects.toThrow();
  expect(required(exhausted.tasks.get("child")).status).toBe(
    "context_exhausted",
  );
  expect(required(exhausted.tasks.get("child")).records).not.toHaveLength(0);
  const failed = new SubagentSessions();
  model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("connection reset");
    },
  });
  await expect(runner(failed)(input("retryable"))).rejects.toThrow();
  expect(required(failed.tasks.get("child")).status).toBe("failed");
});

it.each(["started", "finished"] as const)(
  "fails closed when the tool %s journal cannot be saved",
  async (phase) => {
    const terminalRead = vi.fn(() => "actual result");
    const store = new SubagentSessions(async (entry) => {
      if (entry.execution?.status === phase) throw new Error("disk full");
    });
    model = new MockLanguageModelV4({
      doStream: async () => stream("inspect", "read"),
    });
    await expect(
      runner(store, undefined, {
        allowedTools: ["get_terminal_output"],
        toolContext: {
          getCwd: () => "/workspace",
          supportsApprovals: false,
          getSessionId: () => "child-test",
          getPermissionMode: () => "ask",
          getTerminalContext: terminalRead,
          isActiveTerminalPrivate: () => false,
        } as RunAgentOptions["toolContext"],
      })(input("inspect")),
    ).rejects.toThrow("disk full");
    expect(terminalRead).toHaveBeenCalledTimes(phase === "started" ? 0 : 1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(required(store.tasks.get("child")).status).toBe("failed");
  },
);

it("keeps the running child history and message inbox when approval recreates the parent tools", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  model = new MockLanguageModelV4({
    doStream: async () => {
      if (++calls === 1) {
        entered();
        await gate;
      }
      return stream("done");
    },
  });
  const store = new SubagentSessions();
  const open = vi.fn(async () => store);
  const options = {
    turnId: "parent",
    keys: EMPTY_PROVIDER_KEYS,
    model: modelRefForProvider("lmstudio", "model"),
    systemPrompt: "stable",
    allowedTools: ["run_subagent", "subagent_task"],
    maxConcurrentSubagents: 1,
    turnCoordinator: new AgentTurnCoordinator(),
    openSubagentSessions: open,
    toolContext: {
      getSessionId: () => "child-test",
      getPermissionMode: () => "ask",
    },
  } as unknown as RunAgentOptions;
  const before = buildManagedSubagentTools(options);
  const execution = { toolCallId: "create", messages: [], context: {} };
  const created = (await before.run_subagent?.execute?.(
    { task: "first", wait: false },
    execution,
  )) as { taskId: string };
  await started;
  const after = buildManagedSubagentTools(options);
  const sent = await after.subagent_task?.execute?.(
    {
      action: "send",
      taskId: created.taskId,
      message: "additional requirement",
    },
    { ...execution, toolCallId: "send" },
  );
  expect(sent).toMatchObject({ status: "queued" });
  release();
  expect(
    await after.subagent_task?.execute?.(
      { action: "wait", taskId: created.taskId },
      { ...execution, toolCallId: "wait" },
    ),
  ).toMatchObject({ status: "completed", result: "done" });
  expect(open).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
    "additional requirement",
  );
  expect(options.turnCoordinator.inbox.hasPending).toBe(false);
});

it("does not finish cancellation until an in-flight native operation and its journal have settled", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi
    .spyOn(native, "agentFileRead")
    .mockImplementation(async () => {
      entered();
      await gate;
      return {
        content: "data",
        total_lines: 1,
        start_line: 1,
        end_line: 1,
        truncated: false,
      } as never;
    });
  try {
    const store = new SubagentSessions();
    const coordinator = new AgentTurnCoordinator();
    model = new MockLanguageModelV4({
      doStream: async () =>
        stream("", "read", "read_file", JSON.stringify({ path: "a.txt" })),
    });
    const created = await coordinator.start({
      task: "read",
      toolCallId: "spawn",
      wait: false,
      limit: 1,
      run: runner(store, undefined, {
        allowedTools: ["read_file"],
        toolContext: {
          getCwd: () => "/workspace",
          getSessionId: () => "child-test",
          getPermissionMode: () => "ask",
        } as RunAgentOptions["toolContext"],
      }),
    });
    if (!("taskId" in created)) throw new Error("Task rejected");
    await started;
    const stopping = coordinator.stop(created.taskId);
    await Promise.resolve();
    expect(coordinator.isRunning(created.taskId)).toBe(true);
    release();
    await stopping;
    expect(coordinator.isRunning(created.taskId)).toBe(false);
    expect(required(store.tasks.get(created.taskId)).executions).toContainEqual(
      expect.objectContaining({ id: "read", status: "finished" }),
    );
  } finally {
    release();
    read.mockRestore();
  }
});

it("terminates the child's native execution before cancellation completes and resumes with the same short ID", async () => {
  const store = new SubagentSessions();
  const coordinator = new AgentTurnCoordinator();
  let finishCommand!: (value: never) => void;
  const command = new Promise<never>((resolve) => {
    finishCommand = resolve;
  });
  const open = vi.spyOn(native, "shellOpenExecution").mockResolvedValue();
  const close = vi.spyOn(native, "shellCloseExecution").mockResolvedValue();
  const execute = vi.spyOn(native, "shellExec").mockReturnValue(command);
  const stop = vi
    .spyOn(native, "shellStopExecution")
    .mockImplementation(async () => {
      finishCommand({ status: "terminated", stdout: "", stderr: "" } as never);
    });
  try {
    model = new MockLanguageModelV4({
      doStream: async () =>
        stream("", "shell", "shell_exec", '{"command":"sleep 600"}'),
    });
    const run = runner(
      store,
      undefined,
      { allowedTools: ["shell_exec"] },
      "full-access",
    );
    const created = await coordinator.start({
      task: "inspect",
      toolCallId: "spawn",
      wait: false,
      limit: 1,
      run,
    });
    if (!("taskId" in created)) throw new Error("Task rejected");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await coordinator.stop(created.taskId);
    expect(open).toHaveBeenCalledWith(
      "child-test",
      expect.any(String),
      created.taskId,
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(store.tasks.get(created.taskId)).toMatchObject({
      status: "cancelled",
      error: undefined,
    });
    expect(await coordinator.wait(created.taskId, 1000)).toMatchObject({
      status: "cancelled",
    });
    expect(
      JSON.stringify(await coordinator.wait(created.taskId, 1000)),
    ).not.toContain("AbortError");
    model = new MockLanguageModelV4({
      doStream: async () => stream("resumed"),
    });
    const resumed = await coordinator.start({
      taskId: created.taskId,
      task: "continue",
      toolCallId: "resume",
      wait: true,
      limit: 1,
      run,
    });
    expect(resumed).toMatchObject({
      taskId: created.taskId,
      status: "completed",
      result: "resumed",
    });
  } finally {
    finishCommand({ status: "terminated" } as never);
    open.mockRestore();
    close.mockRestore();
    execute.mockRestore();
    stop.mockRestore();
  }
});
