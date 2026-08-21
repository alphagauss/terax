/**
 * 本文件测试 AI 待办写入工具的会话和持久化边界。
 * 锁定无会话拒绝、标识补全、有效写入及无效批次不落库。
 */

import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const storeMock = vi.hoisted(() => ({ setTodos: vi.fn() }));

vi.mock("../store/todoStore", () => ({
  useTodosStore: { getState: () => ({ setTodos: storeMock.setTodos }) },
}));

import { buildTodoTools } from "./todo";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

function makeContext(sessionId: string | null = "session"): ToolContext {
  return {
    getSessionId: () => sessionId,
  } as unknown as ToolContext;
}

type Result = Record<string, unknown>;

async function run(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<Result> {
  const execute = buildTodoTools(ctx).todo_write.execute;
  if (!execute) throw new Error("todo_write 缺少执行函数");
  return (await execute(input as never, toolOptions)) as unknown as Result;
}

beforeEach(() => vi.clearAllMocks());

describe("todo_write", () => {
  it("没有活动会话时拒绝写入", async () => {
    const result = await run(makeContext(null), { todos: [] });
    expect(result.error).toContain("no active session");
    expect(storeMock.setTodos).not.toHaveBeenCalled();
  });

  it("持久化待办并报告数量和当前事项", async () => {
    const result = await run(makeContext(), {
      todos: [
        { id: "a", title: "first", status: "in_progress" },
        { id: "b", title: "second", status: "pending" },
      ],
    });
    expect(result).toMatchObject({ ok: true, count: 2, inProgress: "first" });
    expect(storeMock.setTodos).toHaveBeenCalledWith(
      "session",
      expect.any(Array),
    );
  });

  it("为没有标识的待办生成标识", async () => {
    await run(makeContext(), {
      todos: [{ title: "no id yet", status: "pending" }],
    });
    const persisted = storeMock.setTodos.mock.calls[0][1];
    expect(persisted[0].id).toBeTruthy();
  });

  it("无效批次不执行持久化", async () => {
    const result = await run(makeContext(), {
      todos: [
        { id: "a", title: "x", status: "in_progress" },
        { id: "b", title: "y", status: "in_progress" },
      ],
    });
    expect(result.error).toContain("in_progress");
    expect(storeMock.setTodos).not.toHaveBeenCalled();
  });
});
