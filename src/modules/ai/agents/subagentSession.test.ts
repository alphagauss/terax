import {
  convertToAgentModelMessages,
  projectSessionMessages,
  type SessionMessage,
} from "@/modules/ai/lib/conversation";
import { describe, expect, it } from "vitest";
import {
  projectSubagentDisplays,
  restoredSubagentResult,
  restoreSubagentSessions,
  SubagentSessions,
  unfinishedToolResults,
} from "./subagentSession";

describe("subagent canonical history", () => {
  it("restores protocol metadata and isolates child records from the parent model", async () => {
    const record: SessionMessage = {
      role: "subagent",
      turn_id: "parent-1",
      timestamp: "2026-01-01T00:00:00Z",
      content: {
        taskId: "child",
        runId: "run-1",
        label: "Inspect",
        status: "completed",
        records: [
          {
            role: "user",
            content: "inspect",
            timestamp: "2026-01-01T00:00:00Z",
            turn_id: "run-1",
          },
          {
            role: "model",
            content: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "answer",
                    providerOptions: { test: { signature: "signed" } },
                  },
                ],
              },
            ],
            timestamp: "2026-01-01T00:00:01Z",
            turn_id: "run-1",
          },
        ],
      },
    };
    const task = required(restoreSubagentSessions([record]).get("child"));
    const store = new SubagentSessions();
    expect(await store.history(task)).toEqual([
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      ...(record.content.records ?? [])
        .filter((r) => r.role === "model")
        .flatMap((r) => r.content),
    ]);
    expect(
      await convertToAgentModelMessages(
        projectSessionMessages("parent", [record]),
      ),
    ).toEqual([]);
    const later: SessionMessage = {
      ...record,
      turn_id: "parent-2",
      content: {
        taskId: "child",
        runId: "run-2",
        label: "Inspect",
        status: "running",
        records: [
          { role: "user", content: "continue", timestamp: record.timestamp },
        ],
      },
    };
    expect(
      required(restoreSubagentSessions([record]).get("child")).records,
    ).toHaveLength(2);
    expect(
      required(restoreSubagentSessions([record, later]).get("child")).status,
    ).toBe("interrupted");
    expect(
      required(restoreSubagentSessions([record, later]).get("child")).records,
    ).toHaveLength(3);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing task");
  return value;
}

it("closes interrupted tool calls without replay and preserves recorded results", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "write",
          toolName: "write_file",
          input: { path: "a" },
          providerOptions: { test: { signature: "signed" } },
        },
      ],
    },
  ];
  const recovery = unfinishedToolResults(messages);
  expect(recovery).toMatchObject([
    {
      role: "tool",
      content: [{ toolCallId: "write", output: { type: "error-text" } }],
    },
  ]);
  expect(unfinishedToolResults([...messages, ...recovery])).toEqual([]);
  expect(messages[0].content[0].providerOptions).toEqual({
    test: { signature: "signed" },
  });
});

it("derives independent cards for repeated executions and respects the fork prefix", () => {
  const entry = (
    runId: string,
    content: Partial<import("./subagentSession").SubagentRecord>,
  ): SessionMessage => ({
    role: "subagent",
    timestamp: "2026-01-01T00:00:00Z",
    turn_id: runId,
    content: { taskId: "task", runId, label: "Inspect", ...content },
  });
  const first = [
    entry("first", { toolCallId: "spawn", status: "running", records: [
      { role: "user", content: "Inspect", timestamp: "now", turn_id: "first" },
    ] }),
    entry("first", { queued: { id: "queued", message: "Check cancellation" } }),
    entry("first", { consumed: ["queued"], records: [
      { role: "user", content: "Check cancellation", timestamp: "now", turn_id: "first" },
    ] }),
    entry("first", {
      execution: {
        id: "read",
        name: "read_file",
        input: { path: "a.txt" },
        status: "started",
      },
    }),
    entry("first", {
      execution: {
        id: "read",
        name: "read_file",
        output: { type: "tool-result", output: "a" },
        status: "finished",
      },
      status: "completed",
    }),
  ];
  const later = [
    entry("second", { toolCallId: "resume", status: "running" }),
    entry("second", { status: "cancelled" }),
  ];
  const original = projectSubagentDisplays(first);
  expect(original).toMatchObject([
    {
      taskId: "task",
      toolCallId: "spawn",
      runId: "first",
      parentTurnId: "first",
      instructions: ["Inspect", "Check cancellation"],
      status: "completed",
      steps: [{ id: "read", status: "completed" }],
    },
  ]);
  expect(projectSubagentDisplays([...first, ...later])).toEqual([
    ...original,
    expect.objectContaining({
      taskId: "task",
      toolCallId: "resume",
      status: "cancelled",
    }),
  ]);
});

it("restores the latest execution result and the original card without a background event", () => {
  const records: SessionMessage[] = [
    {
      role: "user",
      content: "old",
      turn_id: "old",
      timestamp: "2026-01-01T00:00:00Z",
    },
    {
      role: "model",
      content: [{ role: "assistant", content: "old answer" }],
      turn_id: "old",
      timestamp: "2026-01-01T00:00:01Z",
    },
    {
      role: "model",
      content: [{ role: "assistant", content: "new answer" }],
      turn_id: "new",
      timestamp: "2026-01-01T00:00:02Z",
    },
  ];
  const task = {
    taskId: "task",
    runId: "new",
    label: "Inspect",
    records,
    status: "completed" as const,
    pending: [],
  };
  expect(restoredSubagentResult(task)).toMatchObject({ result: "new answer" });
  expect(
    restoredSubagentResult({ ...task, runId: "empty", status: "failed" })
      .result,
  ).toBeUndefined();
  expect(
    projectSubagentDisplays([
      {
        role: "subagent",
        timestamp: "2026-01-01T00:00:00Z",
        content: {
          taskId: "task",
          runId: "new",
          label: "Inspect",
          toolCallId: "spawn",
          records: records.slice(2),
          status: "completed",
        },
      },
    ]),
  ).toMatchObject([{ toolCallId: "spawn", result: "new answer" }]);
});
