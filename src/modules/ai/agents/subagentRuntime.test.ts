/**
 * 本文件测试单聊天 Subagent 协调器的并发、等待、结果顺序和取消不变量。
 * 测试使用可控 Promise，不发起真实模型或工具请求。
 */

import type { SubagentDisplayState } from "@/modules/ai/agents/subagentDisplay";
import {
  AgentTurnCoordinator,
  type SubagentTaskResult,
} from "@/modules/ai/agents/subagentRuntime";
import { isSubagentResultDataPart } from "@/modules/ai/lib/conversation";
import { describe, expect, it, vi } from "vitest";

function deferredResult() {
  let resolve!: (
    result: Omit<SubagentTaskResult, "taskId" | "label" | "durationMs">,
  ) => void;
  const promise = new Promise<
    Omit<SubagentTaskResult, "taskId" | "label" | "durationMs">
  >((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AgentTurnCoordinator", () => {
  it("rejects malformed persisted result entries", () => {
    expect(
      isSubagentResultDataPart({
        type: "data-subagent-result",
        data: {
          event: { version: 1, event: "subagent_result", results: [null] },
        },
      }),
    ).toBe(false);
  });

  it("rejects the fourth concurrent task in one chat and preserves spawn order", async () => {
    const coordinator = new AgentTurnCoordinator();
    const deferred = [deferredResult(), deferredResult(), deferredResult()];
    let index = 0;
    const run = vi.fn(() => deferred[index++].promise);

    const first = await coordinator.start({
      task: "first",
      toolCallId: "call-first",
      wait: false,
      limit: 3,
      run,
    });
    const second = await coordinator.start({
      task: "second",
      toolCallId: "call-second",
      wait: false,
      limit: 3,
      run,
    });
    const third = await coordinator.start({
      task: "third",
      toolCallId: "call-third",
      wait: false,
      limit: 3,
      run,
    });
    const rejected = await coordinator.start({
      task: "fourth",
      toolCallId: "call-fourth",
      wait: false,
      limit: 3,
      run,
    });

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(third.status).toBe("running");
    expect(rejected).toEqual({
      status: "rejected",
      error: expect.stringContaining("(3/3 running)"),
    });

    deferred[2].resolve({ status: "completed", result: "third" });
    deferred[0].resolve({ status: "completed", result: "first" });
    deferred[1].resolve({ status: "completed", result: "second" });
    await coordinator.waitForAll();

    const event = coordinator.inbox.take()?.event;
    expect(
      event?.event === "subagent_result"
        ? event.results.map((result) => result.label)
        : [],
    ).toEqual(["first", "second", "third"]);
    expect(coordinator.runningCount).toBe(0);
  });

  it("returns wait=true results directly without enqueueing an event", async () => {
    const coordinator = new AgentTurnCoordinator();
    const result = await coordinator.start({
      task: "inspect",
      label: "Inspector",
      toolCallId: "call-inspect",
      wait: true,
      limit: 3,
      run: async () => ({ status: "completed", result: "done" }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        label: "Inspector",
        status: "completed",
        result: "done",
      }),
    );
    expect(coordinator.inbox.hasPending).toBe(false);
  });

  it("reports thinking, tool lifecycle and the final result as display state", async () => {
    const coordinator = new AgentTurnCoordinator();
    const displays: SubagentDisplayState[] = [];

    await coordinator.start({
      task: "inspect",
      label: "Inspector",
      toolCallId: "parent-call",
      wait: false,
      limit: 3,
      onDisplay: (display) => displays.push(display),
      run: async ({ onProgress }) => {
        onProgress({ type: "thinking" });
        onProgress({
          type: "tool-start",
          id: "child-call",
          toolName: "grep",
          summary: ["subagent_result"],
        });
        onProgress({
          type: "tool-finish",
          id: "child-call",
          status: "completed",
        });
        return { status: "completed", result: "done" };
      },
    });
    await coordinator.waitForAll();

    expect(displays[0]).toMatchObject({
      toolCallId: "parent-call",
      phase: "thinking",
      status: "running",
    });
    expect(displays).toContainEqual(
      expect.objectContaining({
        phase: "tool",
        steps: [
          expect.objectContaining({
            id: "child-call",
            status: "running",
          }),
        ],
      }),
    );
    expect(displays[displays.length - 1]).toMatchObject({
      status: "completed",
      result: "done",
      steps: [expect.objectContaining({ status: "completed" })],
    });
  });

  it("cancels running tasks and discards their background notifications", async () => {
    const coordinator = new AgentTurnCoordinator();
    const displays: SubagentDisplayState[] = [];
    const run = vi.fn(async () => ({
      status: "completed" as const,
      result: "late",
    }));
    await coordinator.start({
      task: "long task",
      toolCallId: "call-long",
      wait: false,
      limit: 3,
      onDisplay: (display) => displays.push(display),
      run: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    await coordinator.cancelAll();

    expect(coordinator.runningCount).toBe(0);
    expect(displays[displays.length - 1]?.status).toBe("cancelled");
    expect(coordinator.inbox.take()).toBeNull();
    await expect(
      coordinator.start({
        task: "late task",
        toolCallId: "call-late",
        wait: false,
        limit: 3,
        run,
      }),
    ).resolves.toEqual({
      status: "rejected",
      error: "Cannot start subagent: this turn is no longer active.",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("explicit subagent wait", () => {
  async function start(
    coordinator: AgentTurnCoordinator,
    deferred: ReturnType<typeof deferredResult>,
    taskId = "task",
    call = "spawn",
  ) {
    await coordinator.start({
      taskId,
      task: "inspect",
      toolCallId: call,
      wait: false,
      limit: 3,
      run: () => deferred.promise,
    });
  }

  it("times out without cancellation or consuming the eventual background result", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new AgentTurnCoordinator();
      const deferred = deferredResult();
      await start(coordinator, deferred);
      const waiting = coordinator.wait("task", 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waiting).toEqual({
        taskId: "task",
        status: "running",
        timedOut: true,
      });
      expect(coordinator.runningCount).toBe(1);
      deferred.resolve({ status: "completed", result: "done" });
      await coordinator.waitForAll();
      expect(coordinator.inbox.hasPending).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes only the waited execution, including already finished results", async () => {
    const coordinator = new AgentTurnCoordinator();
    const first = deferredResult();
    const second = deferredResult();
    await start(coordinator, first);
    await start(coordinator, second, "other", "other-call");
    const waiting = coordinator.wait("task", 30000);
    first.resolve({ status: "completed", result: "first" });
    second.resolve({ status: "failed", error: "second" });
    expect(await waiting).toMatchObject({ taskId: "task", result: "first" });
    await coordinator.waitForAll();
    expect(await coordinator.wait("other", 30000)).toMatchObject({
      status: "failed",
      error: "second",
    });
    expect(coordinator.inbox.hasPending).toBe(false);
    expect(await coordinator.wait("task", 30000)).toMatchObject({
      result: "first",
    });
  });

  it("binds waiting to the captured execution rather than a later resume", async () => {
    const coordinator = new AgentTurnCoordinator();
    const first = deferredResult();
    await start(coordinator, first);
    const waiting = coordinator.wait("task", 30000);
    first.resolve({ status: "completed", result: "first" });
    await coordinator.waitForAll();
    const second = deferredResult();
    await start(coordinator, second, "task", "resume");
    expect(await waiting).toMatchObject({ result: "first" });
    second.resolve({ status: "completed", result: "second" });
    await coordinator.waitForAll();
    expect(coordinator.inbox.take()?.event).toMatchObject({
      results: [{ toolCallId: "resume", result: "second" }],
    });
  });

  it("cancels waiting promptly even before the child finishes its cleanup", async () => {
    const coordinator = new AgentTurnCoordinator();
    const deferred = deferredResult();
    await start(coordinator, deferred);
    const waiting = coordinator.wait("task", 30000);
    const assertion = expect(waiting).rejects.toMatchObject({
      name: "AbortError",
    });
    const cancelling = coordinator.cancelAll();
    await assertion;
    deferred.resolve({ status: "cancelled" });
    await cancelling;
    expect(coordinator.inbox.hasPending).toBe(false);
  });
});
