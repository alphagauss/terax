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
          summary: "subagent_result",
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
