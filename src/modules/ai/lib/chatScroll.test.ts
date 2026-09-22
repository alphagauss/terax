/**
 * 本文件验证 AI 会话滚动控件的显示条件和用户消息导航投影。
 * 测试锁定恢复跟随入口只在离开底部时显示，以及摘要不会泄露大段上下文内容。
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildUserMessageAnchors,
  shouldShowChatScrollControls,
} from "./chatScroll";

describe("chat scroll controls", () => {
  it("hides the control whenever following reaches the bottom", () => {
    expect(shouldShowChatScrollControls(true)).toBe(false);
    expect(shouldShowChatScrollControls(false)).toBe(true);
  });

  it("builds ordered user anchors without embedded context blocks", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [
          {
            type: "text",
            text: 'Inspect this\n<selection source="terminal">\nsecret output\n</selection>',
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
        metadata: {
          attachments: [
            {
              kind: "file",
              name: "a.ts",
              size: 10,
              path: "/work/a.ts",
              environmentKey: "local",
            },
          ],
        },
        role: "user",
        parts: [],
      },
    ] as UIMessage[];

    expect(buildUserMessageAnchors(messages, "[Context]")).toEqual([
      { id: "user-1", index: 0, text: "Inspect this" },
      { id: "user-2", index: 1, text: "[Context]" },
    ]);
  });
});
