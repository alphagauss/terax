import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  convertToAgentModelMessages,
  projectSessionMessages,
  serializeSessionMessages,
  materializeRunFailure,
} from "@/modules/ai/lib/conversation";
it.each([true, false])(
  "模型失败保留部分输出=%s，恢复后向模型提供运行事实",
  async (partial) => {
    const input: UIMessage[] = [
      {
        id: "input",
        role: "user",
        parts: [{ type: "text", text: "continue" }],
      },
    ];
    if (partial)
      input.push({
        id: "reply",
        role: "assistant",
        parts: [{ type: "text", text: "partial output" }],
      });
    const messages = materializeRunFailure(
      input,
      "turn",
      new Error("connection reset Bearer secret-token"),
      2000,
    );
    expect(materializeRunFailure(messages, "turn", "retry", 3000)).toBe(
      messages,
    );
    const records = serializeSessionMessages(messages, {
      turnId: "turn",
      timestamp: new Date(2000).toISOString(),
    });
    const restored = projectSessionMessages("session", records);
    expect(restored[restored.length - 1].id).toBe("run-failure:turn");
    const context = JSON.stringify(await convertToAgentModelMessages(restored));
    expect(context).toContain("previous model request failed");
    expect(context).toContain(
      "Earlier tool actions may already have taken effect",
    );
    expect(context).toContain("connection reset");
    expect(context).not.toContain("secret-token");
    if (partial) expect(context).toContain("partial output");
  },
);
