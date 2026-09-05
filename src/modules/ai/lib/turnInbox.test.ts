/**
 * 本文件验证运行中引导的消费优先级、取消边界及历史展示恢复。
 * 用户输入不提前进入正文，消费后的标记与活动分段必须跨持久化保持一致。
 */
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { TurnInbox, projectSteeredMessages } from "@/modules/ai/lib/turnInbox";
import {
  projectSessionMessages,
  serializeSessionMessages,
} from "@/modules/ai/lib/sessionMessages";
import { convertToAgentModelMessages } from "@/modules/ai/lib/subagentMessages";

const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});

describe("会话消息接入", () => {
  it("引导之后完成的后台结果仍归属于之前的 Subagent 卡片", () => {
    const result: UIMessage["parts"][number] = {
      type: "data-subagent-result",
      data: {
        event: {
          version: 1,
          event: "subagent_result",
          results: [
            {
              taskId: "child",
              label: "inspect",
              status: "completed",
              result: "found",
            },
          ],
        },
      },
    };
    const display: UIMessage["parts"][number] = {
      type: "data-subagent-display",
      data: {
        snapshot: {
          version: 1,
          taskId: "child",
          toolCallId: "spawn",
          label: "inspect",
          status: "completed",
          durationMs: 20,
          steps: [],
        },
      },
    };
    const messages = projectSteeredMessages([
      {
        id: "run",
        role: "assistant",
        parts: [
          {
            type: "tool-run_subagent",
            toolCallId: "spawn",
            state: "output-available",
            input: {},
            output: { taskId: "child", status: "running" },
          },
          {
            type: "data-user-steering",
            data: { event: "user_steering", message: user("guide") },
          },
          { type: "text", text: "done" },
          result,
          display,
        ],
      },
    ]);
    expect(messages[0].parts).toContainEqual(result);
    expect(messages[0].parts).toContainEqual(display);
    expect(messages[2].parts).toEqual([{ type: "text", text: "done" }]);
  });

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

  it("恢复引导标记和活动顺序，模型只接收正文与引导说明", async () => {
    const guided = {
      ...user("correct the target"),
      metadata: { guided: true },
    };
    const before: UIMessage = {
      id: "before",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "inspect" },
        { type: "data-activity-duration", data: { durationMs: 12 } },
      ],
    };
    const after: UIMessage = {
      id: "after",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "updated answer" }],
    };
    const records = serializeSessionMessages(
      [user("initial"), before, guided, after],
      { timestamp: "2026-09-05T00:00:00Z", turnId: "turn" },
    );
    expect(records.find((record) => record.guided)).toMatchObject({
      role: "user",
      content: "correct the target",
      message_id: guided.id,
    });
    const restored = projectSessionMessages("session", records);
    const visible = projectSteeredMessages(restored);
    expect(visible.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(visible[2]).toMatchObject({
      id: guided.id,
      metadata: { guided: true },
    });
    expect(visible[1].parts).toContainEqual({
      type: "data-activity-duration",
      data: { durationMs: 12 },
    });
    const model = await convertToAgentModelMessages(restored);
    expect(model.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(model[2])).toContain("additional guidance");
    expect(JSON.stringify(model)).not.toContain("data-user-steering");
    expect(JSON.stringify(model)).not.toContain("guided");
  });
});
