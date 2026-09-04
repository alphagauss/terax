/**
 * 本文件测试聊天消息中的活动分组和工具结果展示。
 * 锁定正文与 Subagent 分组边界，并确保结构化业务错误不会显示为成功结果。
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildMessageGroups, resolveToolDisplay } from "./AiChat";

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
