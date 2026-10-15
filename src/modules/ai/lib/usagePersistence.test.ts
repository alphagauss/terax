import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessage } from "./conversation";
import {
  persistCompletedTurn,
  persistTurnCheckpoint,
} from "./sessionPersistence";
import {
  recordUsage,
  pendingUsage,
  releaseUsage,
  restoreUsage,
  usageRecords,
} from "./usageRuntime";
import type { SessionFile } from "./sessions";
import type { UsageRecord } from "./usage";

const commit = vi.hoisted(() => vi.fn());
vi.mock("./sessions", () => ({ commitSession: commit }));
const session: SessionFile = {
  id: "usage-persistence",
  createdAt: 1,
  updatedAt: 2,
  environmentKey: "local",
  cwd: "/workspace",
  metadata: {},
  messages: [],
};
const record = (callId: string): UsageRecord => ({
  callId,
  turnId: "turn",
  model: { providerId: "test", modelId: "model" },
  contextWindow: 10000,
  values: { inputTokens: 10, outputTokens: 5 },
  estimated: [],
  toolCalls: 2,
  timing: { responseTimeMs: 1200, timeToFirstOutputMs: 200 },
});
afterEach(() => {
  releaseUsage(session.id);
  commit.mockReset();
});

describe("usage persistence", () => {
  it("retries failed saves and never appends checkpoint usage twice", async () => {
    const cursor = { persistedMessages: 0, committedParts: 0, turnId: "turn" };
    const saved: SessionMessage[] = [];
    recordUsage(session.id, record("first"));
    recordUsage(session.id, record("first"));
    commit.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      persistCompletedTurn(session, cursor, [], "cancelled"),
    ).rejects.toThrow("disk full");
    expect(pendingUsage(session.id, "now")).toHaveLength(1);
    commit.mockImplementation(async (input: SessionFile) => {
      saved.push(...input.messages);
    });
    await persistTurnCheckpoint(session, cursor, [], {
      event: "user_steering",
      message: {
        id: "guide",
        role: "user",
        parts: [{ type: "text", text: "continue" }],
      },
    });
    recordUsage(session.id, { ...record("child"), taskId: "task" });
    expect(usageRecords(session.id, true)).toHaveLength(0);
    // 此测试没有响应正文；用量批次独立于正文游标。
    cursor.committedParts = 0;
    await persistCompletedTurn(session, cursor, [], "cancelled");
    await persistCompletedTurn(session, cursor, [], "cancelled");
    expect(saved.filter((item) => item.role === "usage")).toHaveLength(2);
    expect(
      saved.filter((item) => item.role === "usage").map((item) => item.call_id),
    ).toEqual(["first", "child"]);
    expect(saved[0].content).not.toHaveProperty("id");
    expect(saved[0].content).not.toHaveProperty("callId");
    expect(usageRecords(session.id, true)).toHaveLength(2);
    restoreUsage(session.id, JSON.parse(JSON.stringify(saved)));
    expect(usageRecords(session.id)).toHaveLength(2);
    expect(usageRecords(session.id)[0].toolCalls).toBe(2);
    expect(usageRecords(session.id)[0].timing).toEqual({
      responseTimeMs: 1200,
      timeToFirstOutputMs: 200,
    });
    expect(pendingUsage(session.id, "now")).toEqual([]);
  });
});
