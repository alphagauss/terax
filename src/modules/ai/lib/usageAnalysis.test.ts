import { expect, it } from "vitest";
import type { UsageRecord } from "./usage";
import {
  analyzeCacheUsage,
  analyzeSessionCacheUsage,
  changedPromptTurns,
} from "./usageAnalysis";

function record(
  callId: string,
  inputTokens: number,
  cacheReadTokens: number | undefined,
  patch: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    callId,
    turnId: "turn",
    model: { providerId: "provider", modelId: "model" },
    contextWindow: 128000,
    values: { inputTokens, cacheReadTokens, outputTokens: 100 },
    estimated: [],
    toolCalls: 0,
    ...patch,
  };
}

it("uses the previous input as the reusable prefix despite a large new tool result", () => {
  const analysis = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("tool-result", 30000, 10000),
    record("after-tool", 31000, 30000),
  ]);

  expect(analysis.status).toBe("healthy");
  expect(analysis.incidents).toHaveLength(0);
  expect(analysis.latest).toMatchObject({
    requestHitRate: 30000 / 31000,
    prefixReuseCoverage: 1,
  });
});

it("detects a sharp cache regression from the learned healthy baseline", () => {
  const analysis = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("healthy", 12000, 9000),
    record("regressed", 13000, 4000),
  ]);

  expect(analysis.status).toBe("suspected");
  expect(analysis.incidents).toHaveLength(1);
  expect(analysis.incidents[0]).toMatchObject({
    previousCallId: "healthy",
    currentCallId: "regressed",
    baselineCoverage: 0.9,
    expectedTokens: 10800,
    prefixReuseCoverage: 1 / 3,
  });
});

it("detects a sharp absolute cache drop before a baseline exists", () => {
  const analysis = analyzeCacheUsage([
    record("first", 100000, 90000),
    record("regressed", 110000, 30000),
  ]);

  expect(analysis.status).toBe("suspected");
  expect(analysis.incidents[0]).toMatchObject({
    previousCallId: "first",
    currentCallId: "regressed",
    expectedTokens: 90000,
    cacheReadTokens: 30000,
  });
});

it("does not report a small cache fluctuation as an incident", () => {
  const analysis = analyzeCacheUsage([
    record("first", 100000, 90000),
    record("second", 110000, 80000),
  ]);

  expect(analysis.status).toBe("healthy");
  expect(analysis.incidents).toHaveLength(0);
});

it("does not treat a consistently low cache share as a regression without a healthy baseline", () => {
  const analysis = analyzeCacheUsage([
    record("first", 10000, 3000),
    record("second", 11000, 3000),
    record("third", 12000, 3300),
  ]);

  expect(analysis.status).toBe("insufficient");
  expect(analysis.incidents).toHaveLength(0);
});

it("keeps an incident after the cache recovers", () => {
  const analysis = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("healthy", 12000, 9000),
    record("regressed", 13000, 4000),
    record("recovered", 14000, 12500),
  ]);

  expect(analysis.status).toBe("recovered");
  expect(analysis.incidents).toHaveLength(1);
});

it("keeps an incident as history when a later compaction resets the baseline", () => {
  const analysis = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("healthy", 12000, 9000),
    record("regressed", 13000, 4000),
    record("compaction", 13000, 4000, { purpose: "compaction" }),
    record("after", 8000, 0),
  ]);

  expect(analysis.status).toBe("historical");
  expect(analysis.incidents).toHaveLength(1);
});

it("resets comparison across compaction and model changes", () => {
  const compacted = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("healthy", 12000, 9000),
    record("compaction", 12000, 9000, { purpose: "compaction" }),
    record("after", 13000, 1000),
  ]);
  const switched = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("healthy", 12000, 9000),
    record("after", 13000, 1000, {
      model: { providerId: "provider", modelId: "other" },
    }),
  ]);

  expect(compacted.incidents).toHaveLength(0);
  expect(switched.incidents).toHaveLength(0);
});

