/**
 * 本文件测试通用 Subagent 工具的新 schema 和运行时委托。
 * 测试锁定默认后台行为，不保留旧角色类型或温度参数。
 */

import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";

import { buildSubagentTools } from "./subagent";

const toolOptions: ToolExecutionOptions<never> = {
  toolCallId: "tool-call",
  messages: [],
  context: undefined as never,
};

type Result = Record<string, unknown>;

async function run(
  input: Record<string, unknown>,
  start = vi.fn().mockResolvedValue({ status: "running" }),
): Promise<{ result: Result; start: ReturnType<typeof vi.fn> }> {
  const execute = buildSubagentTools(start).run_subagent.execute;
  if (!execute) throw new Error("run_subagent 缺少执行函数");
  return {
    result: (await execute(input as never, toolOptions)) as unknown as Result,
    start,
  };
}

describe("run_subagent", () => {
  it("拒绝仅包含空白的任务和标签", () => {
    const schema = buildSubagentTools().run_subagent.inputSchema as unknown as {
      safeParse: (input: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ task: "   " }).success).toBe(false);
    expect(schema.safeParse({ task: "review it", label: "   " }).success).toBe(
      false,
    );
  });

  it("默认以 wait=false 委托自包含任务", async () => {
    const { result, start } = await run({ task: "review it", label: "card" });
    expect(result).toEqual({ status: "running" });
    expect(start).toHaveBeenCalledWith({
      task: "review it",
      label: "card",
      toolCallId: "tool-call",
      wait: false,
      abortSignal: undefined,
    });
  });

  it("支持 wait=true 且 schema 不接受旧字段", async () => {
    const { start } = await run({ task: "review it", wait: true });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ task: "review it", wait: true }),
    );
  });
});
