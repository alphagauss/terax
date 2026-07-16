import type { MarkdownDocumentBlock } from "@/modules/markdown/lib/document";
import { initialMarkdownBlockCount } from "@/modules/markdown/MarkdownDocumentRenderer";
import { describe, expect, it } from "vitest";

function blocks(...heights: number[]): MarkdownDocumentBlock[] {
  return heights.map((estimatedHeight, index) => ({
    index,
    content: `block ${index}`,
    startLine: index + 1,
    endLine: index + 1,
    estimatedHeight,
  }));
}

describe("initialMarkdownBlockCount", () => {
  it("covers two viewports without exceeding the initial cap", () => {
    const documentBlocks = blocks(...Array.from({ length: 40 }, () => 100));

    expect(initialMarkdownBlockCount(documentBlocks, 600)).toBe(12);
    expect(initialMarkdownBlockCount(documentBlocks, 2_000)).toBe(24);
  });

  it("mounts a small minimum around short first blocks", () => {
    expect(initialMarkdownBlockCount(blocks(2_000, 10, 10, 10, 10), 500)).toBe(
      2,
    );
    expect(initialMarkdownBlockCount([], 500)).toBe(0);
  });
});
