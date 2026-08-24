/**
 * 本文件测试工作区搜索筛选解析与结果分组。
 * 锁定花括号 glob 不被错误拆分，以及后端顺序在分组后保持不变。
 */

import { describe, expect, it } from "vitest";
import { groupContentHits, parseGlobInput } from "./model";

describe("workspace search model", () => {
  it("parses comma-separated globs without splitting brace alternatives", () => {
    expect(parseGlobInput("src/**/*.{ts,tsx}, tests/**, [a,b].md")).toEqual([
      "src/**/*.{ts,tsx}",
      "tests/**",
      "[a,b].md",
    ]);
  });

  it("groups hits by relative path in encounter order", () => {
    const hits = [
      {
        path: "/repo/a.ts",
        rel: "a.ts",
        line: 2,
        text: "first",
        ranges: [],
      },
      {
        path: "/repo/a.ts",
        rel: "a.ts",
        line: 8,
        text: "second",
        ranges: [],
      },
      {
        path: "/repo/b.ts",
        rel: "b.ts",
        line: 1,
        text: "third",
        ranges: [],
      },
    ];

    expect(groupContentHits(hits).map((group) => group.rel)).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(groupContentHits(hits)[0].hits).toHaveLength(2);
  });
});