it("ignores subagents, missing cache data, estimated input and shrinking context", () => {
  const analysis = analyzeCacheUsage([
    record("first", 10000, 9000),
    record("healthy", 12000, 9000),
    record("child", 50000, 0, { taskId: "child" }),
    record("missing", 13000, undefined),
    record("estimated", 14000, 0, { estimated: ["inputTokens"] }),
    record("shrunk", 5000, 0),
  ]);

  expect(analysis.incidents).toHaveLength(0);
});

it("reports unavailable when the provider never reports cache usage", () => {
  expect(
    analyzeCacheUsage([
      record("first", 10000, undefined),
      record("second", 11000, undefined),
    ]).status,
  ).toBe("unavailable");
});

it("isolates interleaved task baselines and diagnoses the first resumed call", () => {
  const analysis = analyzeSessionCacheUsage([
    record("main-a", 10000, 9000),
    record("child-a", 20000, 18000, { taskId: "child", runId: "run-1" }),
    record("other-a", 50000, 40000, { taskId: "other" }),
    record("child-b", 22000, 19000, { taskId: "child", runId: "run-1" }),
    record("main-compact", 11000, 0, { purpose: "compaction" }),
    record("main-b", 12000, 0),
    record("resumed", 24000, 1000, {
      taskId: "child",
      runId: "run-2",
      turnId: "later-turn",
    }),
    record("other-b", 51000, 45000, { taskId: "other" }),
  ]);
  expect(analysis.flatMap((item) => item.incidents)).toEqual([
    expect.objectContaining({
      taskId: "child",
      runId: "run-2",
      turnId: "later-turn",
      previousCallId: "child-b",
      currentCallId: "resumed",
    }),
  ]);
  const recovered = analyzeCacheUsage(
    [
      record("a", 10000, 9000, { taskId: "child" }),
      record("b", 11000, 0, { taskId: "child" }),
      record("c", 12000, 11000, { taskId: "child" }),
    ],
    "child",
  );
  expect(recovered.status).toBe("recovered");
});

it("does not compare new tasks or treat missing subagent cache usage as a miss", () => {
  expect(
    analyzeSessionCacheUsage([
      record("a", 10000, 9000, { taskId: "a" }),
      record("b", 11000, 0, { taskId: "b" }),
      record("a-missing", 12000, undefined, { taskId: "a" }),
    ]).flatMap((item) => item.incidents),
  ).toEqual([]);
});

it("跨轮缓存下降仍提示，不把下降当作系统指令变化", () => {
  const context = {
    overheadHash: "same",
    prefixHash: "prefix",
    messageCount: 2,
  };
  const records = [
    record("before", 10000, 9000, {
      turnId: "a",
      context,
    }),
    record("after", 12000, 0, {
      turnId: "b",
      context,
    }),
  ];
  expect(analyzeCacheUsage(records).status).toBe("suspected");
  expect(analyzeCacheUsage(records).incidents).toHaveLength(1);
  expect(changedPromptTurns(records)).toEqual(new Set());
});

it("提示只比较跨轮主请求，恢复后同轮不重复，缺失指纹不猜测", () => {
  const call = (
    id: string,
    turnId: string,
    overheadHash: string,
    patch: Partial<UsageRecord> = {},
  ) =>
    record(id, 10000, 0, {
      turnId,
      context: { overheadHash, prefixHash: "prefix", messageCount: 2 },
      ...patch,
    });
  const records = [
    call("first", "a", "original"),
    call("child", "child", "child", { taskId: "child" }),
    call("compact", "a", "compact", { purpose: "compaction" }),
    call("changed", "b", "updated"),
    call("step", "b", "updated"),
    call("same", "c", "updated"),
    call("reverted", "d", "original"),
    record("unknown", 10000, 0, { turnId: "e" }),
    call("after-unknown", "f", "updated"),
    call("provider-switch", "g", "provider-cache-marker", {
      model: { providerId: "another", modelId: "model" },
    }),
    call("new-provider-change", "h", "new-instructions", {
      model: { providerId: "another", modelId: "model" },
    }),
  ];
  expect(changedPromptTurns(JSON.parse(JSON.stringify(records)))).toEqual(
    new Set(["b", "d", "h"]),
  );
  expect(analyzeCacheUsage(records.slice(0, 4)).incidents).toEqual([]);
});
