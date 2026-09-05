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
  summarizeSubagentToolInput,
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
      summary: "src/file.ts",
      status: "running",
    },
  ],
};

describe("Subagent display data", () => {
  it("redacts and bounds persisted tool summaries", () => {
    const summary = summarizeSubagentToolInput("shell_exec", {
      command: `API_KEY=super-secret-value ${"x".repeat(200)}`,
    });

    expect(summary).toContain("API_KEY=<REDACTED>");
    expect(summary).not.toContain("super-secret-value");
    expect(summary?.length).toBeLessThanOrEqual(160);
  });

  it("treats structured tool error outputs as failed progress", () => {
    expect(isSubagentToolErrorOutput({ error: "permission denied" })).toBe(
      true,
    );
    expect(isSubagentToolErrorOutput({ content: "permission denied" })).toBe(
      false,
    );
  });

  it("terminalizes interrupted tasks without persisting task or result text", () => {
    const snapshot = toSubagentDisplaySnapshot(
      runningDisplay,
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
            output: { taskId: "task-1", status: "running" },
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
