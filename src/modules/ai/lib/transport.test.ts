/**
 * 本文件验证聊天传输层只发送真实会话消息，并使用会话固定目录构造运行上下文。
 * 测试锁定发送前不得复制或改写最后一条用户消息。
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
      toolContext: {} as never,
      getModelId: () => "model",
      getCustomInstructions: () => "",
      getAgentPersona: () => null,
      getCwd: () => "D:/workspace/project",
    });

    await transport.sendMessages({ messages });

    expect(mocks.readAgentsMd).toHaveBeenCalledWith("D:/workspace/project");
    expect(mocks.runAgentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "D:/workspace/project",
        projectInstructions: "Project instructions",
        uiMessages: messages,
      }),
    );
    expect(mocks.runAgentStream.mock.calls[0][0].uiMessages).toBe(messages);
    expect(messages[0].parts).toEqual([{ type: "text", text: "Inspect this" }]);
  });
});
