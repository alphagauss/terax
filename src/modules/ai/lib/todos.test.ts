/**
 * 本文件测试 AI 待办列表的纯验证规则。
 * 锁定标题非空和最多一个进行中事项的不变量。
 */

import { describe, expect, it } from "vitest";
import { type Todo, validateTodos } from "./todos";

function todo(overrides: Partial<Todo> = {}): Todo {
  return { id: "t1", title: "task", status: "pending", ...overrides };
}

describe("validateTodos", () => {
  it("接受空列表和单个进行中事项", () => {
    expect(validateTodos([])).toBeNull();
    expect(
      validateTodos([
        todo({ id: "a", status: "in_progress" }),
        todo({ id: "b", status: "pending" }),
      ]),
    ).toBeNull();
  });

  it("拒绝空白标题", () => {
    expect(validateTodos([todo({ title: "" })])).toContain("title");
    expect(validateTodos([todo({ title: "   " })])).toContain("title");
  });

  it("拒绝多个进行中事项并报告数量", () => {
    const error = validateTodos([
      todo({ id: "a", status: "in_progress" }),
      todo({ id: "b", status: "in_progress" }),
    ]);
    expect(error).toContain("in_progress");
    expect(error).toContain("2");
  });
});
