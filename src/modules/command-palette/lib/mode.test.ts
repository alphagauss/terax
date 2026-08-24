/**
 * 本文件测试命令面板前缀模式解析。
 * 锁定普通命令、历史和帮助入口，避免重新引入已迁移的内容搜索模式。
 */

import { describe, expect, it } from "vitest";
import { parseQuery } from "./mode";

describe("parseQuery", () => {
  it("defaults to commands mode with a trimmed term", () => {
    expect(parseQuery("  foo ")).toEqual({
      mode: "commands",
      term: "foo",
      raw: "  foo ",
    });
  });

  it("routes > to command history", () => {
    expect(parseQuery(">git")).toMatchObject({ mode: "history", term: "git" });
  });

  it("routes ? to help", () => {
    expect(parseQuery("?")).toMatchObject({ mode: "help", term: "" });
  });
});
