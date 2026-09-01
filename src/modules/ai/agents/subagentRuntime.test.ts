/**
 * 本文件测试单聊天 Subagent 协调器的并发、等待、结果顺序和取消不变量。
 * 测试使用可控 Promise，不发起真实模型或工具请求。
 */

import { describe, expect, it, vi } from "vitest";
import {
  isSubagentResultDataPart,
  SubagentTurnCoordinator,
  type SubagentTaskResult,
} from "./subagentRuntime";

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  cachedInputTokens: 0,
};

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

describe("SubagentTurnCoordinator", () => {
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
    const coordinator = new SubagentTurnCoordinator();
    const deferred = [deferredResult(), deferredResult(), deferredResult()];
    let index = 0;
    const run = vi.fn(() => deferred[index++].promise);

    const first = await coordinator.start({
      task: "first",
      wait: false,
      limit: 3,
      run,
    });
    const second = await coordinator.start({
      task: "second",
      wait: false,
      limit: 3,
      run,
    });
    const third = await coordinator.start({
      task: "third",
      wait: false,
      limit: 3,
      run,
    });
    const rejected = await coordinator.start({
      task: "fourth",
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

    deferred[2].resolve({ status: "completed", result: "third", usage });
    deferred[0].resolve({ status: "completed", result: "first", usage });
    deferred[1].resolve({ status: "completed", result: "second", usage });
    await coordinator.waitForAll();

    expect(
      coordinator.drainResultEvent()?.results.map((result) => result.label),
    ).toEqual(["first", "second", "third"]);
    expect(coordinator.runningCount).toBe(0);
  });

  it("returns wait=true results directly without enqueueing an event", async () => {
    const coordinator = new SubagentTurnCoordinator();
    const result = await coordinator.start({
      task: "inspect",
      label: "Inspector",
      wait: true,
      limit: 3,
      run: async () => ({ status: "completed", result: "done", usage }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        label: "Inspector",
        status: "completed",
        result: "done",
      }),
    );
    expect(coordinator.hasPendingResults).toBe(false);
  });

  it("cancels running tasks and discards their background notifications", async () => {
    const coordinator = new SubagentTurnCoordinator();
    const run = vi.fn(async () => ({
      status: "completed" as const,
      result: "late",
      usage,
    }));
    await coordinator.start({
      task: "long task",
      wait: false,
      limit: 3,
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
    expect(coordinator.drainResultEvent()).toBeNull();
    await expect(
      coordinator.start({
        task: "late task",
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
