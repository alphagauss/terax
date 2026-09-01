/**
 * 本文件验证聊天传输层保持真实消息不变，并在 Chat runtime 内冻结系统提示。
 * 测试锁定项目指令只读取一次，后续发送不得受外部配置变化影响。
 */

import type { UIMessage } from "@ai-sdk/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAgentsMd: vi.fn(),
  runAgentStream: vi.fn(),
  toUIMessageStream: vi.fn(),
}));

vi.mock("./agent", () => ({ runAgentStream: mocks.runAgentStream }));
vi.mock("./projectInstructions", () => ({
  readAgentsMd: mocks.readAgentsMd,
}));

import { createSessionTransport } from "./transport";
import type { SessionAgentSnapshot } from "./agents";
import type { ToolContext } from "../tools/context";

const environment = {
  platform: "Windows",
  workspace: "Local",
  defaultShell: "PowerShell",
} as const;

const toolContext: ToolContext = {
  getCwd: () => "D:/workspace/project",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => "ask",
};

const subagentDeps = {
  getDefaultSubagentModelId: () => null,
  getMaxConcurrentSubagents: () => 3,
  onCheckpoint: vi.fn(),
};

describe("session transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAgentsMd.mockResolvedValue("Project instructions");
    mocks.toUIMessageStream.mockReturnValue("stream");
    mocks.runAgentStream.mockResolvedValue({
      toUIMessageStream: mocks.toUIMessageStream,
    });
  });

  it("passes the canonical messages unchanged and reads instructions from session cwd", async () => {
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Inspect this" }],
      },
    ];
    const transport = createSessionTransport({
      getKeys: () => ({}) as never,
      toolContext,
      getModelId: () => "model",
      ...subagentDeps,
      getCustomInstructions: () => "",
      getAgent: () => ({
        id: "builtin:main",
        name: "Terax",
        instructions: "",
        icon: "coder",
        tools: ["read_file"],
      }),
      getCwd: () => "D:/workspace/project",
      getEnvironment: () => environment,
    });

    await transport.sendMessages({ messages });

    expect(mocks.readAgentsMd).toHaveBeenCalledWith("D:/workspace/project");
    expect(mocks.runAgentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Working directory: "D:/workspace/project"',
        ),
        uiMessages: messages,
      }),
    );
    expect(mocks.runAgentStream.mock.calls[0][0].uiMessages).toBe(messages);
    expect(messages[0].parts).toEqual([{ type: "text", text: "Inspect this" }]);
  });

  it("reuses one prompt when model and external instruction sources change", async () => {
    let modelId = "model-a";
    let customInstructions = "First preference";
    let agent: SessionAgentSnapshot = {
      id: "agent-a",
      name: "Builder",
      instructions: "First agent",
      icon: "spark",
      tools: ["read_file"],
    };
    const transport = createSessionTransport({
      getKeys: () => ({}) as never,
      toolContext,
      getModelId: () => modelId,
      ...subagentDeps,
      getCustomInstructions: () => customInstructions,
      getAgent: () => agent,
      getCwd: () => "D:/workspace/project",
      getEnvironment: () => environment,
    });
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "First" }],
      },
    ];

    await transport.sendMessages({ messages });
    modelId = "model-b";
    customInstructions = "Second preference";
    agent = {
      id: "agent-b",
      name: "Reviewer",
      instructions: "Second agent",
      icon: "reviewer",
      tools: ["grep"],
    };
    mocks.readAgentsMd.mockResolvedValue("Changed project instructions");
    await transport.sendMessages({ messages });

    expect(mocks.readAgentsMd).toHaveBeenCalledTimes(1);
    const firstPrompt = mocks.runAgentStream.mock.calls[0][0].systemPrompt;
    const secondPrompt = mocks.runAgentStream.mock.calls[1][0].systemPrompt;
    expect(secondPrompt).toBe(firstPrompt);
    expect(mocks.runAgentStream.mock.calls[1][0].modelId).toBe("model-b");
    expect(firstPrompt).toContain("Project instructions");
    expect(firstPrompt).toContain("First agent");
    expect(firstPrompt).toContain("First preference");
    expect(firstPrompt).not.toContain("Second agent");
    expect(mocks.runAgentStream.mock.calls[0][0].allowedTools).toEqual([
      "read_file",
    ]);
    expect(mocks.runAgentStream.mock.calls[1][0].allowedTools).toEqual([
      "read_file",
    ]);
  });
});
