/**
 * 本文件验证 AI 会话记录与 AI SDK UIMessage 之间的转换。
 * 测试锁定 nanobot 风格工具调用、工具结果顺序和 turn 分组等不变量。
 */

import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  projectSessionMessages,
  serializeSessionMessages,
  type SessionMessage,
} from "./sessionMessages";

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
});
