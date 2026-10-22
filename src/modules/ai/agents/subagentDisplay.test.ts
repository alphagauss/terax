/**
 * 本文件测试 Subagent 展示摘要、终态快照和 UIMessage 挂载逻辑。
 * 测试锁定敏感值不会进入摘要，展示 data part 只关联原始工具调用。
 */

import { materializeSubagentDisplayParts } from "@/modules/ai/lib/conversation";
import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  isSubagentDisplaySnapshot,
  isSubagentToolErrorOutput,
  type SubagentDisplayState,
  toSubagentDisplaySnapshot,
} from "./subagentDisplay";

const runningDisplay: SubagentDisplayState = {
  taskId: "task-1",
  toolCallId: "parent-call-1",
  label: "Inspector",
  status: "running",
  phase: "tool",
  startedAt: 100,
  steps: [
    {
      id: "child-call-1",
      toolName: "read_file",
      summary: ["src/file.ts"],
      status: "running",
    },
  ],
};

describe("Subagent display data", () => {
  it("treats structured tool error outputs as failed progress", () => {
    expect(isSubagentToolErrorOutput({ error: "permission denied" })).toBe(
      true,
    );
    expect(isSubagentToolErrorOutput({ content: "permission denied" })).toBe(
      false,
    );
  });

  it.each(["running", "stopping"] as const)("terminalizes interrupted %s tasks without persisting task or result text", (status) => {
    const snapshot = toSubagentDisplaySnapshot(
      { ...runningDisplay, status },
      "cancelled",
      500,
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        taskId: "task-1",
        toolCallId: "parent-call-1",
        status: "cancelled",
        durationMs: 400,
        steps: [expect.objectContaining({ status: "cancelled" })],
      }),
    );
    expect(snapshot).not.toHaveProperty("task");
    expect(snapshot).not.toHaveProperty("result");
    expect(snapshot).not.toHaveProperty("startedAt");
    expect(isSubagentDisplaySnapshot(snapshot)).toBe(true);
  });

  it("rejects extra persisted fields that could impersonate live state", () => {
    const snapshot = toSubagentDisplaySnapshot(runningDisplay, "failed", 500);

    expect(
      isSubagentDisplaySnapshot({
        ...snapshot,
        phase: "thinking",
        result: "untrusted result",
      }),
    ).toBe(false);
  });

  it("keeps repeated tool IDs isolated by parent turn during restore and later commits", () => {
    const messages: UIMessage[] = ["old", "new"].map((turnId) => ({
      id: turnId, role: "assistant", metadata: { turnId },
      parts: [{ type: "dynamic-tool", toolName: "run_subagent", toolCallId: "same",
        state: "output-available", input: { task: turnId }, output: {} }],
    }));
    const snapshots = ["old", "new"].map((parentTurnId) => toSubagentDisplaySnapshot({
      ...runningDisplay, toolCallId: "same", parentTurnId, runId: parentTurnId,
      result: parentTurnId, status: "completed",
    }, "cancelled"));
    const restored = materializeSubagentDisplayParts(messages, snapshots);
    const results = (items: UIMessage[]) => items.map((message) =>
      (message.parts.find((part) => part.type === "data-subagent-display") as unknown as { data: { snapshot: { result: string } } }).data.snapshot.result);
    expect(results(restored)).toEqual(["old", "new"]);
    const withoutTurnMetadata = restored.map((message) => ({ ...message, metadata: {} }));
    expect(results(materializeSubagentDisplayParts(withoutTurnMetadata, [snapshots[1]]))).toEqual(["old", "new"]);
  });

  it("materializes a snapshot only beside its matching tool call", () => {
    const messages: UIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_subagent",
            toolCallId: "parent-call-1",
            state: "output-available",
            input: { task: "Inspect persistence" },
            output: { task_id: "task-1", status: "running" },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "Done", state: "done" }],
      },
    ];
    const snapshot = toSubagentDisplaySnapshot(runningDisplay, "failed", 500);

    const materialized = materializeSubagentDisplayParts(messages, [snapshot]);

    expect(materialized[0].parts.map((part) => part.type)).toEqual([
      "tool-run_subagent",
      "data-subagent-display",
    ]);
    expect(materialized[1]).toBe(messages[1]);
  });
});
