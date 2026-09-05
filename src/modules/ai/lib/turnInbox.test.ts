/**
 * 本文件验证运行中引导的消费优先级与取消边界。
 * 未消费消息只属于当前运行，中止后不再接收或重放。
 */

import { TurnInbox } from "@/modules/ai/lib/turnInbox";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});

describe("会话消息接入", () => {
  it("用户引导优先于后台结果且保持发送顺序，中止取消剩余输入", async () => {
    const inbox = new TurnInbox();
    inbox.open();
    inbox.push({ version: 1, event: "subagent_result", results: [] }, 0);
    const first = inbox.steer(user("first"));
    const second = inbox.steer(user("second"));
    const entry = inbox.take();
    expect(entry?.event).toMatchObject({
      event: "user_steering",
      message: { id: "first" },
    });
    entry?.settle("consumed");
    await expect(first).resolves.toBe("consumed");
    inbox.cancel();
    await expect(second).resolves.toBe("cancelled");
    expect(inbox.take()).toBeNull();
    expect(inbox.steer(user("late"))).toBeNull();
  });
});
