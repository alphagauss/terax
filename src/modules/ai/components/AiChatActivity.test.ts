/**
 * 本文件测试聊天消息中的活动分组和工具结果展示。
 * 锁定正文与 Subagent 分组边界，并确保业务错误和用户拒绝得到准确展示。
 */

import type { UIMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { preloadEn } from "@/i18n";
import {
  activityHeadline,
  buildMessageGroups,
  resolveToolDisplay,
  subagentResultForPart,
} from "./AiChat";

describe("activity headline summaries", () => {
  beforeAll(() => preloadEn());
  const headline = (
    tool: string,
    input: unknown,
    state = "input-streaming",
  ) => {
    const result = activityHeadline({
      type: `tool-${tool}`,
      toolCallId: "call",
      state,
      input,
    } as Parameters<typeof activityHeadline>[0]);
    if (result?.kind !== "tool") throw new Error("Expected a tool headline");
    return result;
  };

  it("shows the tool action before meaningful fields and then adds the summary", () => {
    expect(headline("shell_exec", {})).toMatchObject({
      kind: "tool",
      text: "shell_exec",
    });
    expect(headline("shell_exec", { command: " \n " })).toMatchObject({
      kind: "tool",
      text: "shell_exec",
    });
    expect(headline("shell_exec", { command: "Get-Date" })?.text).toBe(
      "Get-Date",
    );
    expect(headline("write_file", { path: "src/app.tsx" })?.text).toBe(
      "src/app.tsx",
    );
    expect(headline("apply_patch", { files: [{}] })).toMatchObject({
      kind: "tool",
      text: "apply_patch",
    });
    expect(headline("apply_patch", { files: [{ path: "a.ts" }] })?.text).toBe(
      "a.ts",
    );
    expect(headline("find_files", {})).toMatchObject({
      kind: "tool",
      text: "find_files",
    });
    expect(headline("find_files", {}, "input-available")?.text).toBe(
      "List directory · .",
    );
  });

  it("uses search conditions and process actions instead of opaque IDs", () => {
    expect(headline("shell_exec", { command: "pnpm test" })).toMatchObject({
      action: "shell_exec",
      text: "pnpm test",
    });
    expect(headline("read_file", { path: "a.ts" })).toMatchObject({
      action: "read_file",
      text: "a.ts",
    });
    expect(headline("write_file", { path: "a.ts" })).toMatchObject({
      action: "write_file",
      text: "a.ts",
    });
    expect(
      headline("file_operation", {
        operation: "move",
        path: "a.ts",
        destination: "b.ts",
      }),
    ).toMatchObject({ action: "file_operation", text: "Move · a.ts → b.ts" });
    expect(
      headline("find_files", { glob: "**/*.tsx", path: "src" })?.text,
    ).toBe("src · **/*.tsx");
    expect(
      headline("shell_process", {
        action: "terminate",
        process_id: "opaque-id",
      })?.text,
    ).toBe("Terminate · opaque-id");
    expect(headline("get_terminal_output", {})?.text).toBe(
      "get_terminal_output",
    );
  });

  it("bounds a single-line summary without changing the command", () => {
    const input = { command: `echo  one\n\t${"x".repeat(200)}` };
    const original = input.command;
    const result = headline("shell_exec", input);
    expect(result?.text).toHaveLength(160);
    expect(result?.text).toMatch(/^echo one x+…$/);
    expect(input.command).toBe(original);
  });
});

describe("AI chat activity grouping", () => {
  it("shows structured tool failures as errors", () => {
    expect(
      resolveToolDisplay({
        type: "tool-find_files",
        toolCallId: "find-1",
        state: "output-available",
        input: { path: "/workspace" },
        output: { error: "workspace unavailable" },
      }),
    ).toEqual({
      state: "output-error",
      errorText: "workspace unavailable",
    });
  });

  it("keeps approval denial distinct from execution errors", () => {
    const display = resolveToolDisplay({
      type: "tool-shell_exec",
      toolCallId: "shell-1",
      state: "output-denied",
      input: { command: "curl https://example.com" },
      approval: { id: "approval-1", approved: false },
    });
    expect(display.state).toBe("output-denied");
    expect(display.errorText).toBeUndefined();
  });

  it("uses text and Subagent as the only visible activity boundaries", () => {
    const parts: UIMessage["parts"] = [
      { type: "reasoning", text: "先读取终端。", state: "done" },
      {
        type: "data-activity-duration",
        data: { durationMs: 1000 },
      },
      { type: "text", text: "\n\n", state: "done" },
      {
        type: "tool-get_terminal_output",
        toolCallId: "terminal-1",
        state: "output-available",
        input: {},
        output: { output: "terminal output" },
      },
      { type: "step-start" },
      { type: "reasoning", text: "整理终端内容。", state: "done" },
      { type: "text", text: "阶段正文", state: "done" },
      { type: "data-activity-duration", data: { durationMs: 4000 } },
      {
        type: "tool-run_subagent",
        toolCallId: "subagent-1",
        state: "input-available",
        input: { task: "检查测试", wait: true },
      },
      {
        type: "tool-shell_exec",
        toolCallId: "shell-1",
        state: "input-available",
        input: { command: "pnpm test" },
      },
      { type: "data-activity-duration", data: { durationMs: 800 } },
      { type: "text", text: "最终正文", state: "done" },
    ] as UIMessage["parts"];

    const groups = buildMessageGroups(parts as never);
    expect(groups.map((group) => group.kind)).toEqual([
      "activity",
      "single",
      "single",
      "activity",
      "single",
    ]);
    expect(groups[0]).toMatchObject({
      kind: "activity",
      durationMs: 5000,
      groups: [
        { kind: "single", part: { type: "reasoning" } },
        { kind: "single", part: { type: "tool-get_terminal_output" } },
        { kind: "single", part: { type: "reasoning" } },
      ],
    });
    expect(groups[1]).toMatchObject({
      kind: "single",
      part: { type: "text" },
    });
    expect(groups[2]).toMatchObject({
      kind: "single",
      part: { type: "tool-run_subagent" },
    });
    expect(groups[3]).toMatchObject({
      kind: "activity",
      durationMs: 800,
      groups: [{ kind: "single", part: { type: "tool-shell_exec" } }],
    });
    expect(groups[4]).toMatchObject({
      kind: "single",
      part: { type: "text" },
    });
  });

  it("keeps actual resumed tasks outside activity blocks and management calls inside", () => {
    const tool = (id: string, action: string, status: string) => ({
      type: "tool-subagent_task",
      toolCallId: id,
      state: "output-available",
      input: { action, task_id: "task" },
      output: { task_id: "task", status },
    });
    const groups = buildMessageGroups([
      tool("queued", "send", "queued"),
      tool("get", "get", "completed"),
      tool("resume", "send", "completed"),
      tool("stop", "stop", "cancelled"),
      tool("rejected", "send", "rejected"),
    ] as never);
    expect(groups.map((group) => group.kind)).toEqual([
      "activity",
      "single",
      "activity",
    ]);
    expect(groups[1]).toMatchObject({
      kind: "single",
      part: { toolCallId: "resume" },
    });
    expect(groups[0]).toMatchObject({
      groups: [
        { part: { toolCallId: "queued" } },
        { part: { toolCallId: "get" } },
      ],
    });
  });

  it("uses execution display facts to separate a resumed task before its tool result arrives", () => {
    const parts = [
      {
        type: "tool-subagent_task",
        toolCallId: "queued",
        state: "input-available",
        input: { action: "send", task_id: "old" },
      },
      {
        type: "tool-subagent_task",
        toolCallId: "resumed",
        state: "input-available",
        input: { action: "send", task_id: "old" },
      },
    ];
    expect(
      buildMessageGroups(parts as never).map((group) => group.kind),
    ).toEqual(["activity"]);
    const groups = buildMessageGroups(parts as never, new Set(["resumed"]));
    expect(groups.map((group) => group.kind)).toEqual(["activity", "single"]);
    expect(groups[1]).toMatchObject({ part: { toolCallId: "resumed" } });
  });

  it("groups External Agent tools and stops each activity block before text", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "dynamic-tool",
        toolName: "external_agent_start",
        toolCallId: "external-1",
        state: "output-available",
        input: { agentId: "codex" },
        output: null,
      },
      {
        type: "dynamic-tool",
        toolName: "external_agent_thinking",
        toolCallId: "external-2",
        state: "output-available",
        input: { agentId: "codex" },
        output: null,
      },
      { type: "text", text: "先检查。", state: "done" },
      {
        type: "tool-shell_exec",
        toolCallId: "external-3",
        state: "output-available",
        input: { command: "Get-Location" },
        output: null,
      },
      { type: "text", text: "完成。", state: "done" },
    ];

    const groups = buildMessageGroups(parts as never);
    expect(groups.map((group) => group.kind)).toEqual([
      "activity",
      "single",
      "activity",
      "single",
    ]);
    expect(groups[0]).toMatchObject({
      kind: "activity",
      completed: true,
      groups: [
        { kind: "single", part: { toolCallId: "external-1" } },
        { kind: "single", part: { toolCallId: "external-2" } },
      ],
      headlinePart: { toolCallId: "external-2" },
    });
    expect(groups[2]).toMatchObject({
      kind: "activity",
      completed: true,
      groups: [{ kind: "single", part: { toolCallId: "external-3" } }],
    });
  });
});

it("按工具返回的 task_id 关联结果，并优先使用本次调用的结果", () => {
  const part = {
    type: "dynamic-tool",
    toolName: "subagent_task",
    toolCallId: "resume-call",
    state: "output-available",
    input: { action: "send", task_id: "task", message: "continue" },
    output: { task_id: "task", status: "completed" },
  } as Parameters<typeof subagentResultForPart>[0];
  const previous = { status: "completed" as const, result: "previous" };
  const current = { status: "completed" as const, result: "current" };
  const results = new Map([["task", previous]]);
  expect(subagentResultForPart(part, results)).toBe(previous);
  results.set("resume-call", current);
  expect(subagentResultForPart(part, results)).toBe(current);
});
