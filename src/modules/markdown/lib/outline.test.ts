import { describe, expect, it } from "vitest";
import { findActiveOutlineId, type MarkdownOutlineItem } from "./outline";

const items: MarkdownOutlineItem[] = [
  {
    id: "first",
    level: 1,
    title: "First",
    sourceLine: 2,
    blockIndex: 0,
  },
  {
    id: "second",
    level: 2,
    title: "Second",
    sourceLine: 8,
    blockIndex: 3,
  },
  {
    id: "third",
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
