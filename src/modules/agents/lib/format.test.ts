/**
 * 本文件测试终端编码 Agent 的展示名称格式化。
 * 锁定已知标识、大小写、未知标识和空值回退。
 */

import { describe, expect, it } from "vitest";
import { displayAgent } from "./format";

describe("displayAgent", () => {
  it("映射已知 Agent 标识", () => {
    expect(displayAgent("claude")).toBe("Claude Code");
    expect(displayAgent("codex")).toBe("Codex");
  });

  it("查找已知标识时忽略大小写", () => {
    expect(displayAgent("CLAUDE")).toBe("Claude Code");
    expect(displayAgent("gEmInI")).toBe("Gemini");
  });

  it("将未知标识首字母大写", () => {
    expect(displayAgent("foobar")).toBe("Foobar");
  });

  it("空标识回退为 Agent", () => {
    expect(displayAgent("")).toBe("Agent");
  });
});
