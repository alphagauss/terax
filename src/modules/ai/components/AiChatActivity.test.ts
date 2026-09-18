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
} from "./AiChat";

describe("activity headline summaries", () => {
  beforeAll(() => preloadEn());
  const headline = (tool: string, input: unknown, state = "input-streaming") =>
    activityHeadline(
      {
        type: `tool-${tool}`,
        toolCallId: "call",
        state,
        input,
      } as Parameters<typeof activityHeadline>[0],
      "Thinking",
    );

  it("shows the tool action before meaningful fields and then adds the summary", () => {
    expect(headline("shell_exec", {})).toMatchObject({
      kind: "tool",
      text: "Running",
    });
    expect(headline("shell_exec", { command: " \n " })).toMatchObject({
      kind: "tool",
      text: "Running",
    });
    expect(headline("shell_exec", { command: "Get-Date" })?.text).toBe(
      "Get-Date",
    );
    expect(headline("write_file", { path: "src/app.tsx" })?.text).toBe(
      "src/app.tsx",
    );
    expect(headline("apply_patch", { files: [{}] })).toMatchObject({
      kind: "tool",
      text: "Editing",
    });
    expect(headline("apply_patch", { files: [{ path: "a.ts" }] })?.text).toBe(
      "a.ts",
    );
    expect(headline("find_files", {})).toMatchObject({
      kind: "tool",
      text: "Finding",
    });
    expect(headline("find_files", {}, "input-available")?.text).toBe(".");
  });

  it("uses search conditions and process actions instead of opaque IDs", () => {
    expect(headline("shell_exec", { command: "pnpm test" })).toMatchObject({
      action: "Running",
      text: "pnpm test",
    });
    expect(headline("read_file", { path: "a.ts" })).toMatchObject({
      action: "Reading",
      text: "a.ts",
    });
    expect(headline("write_file", { path: "a.ts" })).toMatchObject({
      action: "Writing",
      text: "a.ts",
    });
    expect(
      headline("file_operation", {
        operation: "move",
        path: "a.ts",
        destination: "b.ts",
      }),
    ).toMatchObject({ action: "Moving", text: "a.ts → b.ts" });
    expect(
      headline("find_files", { glob: "**/*.tsx", path: "src" })?.text,
    ).toBe("**/*.tsx · src");
    expect(
      headline("shell_process", {
        action: "terminate",
        process_id: "opaque-id",
      })?.text,
    ).toBe("Terminating process");
    expect(headline("get_terminal_output", {})?.text).toBe(
      "Reading active terminal",
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
