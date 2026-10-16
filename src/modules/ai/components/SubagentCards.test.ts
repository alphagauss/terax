import { expect, it } from "vitest";
import type { UIMessage, DynamicToolUIPart } from "ai";
import type { SubagentDisplaySnapshot } from "@/modules/ai/agents/subagentDisplay";
import { groupSubagentCards } from "./SubagentCards";

it("groups executions across message segments without exposing future turns or changing model facts", () => {
  const snapshot = (call: string, turn: string): SubagentDisplaySnapshot => ({
    version: 2,
    taskId: "abcd",
    runId: call,
    parentTurnId: turn,
    toolCallId: call,
    label: "Inspect",
    status: "completed",
    durationMs: 1,
    steps: [],
  });
  const displays = [
    snapshot("first", "turn-1"),
    snapshot("second", "turn-1"),
    { ...snapshot("first", "turn-2"), runId: "third" },
  ];
  const messages: UIMessage[] = displays.map((display) => ({
    id: display.toolCallId,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "run_subagent",
        toolCallId: display.toolCallId,
        input: { task: display.toolCallId },
        state: "output-available",
        output: { status: "completed" },
      },
    ],
    metadata: {
      subagents: {
        displaysByToolCallId: new Map([[display.toolCallId, display]]),
      },
    },
  }));
  messages[1].parts.unshift({
    type: "dynamic-tool",
    toolName: "subagent_task",
    toolCallId: "queued",
    input: { action: "send", taskId: "abcd", message: "supplement" },
    state: "output-available",
    output: { status: "queued" },
  });
  const first = messages[0].parts[0] as DynamicToolUIPart;
  const second = messages[1].parts[1] as DynamicToolUIPart;
  const third = messages[2].parts[0] as DynamicToolUIPart;
  const original = structuredClone(messages);
  const groups = groupSubagentCards(messages, {});
  expect(groups.get(first)).toBe(groups.get(second));
  expect(groups.has(messages[1].parts[0] as DynamicToolUIPart)).toBe(false);
  expect(
    groups.get(first)?.executions.map((item) => [item.number, item.current]),
  ).toEqual([
    [1, true],
    [2, true],
  ]);
  expect(
    groups.get(third)?.executions.map((item) => [item.number, item.current]),
  ).toEqual([
    [1, false],
    [2, false],
    [3, true],
  ]);
  expect(groups.get(first)?.anchor).toBe(first);
  const live = {
    ...displays[1],
    status: "running" as const,
    phase: "thinking" as const,
    startedAt: 0,
  };
  const updated = groupSubagentCards(messages, { second: live });
  expect(updated.get(first)?.executions[1].display).toBe(displays[1]);
  expect(messages).toEqual(original);
});
