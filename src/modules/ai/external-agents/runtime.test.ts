/**
 * 本文件验证 External Agent JSONL 协议的统一投影。
 * 测试锁定分块输入、会话恢复标识、文本、活动和终态不会依赖 CLI 的展示输出。
 */

import { readUIMessageStream, type UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: (event: unknown) => void }>,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_event: unknown) => undefined;

    constructor() {
      tauri.channels.push(this);
    }
  },
  invoke: tauri.invoke,
}));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import {
  createExternalAgentParser,
  externalAgentProcessError,
  parseExternalAgentBinding,
  runExternalAgentStream,
} from "./runtime";

describe("External Agent protocol", () => {
  beforeEach(() => {
    tauri.channels.length = 0;
    tauri.invoke.mockReset();
    tauri.invoke.mockResolvedValue("process-1");
  });

  it("projects chunked Claude stream-json events", () => {
    const parser = createExternalAgentParser("claude");
    expect(
      parser.feed('{"type":"assistant","session_id":"abc-123","message":'),
    ).toEqual([]);
    expect(
      parser.feed(
        '{"content":[{"type":"tool_use","name":"Read"},{"type":"text","text":"done"}]}}\n{"type":"result","is_error":false}\n',
      ),
    ).toEqual([
      { type: "session", sessionId: "abc-123" },
      {
        type: "activity",
        toolName: "external_agent_tool",
        input: { agentId: "claude", tool: "Read" },
      },
      { type: "text", text: "done" },
      { type: "completed" },
    ]);
  });

  it("projects Codex JSONL messages, usage and completion", () => {
    const parser = createExternalAgentParser("codex");
    expect(
      parser.feed(
        [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
          '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "session", sessionId: "thread-1" },
      { type: "text", text: "done" },
      { type: "usage", input: 10, output: 2, cached: 4 },
      { type: "completed" },
    ]);
  });

  it("accepts only supported persisted agent bindings", () => {
    expect(
      parseExternalAgentBinding({
        externalAgent: { agentId: "claude", sessionId: "session-1" },
      }),
    ).toEqual({ agentId: "claude", sessionId: "session-1" });
    expect(
      parseExternalAgentBinding({
        externalAgent: { agentId: "other", sessionId: null },
      }),
    ).toBeNull();
  });

  it("accepts a protocol completion when the platform has no exit code", () => {
    expect(
      externalAgentProcessError(
        "codex",
        {
          kind: "done",
          status: "exited",
          exitCode: null,
          stderr: "",
        },
        true,
        null,
      ),
    ).toBeUndefined();
    expect(
      externalAgentProcessError(
        "codex",
        {
          kind: "done",
          status: "exited",
          exitCode: undefined as never,
          stderr: "",
        },
        true,
        null,
      ),
    ).toBeUndefined();
    expect(
      externalAgentProcessError(
        "codex",
        {
          kind: "done",
          status: "exited",
          exitCode: 0,
          stderr: "",
        },
        false,
        null,
      ),
    ).toBe("Codex ended without a completion event.");
  });

  it("rejects an oversized complete JSONL record", () => {
    const parser = createExternalAgentParser("codex");
    expect(parser.feed(`${"x".repeat(1024 * 1024 + 1)}\n`)).toEqual([
      {
        type: "error",
        message: "External Agent JSON line is too large.",
      },
    ]);
  });

  it("renders each activity as a completed tool and accepts a missing exit code", async () => {
    const sessions: string[] = [];
    const stream = runExternalAgentStream({
      agentId: "codex",
      ownerSessionId: "owner-1",
      externalSessionId: null,
      cwd: "D:/workspace",
      permissionMode: "ask",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "inspect" }],
        },
      ],
      onSession: (sessionId) => {
        sessions.push(sessionId);
      },
    });
    const [chunkStream, messageStream] = stream.tee();
    const chunksPromise = (async () => {
      const chunks = [];
      for await (const chunk of chunkStream) chunks.push(chunk);
      return chunks;
    })();
    const messagePromise = (async () => {
      let latest: UIMessage | undefined;
      for await (const message of readUIMessageStream({
        stream: messageStream,
      })) {
        latest = message;
      }
      return latest;
    })();
    const channel = tauri.channels[0];
    expect(channel).toBeDefined();
    channel.onmessage({
      kind: "output",
      stdout: [
        '{"type":"thread.started","thread_id":"thread-1"}',
        '{"type":"turn.started","thread_id":"thread-1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"I will inspect."}}',
        '{"type":"item.started","item":{"type":"command_execution","command":"Get-Location"}}',
        '{"type":"item.updated","item":{"type":"command_execution","command":"Get-Location"}}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"Get-Location"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"D:/workspace"}}',
        '{"type":"turn.completed"}',
        "",
      ].join("\n"),
    });
    channel.onmessage({
      kind: "done",
      status: "exited",
      exitCode: null,
      stderr: "Codex warning on stderr",
    });

    const [chunks, message] = await Promise.all([
      chunksPromise,
      messagePromise,
    ]);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks[1]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "external-activity-0",
      toolName: "external_agent_start",
      input: { agentId: "codex" },
    });
    expect(chunks[6]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "external-activity-1",
      toolName: "shell_exec",
      input: { command: "Get-Location" },
    });
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ type: "error" }),
    );
    expect(message?.parts).toMatchObject([
      {
        type: "dynamic-tool",
        toolName: "external_agent_start",
        state: "output-available",
      },
      { type: "text", text: "I will inspect." },
      {
        type: "dynamic-tool",
        toolName: "shell_exec",
        state: "output-available",
      },
      { type: "text", text: "\n\nD:/workspace" },
    ]);
    expect(sessions).toEqual(["thread-1"]);
  });
});
