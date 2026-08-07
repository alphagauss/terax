/**
 * 本文件验证 Agent 在模型初始化前发布并等待本轮持久化快照。
 * 测试锁定磁盘提交失败时不得继续创建模型或发起远端请求。
 */

import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it, vi } from "vitest";
import { runAgentStream } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";

describe("agent preflight persistence", () => {
  it("awaits the user message and system prompt commit before model setup", async () => {
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "inspect this" }],
      },
    ];
    const failure = new Error("preflight commit failed");
    const onSystemPrompt = vi.fn(async () => {
      throw failure;
    });

    await expect(
      runAgentStream({
        keys: EMPTY_PROVIDER_KEYS,
        modelId: "lmstudio-local",
        cwd: "D:/workspace/project",
        toolContext: {} as never,
        uiMessages: messages,
        onSystemPrompt,
      }),
    ).rejects.toBe(failure);

    expect(onSystemPrompt).toHaveBeenCalledWith(
      expect.stringContaining("Working directory: D:/workspace/project"),
      messages,
    );
  });
});
