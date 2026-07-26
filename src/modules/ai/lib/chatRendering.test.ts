/**
 * 本文件验证聊天流式渲染的提交频率和上下文估算边界。
 * 测试锁定文本、推理、工具内容的估算规则及不可序列化输入的失败路径。
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  estimateUiMessageTokens,
  STREAM_RENDER_INTERVAL_MS,
} from "./chatRendering";

describe("chat rendering performance helpers", () => {
  it("keeps streaming React commits near 30 FPS", () => {
    expect(STREAM_RENDER_INTERVAL_MS).toBe(32);
  });

  it("estimates text, reasoning, and tool payloads", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "think" },
          {
            type: "tool-read_file",
            toolCallId: "tool-1",
            state: "output-available",
            input: { path: "a" },
            output: { ok: true },
          },
          { type: "text", text: "answer" },
        ],
      },
    ] as unknown as UIMessage[];

    const chars =
      "think".length +
      "answer".length +
      JSON.stringify({ path: "a" }).length +
      JSON.stringify({ ok: true }).length;

    expect(estimateUiMessageTokens(messages)).toBe(Math.ceil(chars / 4));
  });

  it("ignores a cyclic tool payload instead of blocking rendering", () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "custom",
            toolCallId: "tool-1",
            state: "input-available",
            input,
          },
        ],
      },
    ] as unknown as UIMessage[];

    expect(estimateUiMessageTokens(messages)).toBe(0);
  });
});
