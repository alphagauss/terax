/**
 * 本文件验证 AI 会话记录与 AI SDK UIMessage 之间的转换。
 * 测试锁定 nanobot 风格工具调用、展示耗时、工具结果顺序和 turn 分组等不变量。
 */

import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  projectSessionMessages,
  serializeSessionMessages,
  serializeSubagentDisplaySnapshots,
  serializeSubagentResultEvent,
  type SessionMessage,
} from "./sessionMessages";
import { convertToAgentModelMessages } from "./subagentMessages";

const timestamp = "2026-07-26T10:00:00.000Z";

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

    expect(records[0].reasoning_duration_ms).toBe(1250);
    expect(records[0].activity_duration_ms).toBe(2400);
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
      { createdAt: Date.parse("2026-07-26T09:00:01.000Z") },
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
          metadata: { createdAt: Date.parse("2026-07-26T09:00:01.000Z") },
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
      content: records[1].content,
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
        content: "must stay hidden",
        timestamp,
        display_event: "subagent",
        subagent_display: { version: 1 } as never,
      },
    ]);

    expect(messages).toEqual([]);
    expect(await convertToAgentModelMessages(messages)).toEqual([]);
  });

  it("does not hide an internal event whose persisted content is inconsistent", () => {
    const messages = projectSessionMessages("session-1", [
      {
        role: "user",
        content: "tampered content",
        timestamp,
        injected_event: "subagent_result",
        subagent_result: {
          version: 1,
          event: "subagent_result",
          results: [],
        },
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        parts: [{ type: "text", text: "tampered content" }],
      }),
    ]);
  });

  it("skips the persisted assistant prefix during the terminal append", () => {
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
        content: "Terminal tail",
        timestamp,
        turn_id: "turn-1",
        turn_status: "completed",
      },
    ]);
  });
});
