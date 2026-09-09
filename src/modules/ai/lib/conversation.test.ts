/**
 * 本文件验证 AI 会话记录与 AI SDK UIMessage 之间的转换。
 * 测试锁定工具调用、展示耗时、结果顺序、turn 分组及恢复后的 prompt cache 前缀。
 */

import {
  convertToAgentModelMessages,
  formatSubagentResultEvent,
  messageMetadata,
  projectConversationDisplay,
  projectSessionMessages,
  type SessionMessage,
  serializeSessionMessages,
  serializeSubagentDisplaySnapshots,
  serializeSubagentResultEvent,
  TOOL_APPROVAL_DENIED_REASON,
} from "@/modules/ai/lib/conversation";
import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";

const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});

const timestamp = "2026-07-26T10:00:00.000Z";

function jsonlRoundTrip(records: SessionMessage[]): SessionMessage[] {
  return records.map((record) => JSON.parse(JSON.stringify(record)));
}

describe("AI session message conversion", () => {
  it("serializes a simple turn as readable role/content records", () => {
    const messages: UIMessage[] = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "你好" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "用户正在问候。", state: "done" },
          { type: "text", text: "你好！", state: "done" },
        ],
      },
    ];

    const records = serializeSessionMessages(messages, {
      timestamp,
      turnId: "turn-1",
    });

    expect(records).toEqual([
      {
        role: "user",
        content: "你好",
        timestamp,
        turn_id: "turn-1",
      },
      {
        role: "assistant",
        content: "你好！",
        reasoning_content: "用户正在问候。",
        timestamp,
        turn_id: "turn-1",
        turn_status: "completed",
      },
    ]);
    expect(Object.keys(records[1])).toEqual([
      "role",
      "content",
      "reasoning_content",
      "timestamp",
      "turn_id",
      "turn_status",
    ]);
  });

  it("persists and restores display durations without exposing activity timing", async () => {
    const assistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "推理内容", state: "done" },
        {
          type: "data-reasoning-duration",
          data: { durationMs: 1250 },
        } as UIMessage["parts"][number],
        {
          type: "data-activity-duration",
          data: { durationMs: 2400 },
        } as UIMessage["parts"][number],
      ],
    };

    const records = serializeSessionMessages([assistant], {
      timestamp,
      turnId: "turn-1",
    });

    expect(records[0]).toMatchObject({
      reasoning_duration_ms: 1250,
      activity_duration_ms: 2400,
    });
    const restored = projectSessionMessages("session-1", records)[0];
    expect(restored.parts).toEqual(assistant.parts);
    expect(await convertToAgentModelMessages([restored])).toEqual(
      await convertToAgentModelMessages([
        {
          ...restored,
          parts: restored.parts.filter(
            (part) => part.type !== "data-activity-duration",
          ),
        },
      ]),
    );
  });

  it("keeps a denied approval identical in live and restored model input", async () => {
    const live: UIMessage[] = [
      {
        id: "assistant-denied",
        role: "assistant",
        parts: [
          {
            type: "tool-shell_exec",
            toolCallId: "shell-denied",
            state: "output-denied",
            input: { command: "curl https://example.com" },
            approval: {
              id: "approval-denied",
              approved: false,
              reason: TOOL_APPROVAL_DENIED_REASON,
            },
          },
        ],
      } as UIMessage,
    ];
    const records = serializeSessionMessages(live, {
      timestamp,
      turnId: "turn-denied",
    });

    expect(records[1]).toMatchObject({
      role: "tool",
      tool_call_id: "shell-denied",
      approval_id: "approval-denied",
      approval_approved: false,
      approval_reason: TOOL_APPROVAL_DENIED_REASON,
      status: "denied",
      content: TOOL_APPROVAL_DENIED_REASON,
    });
    const restoredMessages = projectSessionMessages(
      "session-1",
      jsonlRoundTrip(records),
    );
    const restored = restoredMessages[0].parts.find(
      (part) => "toolCallId" in part && part.toolCallId === "shell-denied",
    );
    expect(restored).toMatchObject({
      state: "output-denied",
      approval: {
        approved: false,
        reason: TOOL_APPROVAL_DENIED_REASON,
      },
    });
    expect(await convertToAgentModelMessages(restoredMessages)).toEqual(
      await convertToAgentModelMessages(live),
    );
  });

  it("keeps structured and thrown tool errors identical after restoration", async () => {
    const live: UIMessage[] = [
      {
        id: "assistant-errors",
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            toolCallId: "read-error",
            state: "output-available",
            input: { path: "missing.txt" },
            output: { error: "path not found", path: "missing.txt" },
            approval: {
              id: "approval-read",
              approved: true,
              reason: "Approved once.",
            },
          },
          {
            type: "tool-shell_exec",
            toolCallId: "shell-error",
            state: "output-error",
            input: { command: "false" },
            errorText: "process could not start",
            approval: {
              id: "approval-shell",
              approved: true,
              signature: "stable-signature",
            },
          },
        ],
      } as UIMessage,
    ];
    const records = serializeSessionMessages(live, {
      timestamp,
      turnId: "turn-errors",
    });
    const restored = projectSessionMessages(
      "session-1",
      jsonlRoundTrip(records),
    );

    expect(await convertToAgentModelMessages(restored)).toEqual(
      await convertToAgentModelMessages(live),
    );
  });

  it("uses the OpenAI function envelope and string arguments for tools", () => {
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "读取文件" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "需要读取文件。", state: "done" },
          {
            type: "tool-read_file",
            toolCallId: "call-1",
            state: "output-available",
            input: { path: "package.json" },
            output: { content: "{}" },
          },
          { type: "step-start" },
          { type: "text", text: "读取完成。", state: "done" },
        ],
      },
    ];

    const records = serializeSessionMessages(messages, {
      timestamp,
      turnId: "turn-1",
    });

    expect(records).toEqual([
      {
        role: "user",
        content: "读取文件",
        timestamp,
        turn_id: "turn-1",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"package.json"}',
            },
          },
        ],
        reasoning_content: "需要读取文件。",
        timestamp,
        turn_id: "turn-1",
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "read_file",
        content: { content: "{}" },
        timestamp,
        turn_id: "turn-1",
      },
      {
        role: "assistant",
        content: "读取完成。",
        timestamp,
        turn_id: "turn-1",
        turn_status: "completed",
      },
    ]);
    expect(Object.keys(records[1])).toEqual([
      "role",
      "content",
      "tool_calls",
      "reasoning_content",
      "timestamp",
      "turn_id",
    ]);
    expect(Object.keys(records[2])).toEqual([
      "role",
      "tool_call_id",
      "name",
      "content",
      "timestamp",
      "turn_id",
    ]);

    expect(
      projectSessionMessages("session-1", records).map(({ role, parts }) => ({
        role,
        parts,
      })),
    ).toEqual(messages.map(({ role, parts }) => ({ role, parts })));
  });

  it("keeps assistant-only turns separate by turn_id", () => {
    const records: SessionMessage[] = [
      {
        role: "assistant",
        content: "第一答",
        timestamp: "2026-07-26T09:00:00.000Z",
        turn_id: "turn-old",
      },
      {
        role: "assistant",
        content: "第二答",
        timestamp: "2026-07-26T09:00:01.000Z",
        turn_id: "turn-new",
      },
    ];

    expect(
      projectSessionMessages("session-1", records).map((message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ),
    ).toEqual(["第一答", "第二答"]);
  });

  it("restores each persisted message timestamp into UI metadata", () => {
    const records: SessionMessage[] = [
      {
        role: "user",
        content: "问题",
        timestamp: "2026-07-26T09:00:00.000Z",
      },
      {
        role: "assistant",
        content: "回答",
        timestamp: "2026-07-26T09:00:01.000Z",
        turn_id: "turn-1",
      },
    ];

    expect(
      projectSessionMessages("session-1", records).map(
        (message) => message.metadata,
      ),
    ).toEqual([
      { createdAt: Date.parse("2026-07-26T09:00:00.000Z") },
      { createdAt: Date.parse("2026-07-26T09:00:01.000Z"), turnId: "turn-1" },
    ]);
  });

  it("uses UI creation metadata when persisting message timestamps", () => {
    const records = serializeSessionMessages(
      [
        {
          id: "user-1",
          role: "user",
          metadata: { createdAt: Date.parse("2026-07-26T09:00:00.000Z") },
          parts: [{ type: "text", text: "问题" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          metadata: {
            createdAt: Date.parse("2026-07-26T09:00:01.000Z"),
            turnId: "turn-1",
          },
          parts: [{ type: "text", text: "回答", state: "done" }],
        },
      ],
      { timestamp, turnId: "turn-1" },
    );

    expect(records.map((record) => record.timestamp)).toEqual([
      "2026-07-26T09:00:00.000Z",
      "2026-07-26T09:00:01.000Z",
    ]);
  });

  it("round-trips an internal subagent event without rendering a user message", async () => {
    const event = {
      version: 1 as const,
      event: "subagent_result" as const,
      results: [
        {
          taskId: "task-1",
          label: "Inspect tests",
          status: "completed" as const,
          result: "All tests passed.",
        },
      ],
    };
    const records: SessionMessage[] = [
      {
        role: "assistant",
        content: "Working.",
        timestamp,
        turn_id: "turn-1",
      },
      serializeSubagentResultEvent(event, {
        timestamp,
        turnId: "turn-1",
      }),
      {
        role: "assistant",
        content: "Done.",
        timestamp,
        turn_id: "turn-1",
      },
    ];

    const messages = projectSessionMessages("session-1", records);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].parts.map((part) => part.type)).toEqual([
      "step-start",
      "text",
      "data-subagent-result",
      "step-start",
      "text",
    ]);

    const modelMessages = await convertToAgentModelMessages(messages);
    expect(modelMessages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(modelMessages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: formatSubagentResultEvent(event) }],
    });
  });

  it("restores display-only subagent progress without changing provider messages", async () => {
    const snapshot = {
      version: 1 as const,
      taskId: "task-1",
      toolCallId: "call-1",
      label: "Inspector",
      status: "completed" as const,
      durationMs: 900,
      steps: [
        {
          id: "child-call-1",
          toolName: "grep",
          summary: "subagent_result",
          status: "completed" as const,
        },
      ],
    };
    const records: SessionMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "run_subagent",
              arguments: '{"task":"inspect","wait":true}',
            },
          },
        ],
        timestamp,
        turn_id: "turn-1",
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "run_subagent",
        content: {
          taskId: "task-1",
          label: "Inspector",
          status: "completed",
          result: "done",
        },
        timestamp,
        turn_id: "turn-1",
      },
      ...serializeSubagentDisplaySnapshots([snapshot], {
        timestamp,
        turnId: "turn-1",
      }),
    ];

    const messages = projectSessionMessages("session-1", records);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts.map((part) => part.type)).toEqual([
      "step-start",
      "tool-run_subagent",
      "data-subagent-display",
    ]);

    expect(
      serializeSessionMessages(messages, { timestamp, turnId: "turn-1" }),
    ).toContainEqual({
      role: "display",
      content: snapshot,
      timestamp,
      turn_id: "turn-1",
    });

    const withoutDisplay: UIMessage[] = messages.map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) => part.type !== "data-subagent-display",
      ),
    }));
    expect(await convertToAgentModelMessages(messages)).toEqual(
      await convertToAgentModelMessages(withoutDisplay),
    );
  });

  it("ignores malformed display-only records instead of exposing them to the model", async () => {
    const messages = projectSessionMessages("session-1", [
      {
        role: "display",
        content: { version: 1 } as never,
        timestamp,
      },
    ]);

    expect(messages).toEqual([]);
    expect(await convertToAgentModelMessages(messages)).toEqual([]);
  });

  it("serializes the entire ordered history without inferring a commit cursor", () => {
    const event = {
      version: 1 as const,
      event: "subagent_result" as const,
      results: [],
    };
    const records = serializeSessionMessages(
      [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Persisted prefix", state: "done" },
            {
              type: "data-subagent-result",
              data: { event },
            } as UIMessage["parts"][number],
            { type: "step-start" },
            { type: "text", text: "Terminal tail", state: "done" },
          ],
        },
      ],
      { timestamp, turnId: "turn-1" },
    );

    expect(records).toEqual([
      {
        role: "assistant",
        content: "Persisted prefix",
        timestamp,
        turn_id: "turn-1",
        turn_status: "completed",
      },
      { role: "event", content: event, timestamp, turn_id: "turn-1" },
      {
        role: "assistant",
        content: "Terminal tail",
        timestamp,
        turn_id: "turn-1",
        turn_status: "completed",
      },
    ]);
  });
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
    const messages = projectConversationDisplay([
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
    expect(
      messageMetadata(messages[0]).subagents?.resultsByTaskId.get("child"),
    ).toMatchObject({ result: "found" });
    expect(
      messageMetadata(messages[0]).subagents?.displaysByToolCallId.get("spawn"),
    ).toMatchObject({ taskId: "child" });
    expect(messages[2].parts).toEqual([{ type: "text", text: "done" }]);
  });

  it("恢复引导标记和活动顺序，模型只接收正文与引导说明", async () => {
    const guided: UIMessage = {
      ...user("correct the target"),
      metadata: { guided: true, internalNote: "internal-only" },
      parts: [
        { type: "text", text: "correct the target" },
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,AA==",
          filename: "target.png",
        },
        { type: "data-private", data: { note: "internal-only" } },
      ],
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
    expect(
      records.find((record) => record.role === "user" && record.guided),
    ).toMatchObject({
      role: "user",
      content: "correct the target",
      message_id: guided.id,
    });
    const restored = projectSessionMessages("session", records);
    const visible = projectConversationDisplay(restored);
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
    expect(JSON.stringify(model)).not.toContain("internal-only");
    expect(visible[2].parts).toContainEqual(guided.parts[1]);
    expect(model[2].content).toContainEqual(
      expect.objectContaining({ type: "file", mediaType: "image/png" }),
    );
  });
});
