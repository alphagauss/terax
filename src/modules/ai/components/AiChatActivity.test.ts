/**
 * 本文件测试聊天消息中的活动分组边界。
 * 测试锁定正文和 Subagent 作为活动边界，其余可展示内容持续归入同一活动块。
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildMessageGroups } from "./AiChat";

describe("AI chat activity grouping", () => {
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
});
