/**
 * 本文件验证 Agent 在模型初始化前发布并等待本轮持久化快照。
 * 测试锁定磁盘提交失败时不得继续创建模型或发起远端请求。
 */

import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it, vi } from "vitest";
import { runAgentStream } from "@/modules/ai/lib/agent";
import { AgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import { AGENT_TOOL_IDS } from "@/modules/ai/lib/agentTools";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { modelRefForProvider } from "@/modules/ai/config";

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
        model: modelRefForProvider("lmstudio", "mock-model"),
        systemPrompt: "Stable prompt",
        allowedTools: AGENT_TOOL_IDS,
        maxConcurrentSubagents: 3,
        turnCoordinator: new AgentTurnCoordinator(),
        toolContext: {
          getPermissionMode: () => "ask",
        } as never,
        uiMessages: messages,
        onSystemPrompt,
        onCheckpoint: vi.fn(),
      }),
    ).rejects.toBe(failure);

    expect(onSystemPrompt).toHaveBeenCalledWith("Stable prompt", messages);
  });
});
