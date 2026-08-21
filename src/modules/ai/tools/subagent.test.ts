/**
 * 本文件测试只读子 Agent 工具的结果映射和失败收敛。
 * 通过隔离运行器与聊天状态，避免测试触发真实模型请求。
 */

import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const runSubagentMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/runSubagent", () => ({ runSubagent: runSubagentMock }));
vi.mock("../store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      apiKeys: {},
      selectedModelId: "model",
      patchAgentMeta: vi.fn(),
    }),
  },
}));

import { buildSubagentTools } from "./subagent";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(): ToolContext {
  return {
    getSessionId: () => "session",
  } as unknown as ToolContext;
}

type Result = Record<string, unknown>;

async function run(input: Record<string, unknown>): Promise<Result> {
  const execute = buildSubagentTools(makeContext()).run_subagent.execute;
  if (!execute) throw new Error("run_subagent 缺少执行函数");
  return (await execute(input as never, toolOptions)) as unknown as Result;
}

beforeEach(() => vi.clearAllMocks());

describe("run_subagent", () => {
  it("成功时映射子 Agent 结果字段", async () => {
    runSubagentMock.mockResolvedValue({
      summary: "done",
      stepCount: 4,
      durationMs: 1200,
    });
    await expect(
      run({ type: "reviewer", prompt: "review it", description: "card" }),
    ).resolves.toEqual({
      type: "reviewer",
      description: "card",
      summary: "done",
      stepCount: 4,
      durationMs: 1200,
    });
  });

  it("失败时返回错误结果而不抛出", async () => {
    runSubagentMock.mockRejectedValue(new Error("boom"));
    const result = await run({ type: "reviewer", prompt: "review it" });
    expect(result.type).toBe("reviewer");
    expect(result.error).toContain("boom");
  });
});
