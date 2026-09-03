/**
 * 本文件测试聊天消息中的活动分组边界。
 * 测试锁定普通工具归入 reasoning 活动，而正文和 Subagent 始终保持为外部内容。
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildMessageGroups } from "./AiChat";

describe("AI chat activity grouping", () => {
  it("keeps text and Subagent parts outside activity groups", () => {
    const parts: UIMessage["parts"] = [
      { type: "reasoning", text: "检查项目。", state: "done" },
      {
        type: "tool-shell_exec",
        toolCallId: "shell-1",
        state: "input-available",
        input: { command: "pnpm test" },
      },
      {
        type: "data-activity-duration",
        data: { durationMs: 1500 },
      } as UIMessage["parts"][number],
      {
        type: "tool-run_subagent",
        toolCallId: "subagent-1",
        state: "input-available",
        input: { task: "检查测试", wait: true },
      },
      { type: "reasoning", text: "整理结果。", state: "done" },
      {
        type: "data-activity-duration",
        data: { durationMs: 800 },
      } as UIMessage["parts"][number],
      { type: "text", text: "最终正文", state: "done" },
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
      durationMs: 1500,
      groups: [
        { kind: "single", part: { type: "reasoning" } },
        { kind: "single", part: { type: "tool-shell_exec" } },
      ],
    });
    expect(groups[1]).toMatchObject({
      kind: "single",
      part: { type: "tool-run_subagent" },
    });
    expect(groups[3]).toMatchObject({
      kind: "single",
      part: { type: "text" },
    });
  });
});
