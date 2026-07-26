/**
 * 本文件验证 AI 会话滚动控件的显示条件和用户消息导航投影。
 * 测试锁定运行中脱离跟随后的入口，以及摘要不会泄露大段上下文内容。
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildUserMessageAnchors,
  shouldShowChatScrollControls,
} from "./chatScroll";

describe("chat scroll controls", () => {
  it("shows the running control only after leaving the bottom lock", () => {
    expect(shouldShowChatScrollControls(true, true, false)).toBe(false);
    expect(shouldShowChatScrollControls(true, false, false)).toBe(true);
    expect(shouldShowChatScrollControls(true, true, true)).toBe(true);
    expect(shouldShowChatScrollControls(false, false, false)).toBe(true);
  });

  it("builds ordered user anchors without embedded context blocks", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [
          {
            type: "text",
            text: '<terax-command name="plan" state="on" />\nInspect this\n<selection source="terminal">\nsecret output\n</selection>',
          },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Done" }],
      },
      {
        id: "user-2",
        role: "user",
        parts: [
          {
            type: "text",
            text: '<file name="a.ts">\nlarge body\n</file>',
          },
        ],
      },
    ] as UIMessage[];

    expect(buildUserMessageAnchors(messages, "[Context]")).toEqual([
      { id: "user-1", index: 0, text: "Inspect this" },
      { id: "user-2", index: 1, text: "[Context]" },
    ]);
  });
});
