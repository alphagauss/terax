/**
 * 本文件测试通用 Subagent 工具的新 schema 和运行时委托。
 * 测试锁定默认后台行为，不保留旧角色类型或温度参数。
 */

import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { buildSubagentTools, subagentToolResult } from "./subagent";

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
  it("将任务结果映射为 snake_case，保留正文与内部结果", async () => {
    const internal = {
      taskId: "abcd",
      label: "review",
      status: "completed" as const,
      durationMs: 42,
      result: '{"taskId":"business-content"}',
    };
    const { result } = await run(
      { task: "review it", wait: true },
      vi.fn().mockResolvedValue(internal),
    );
    expect(result).toEqual({
      task_id: "abcd",
      label: "review",
      status: "completed",
      duration_ms: 42,
      result: internal.result,
    });
    expect(internal).toHaveProperty("taskId", "abcd");
    expect(
      subagentToolResult({ taskId: "abcd", status: "running", timedOut: true }),
    ).toEqual({
      task_id: "abcd",
      status: "running",
      timed_out: true,
    });
  });
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

  it("支持 wait=true 同步等待", async () => {
    const { start } = await run({ task: "review it", wait: true });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ task: "review it", wait: true }),
    );
  });
});

it("validates explicit wait timeouts and requires an owned task identifier", async () => {
  const manage = vi
    .fn()
    .mockResolvedValue({ status: "completed", result: "done" });
  const tool = buildSubagentTools(undefined, manage).subagent_task;
  const schema = tool.inputSchema as unknown as {
    safeParse: (value: unknown) => { success: boolean };
  };
  for (const timeout_ms of [0, 999, 300001, 1500.5])
    expect(
      schema.safeParse({ action: "wait", task_id: "task", timeout_ms }).success,
    ).toBe(false);
  expect(schema.safeParse({ action: "wait" }).success).toBe(false);
  expect(
    schema.safeParse({
      action: "send",
      task_id: "task",
      message: "continue",
      timeout_ms: 1000,
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ action: "get", task_id: "task", wait: true }).success,
  ).toBe(false);
  for (const timeout_ms of [undefined, 1000, 300000])
    expect(
      schema.safeParse({ action: "wait", task_id: "task", timeout_ms }).success,
    ).toBe(true);
  if (!tool.execute) throw new Error("Missing tool");
  expect(await tool.execute({ action: "wait" }, toolOptions)).toMatchObject({
    status: "rejected",
  });
  expect(manage).not.toHaveBeenCalled();
  await tool.execute(
    { action: "wait", task_id: "task", timeout_ms: 1000 },
    toolOptions,
  );
  expect(manage).toHaveBeenCalledWith(
    { action: "wait", taskId: "task", timeoutMs: 1000 },
    toolOptions,
  );
});
