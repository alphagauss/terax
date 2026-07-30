/**
 * 本文件测试 Markdown 目录的活动标题选择。
 *
 * 目录项包含公开 slug，但活动状态仍以稳定内部 id 和源码行号为准。
 */

import { describe, expect, it } from "vitest";
import { findActiveOutlineId, type MarkdownOutlineItem } from "./outline";

const items: MarkdownOutlineItem[] = [
  {
    id: "first",
    slug: "first",
    level: 1,
    title: "First",
    sourceLine: 2,
    blockIndex: 0,
  },
  {
    id: "second",
    slug: "second",
    level: 2,
    title: "Second",
    sourceLine: 8,
    blockIndex: 3,
  },
  {
    id: "third",
    slug: "third",
    level: 2,
    title: "Third",
    sourceLine: 16,
    blockIndex: 7,
  },
];

describe("findActiveOutlineId", () => {
  it("finds the last heading at or above a source line", () => {
    expect(findActiveOutlineId(items, 10)).toBe("second");
    expect(findActiveOutlineId(items, 16)).toBe("third");
  });

  it("returns null before the first heading", () => {
    expect(findActiveOutlineId(items, 1)).toBeNull();
  });
});
