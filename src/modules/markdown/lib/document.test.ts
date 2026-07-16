import {
  findBlockIndexForSourceLine,
  MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD,
  prepareMarkdownDocument,
} from "@/modules/markdown/lib/document";
import { describe, expect, it } from "vitest";

function repeatToLength(value: string, length: number): string {
  return value.repeat(Math.ceil(length / value.length)).slice(0, length);
}

describe("prepareMarkdownDocument", () => {
  it("keeps ordinary documents static and normalizes line endings", () => {
    const document = prepareMarkdownDocument("# Title\r\n\r\nParagraph\r\n");

    expect(document.source).toBe("# Title\n\nParagraph\n");
    expect(document.progressive).toBe(false);
    expect(document.blocks).toEqual([
      expect.objectContaining({
        index: 0,
        content: document.source,
        startLine: 1,
        endLine: 3,
      }),
    ]);
    expect(document.outline).toEqual([
      {
        id: "markdown-heading-1",
        level: 1,
        title: "Title",
        sourceLine: 1,
        blockIndex: 0,
      },
    ]);
  });

  it("extracts nested and setext headings but ignores fenced code", () => {
    const source = [
      "Main *title* &amp; `code`",
      "==========================",
      "",
      "> ## Nested **heading**",
      "",
      "- item",
      "  - ### List heading",
      "",
      "```md",
      "# Not a heading",
      "```",
      "",
    ].join("\n");

    expect(
      prepareMarkdownDocument(source).outline.map(({ title, sourceLine }) => ({
        title,
        sourceLine,
      })),
    ).toEqual([
      { title: "Main title & code", sourceLine: 1 },
      { title: "Nested heading", sourceLine: 4 },
      { title: "List heading", sourceLine: 7 },
    ]);
  });

  it("does not progressively render a short document with many tiny blocks", () => {
    const source = Array.from(
      { length: 300 },
      (_, index) => `paragraph ${index}\n\n`,
    ).join("");
    const document = prepareMarkdownDocument(source);

    expect(source.length).toBeLessThan(
      MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD,
    );
    expect(document.progressive).toBe(false);
    expect(document.blocks).toHaveLength(1);
  });

  it("coalesces a large safe document into exact progressive render blocks", () => {
    const section =
      "## Section\n\nParagraph with **bold** text and ordinary prose.\n\n";
    const source = repeatToLength(
      section,
      MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD + 32_000,
    );
    const document = prepareMarkdownDocument(source);

    expect(document.progressive).toBe(true);
    expect(document.blocks.length).toBeGreaterThan(1);
    expect(document.blocks.map((block) => block.content).join("")).toBe(source);
    expect(document.blocks.length).toBeLessThan(100);
    for (const heading of document.outline) {
      const block = document.blocks[heading.blockIndex];
      expect(block.startLine).toBeLessThanOrEqual(heading.sourceLine);
      expect(block.endLine).toBeGreaterThanOrEqual(heading.sourceLine);
    }
  });

  it("falls back to whole-document rendering for global references", () => {
    const prose = repeatToLength(
      "Paragraph using [shared].\n\n",
      MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD + 1_000,
    );
    const references = prepareMarkdownDocument(
      `[shared]: https://example.com\n\n${prose}`,
    );
    const footnotes = prepareMarkdownDocument(
      `Footnote[^note].\n\n[^note]: Definition\n\n${prose}`,
    );

    expect(references.progressive).toBe(false);
    expect(references.blocks).toHaveLength(1);
    expect(footnotes.progressive).toBe(false);
    expect(footnotes.blocks).toHaveLength(1);
  });

  it("returns an empty model for empty source", () => {
    expect(prepareMarkdownDocument("")).toEqual({
      source: "",
      blocks: [],
      outline: [],
      progressive: false,
    });
  });
});

describe("findBlockIndexForSourceLine", () => {
  const blocks = prepareMarkdownDocument(
    repeatToLength(
      "Paragraph text.\n\n",
      MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD + 10_000,
    ),
  ).blocks;

  it("clamps outside the document and finds an interior source line", () => {
    expect(findBlockIndexForSourceLine([], 1)).toBe(-1);
    expect(findBlockIndexForSourceLine(blocks, -1)).toBe(0);
    expect(findBlockIndexForSourceLine(blocks, Number.POSITIVE_INFINITY)).toBe(
      blocks.length - 1,
    );

    const target = blocks[Math.floor(blocks.length / 2)];
    expect(findBlockIndexForSourceLine(blocks, target.startLine + 1)).toBe(
      target.index,
    );
  });
});
