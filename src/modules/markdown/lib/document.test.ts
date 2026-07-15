import {
  buildMarkdownDocument,
  coalesceMarkdownDocument,
  findBlockIndexForSourceLine,
  MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD,
  MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD,
  type MarkdownDocument,
  type MarkdownDocumentBlock,
  prepareMarkdownDocument,
  shouldProgressivelyRender,
} from "@/modules/markdown/lib/document";
import { parseMarkdownIntoBlocks } from "streamdown";
import { describe, expect, it } from "vitest";

function joinedContent(document: MarkdownDocument): string {
  return document.blocks.map((block) => block.content).join("");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function thresholdDocument(
  sourceLength: number,
  blockCount: number,
): MarkdownDocument {
  const blocks = Array.from<MarkdownDocumentBlock>({ length: blockCount });
  return {
    source: "x".repeat(sourceLength),
    blocks,
    sourceBlockCount: blockCount,
    outline: [],
    lineCount: 1,
  };
}

describe("buildMarkdownDocument", () => {
  it("partitions the exact original source and creates stable block metadata", () => {
    const source =
      "# First\r\n\r\nParagraph\rMore\r\n\r\n```ts\r\n# code\r\n```\r\n";
    const first = buildMarkdownDocument(source);
    const second = buildMarkdownDocument(source);

    expect(joinedContent(first)).toBe(source);
    expect(first.blocks.map((block) => block.index)).toEqual(
      first.blocks.map((_, index) => index),
    );
    expect(first.blocks.map((block) => block.key)).toEqual(
      second.blocks.map((block) => block.key),
    );
    expect(
      first.blocks.every((block) => block.startLine <= block.endLine),
    ).toBe(true);
    expect(
      first.blocks.every(
        (block) =>
          Number.isFinite(block.estimatedHeight) && block.estimatedHeight >= 0,
      ),
    ).toBe(true);
    expect(first.lineCount).toBe(9);
  });

  it("extracts setext and nested headings with readable inline text", () => {
    const source = [
      "# **Top** [link](https://example.com) `code` &amp;",
      "",
      "Setext *Title*",
      "----------------",
      "",
      "- item",
      "  ## Nested ~~heading~~",
      "",
      "> ### Quote ![alt](image.png)",
      "",
    ].join("\n");
    const document = buildMarkdownDocument(source);

    expect(document.outline).toEqual([
      {
        id: "markdown-heading-1",
        level: 1,
        title: "Top link code &",
        sourceLine: 1,
        blockIndex: 0,
      },
      {
        id: "markdown-heading-3",
        level: 2,
        title: "Setext Title",
        sourceLine: 3,
        blockIndex: 1,
      },
      {
        id: "markdown-heading-7",
        level: 2,
        title: "Nested heading",
        sourceLine: 7,
        blockIndex: 2,
      },
      {
        id: "markdown-heading-9",
        level: 3,
        title: "Quote alt",
        sourceLine: 9,
        blockIndex: 4,
      },
    ]);
  });

  it("does not treat headings inside fenced or indented code as outline items", () => {
    const source = [
      "```md",
      "# fenced",
      "```",
      "",
      "    ## indented",
      "",
      "# Rendered",
      "",
    ].join("\n");

    expect(buildMarkdownDocument(source).outline).toEqual([
      {
        id: "markdown-heading-7",
        level: 1,
        title: "Rendered",
        sourceLine: 7,
        blockIndex: 3,
      },
    ]);
  });

  it("keeps a document containing footnote syntax in one block", () => {
    const source = "# Notes\n\nReference[^note].\n\n[^note]: Footnote text\n";
    const document = buildMarkdownDocument(source);

    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].content).toBe(source);
    expect(document.outline[0]?.blockIndex).toBe(0);
  });

  it("keeps HTML that spans lexer tokens in one block", () => {
    const source = "<div>\ninside\n\n# Inner\n</div>\n\n# Outer\n";
    const document = buildMarkdownDocument(source);

    expect(document.blocks).toHaveLength(2);
    expect(document.blocks[0].content).toBe(
      "<div>\ninside\n\n# Inner\n</div>\n\n",
    );
    expect(document.blocks[1].content).toBe("# Outer\n");
    expect(joinedContent(document)).toBe(source);
    expect(document.outline.map((heading) => heading.blockIndex)).toEqual([
      0, 1,
    ]);
  });

  it("matches Streamdown 2.5 block boundaries across edge cases", () => {
    const sources = [
      "first\n\nsecond\n",
      "first\r\n\r\n# second\r\n",
      "a\rb\r# c\r",
      " \n\t\n\n",
      "```text\n$$\n```\n\n# After\n",
      "before $$\n\n# Math heading\n\n$$ after\n\ntail\n",
      "<div>\ninside\n\n# Inner\n</div>\n\n# Outer\n",
      "<section><section>\ninside\n</section>\n</section>\n\nafter\n",
      '<img src="image.png">\n\nafter\n',
      "reference[^note]\n\n[^note]: definition\n",
    ];

    for (const source of sources) {
      const normalizedSource = normalizeLineEndings(source);
      expect(
        buildMarkdownDocument(source).blocks.map((block) =>
          normalizeLineEndings(block.content),
        ),
      ).toEqual(parseMarkdownIntoBlocks(normalizedSource));
    }
  });

  it("tracks nested list and blockquote heading lines", () => {
    const source = [
      "before",
      "",
      "- first",
      "  para",
      "",
      "  ## Head A",
      "",
      "- second",
      "",
      "  > ### Head B",
      "",
    ].join("\r\n");

    expect(
      buildMarkdownDocument(source).outline.map(
        ({ title, sourceLine, blockIndex }) => ({
          title,
          sourceLine,
          blockIndex,
        }),
      ),
    ).toEqual([
      { title: "Head A", sourceLine: 6, blockIndex: 2 },
      { title: "Head B", sourceLine: 10, blockIndex: 2 },
    ]);
  });

  it("joins a long unclosed double-dollar span without changing boundaries", () => {
    const source = `before $$\n\n${Array.from(
      { length: 1_000 },
      (_, index) => `paragraph ${index}\n\n`,
    ).join("")}`;
    const document = buildMarkdownDocument(source);

    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].content).toBe(source);
  });

  it("joins lexer blocks until a double-dollar math span closes", () => {
    const source = "before $$\n\n# Math heading\n\n$$ after\n\ntail\n";
    const document = buildMarkdownDocument(source);

    expect(document.blocks[0].content).toBe(
      "before $$\n\n# Math heading\n\n$$ after",
    );
    expect(document.outline[0]?.blockIndex).toBe(0);
    expect(joinedContent(document)).toBe(source);
  });

  it("does not extend odd double-dollar content out of a code block", () => {
    const source = "```text\n$$\n```\n\n# After\n";
    const document = buildMarkdownDocument(source);

    expect(document.blocks.map((block) => block.content)).toEqual([
      "```text\n$$\n```",
      "\n\n",
      "# After\n",
    ]);
    expect(document.outline[0]?.blockIndex).toBe(2);
  });

  it("returns an empty block list for an empty document", () => {
    expect(buildMarkdownDocument("")).toEqual({
      source: "",
      blocks: [],
      sourceBlockCount: 0,
      outline: [],
      lineCount: 1,
    });
  });
});

describe("coalesceMarkdownDocument", () => {
  it("reduces render roots without changing source or outline targets", () => {
    const source = Array.from(
      { length: 80 },
      (_, index) => `## Heading ${index + 1}\n\nParagraph ${index + 1}.\n\n`,
    ).join("");
    const sourceDocument = buildMarkdownDocument(source);
    const document = coalesceMarkdownDocument(sourceDocument);

    expect(sourceDocument.sourceBlockCount).toBeGreaterThanOrEqual(
      MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD,
    );
    expect(document.sourceBlockCount).toBe(sourceDocument.sourceBlockCount);
    expect(document.blocks.length).toBeLessThan(sourceDocument.blocks.length);
    expect(joinedContent(document)).toBe(source);
    expect(shouldProgressivelyRender(document)).toBe(true);
    expect(
      document.outline.every((heading) => {
        const block = document.blocks[heading.blockIndex];
        return (
          block &&
          heading.sourceLine >= block.startLine &&
          heading.sourceLine <= block.endLine
        );
      }),
    ).toBe(true);
  });

  it("prepares only long documents and keeps render keys deterministic", () => {
    const shortSource = "# Short\n\nParagraph.\n";
    expect(prepareMarkdownDocument(shortSource)).toEqual(
      buildMarkdownDocument(shortSource),
    );

    const longSource = Array.from(
      { length: 80 },
      (_, index) => `# Heading ${index}\n\n${"content ".repeat(12)}\n\n`,
    ).join("");
    const first = prepareMarkdownDocument(longSource);
    const second = prepareMarkdownDocument(longSource);

    expect(first.blocks.map((block) => block.key)).toEqual(
      second.blocks.map((block) => block.key),
    );
    expect(first.blocks.length).toBeLessThan(first.sourceBlockCount);
    expect(joinedContent(first)).toBe(longSource);
  });
});

describe("findBlockIndexForSourceLine", () => {
  it("finds content and separator blocks and clamps outside the document", () => {
    const blocks = buildMarkdownDocument("first\n\n# second\n\nthird\n").blocks;

    expect(
      blocks.map(({ startLine, endLine }) => [startLine, endLine]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
    expect(findBlockIndexForSourceLine(blocks, 0)).toBe(0);
    expect(findBlockIndexForSourceLine(blocks, 1)).toBe(0);
    expect(findBlockIndexForSourceLine(blocks, 2)).toBe(1);
    expect(findBlockIndexForSourceLine(blocks, 3)).toBe(2);
    expect(findBlockIndexForSourceLine(blocks, 4)).toBe(2);
    expect(findBlockIndexForSourceLine(blocks, 5)).toBe(3);
    expect(findBlockIndexForSourceLine(blocks, 500)).toBe(3);
    expect(findBlockIndexForSourceLine(blocks, Number.POSITIVE_INFINITY)).toBe(
      3,
    );
    expect(findBlockIndexForSourceLine(blocks, Number.NaN)).toBe(0);
    expect(findBlockIndexForSourceLine([], 1)).toBe(-1);
  });
});

describe("shouldProgressivelyRender", () => {
  it("uses inclusive character and block thresholds", () => {
    expect(
      shouldProgressivelyRender(
        thresholdDocument(
          MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD - 1,
          MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD - 1,
        ),
      ),
    ).toBe(false);
    expect(
      shouldProgressivelyRender(
        thresholdDocument(MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD, 0),
      ),
    ).toBe(true);
    expect(
      shouldProgressivelyRender(
        thresholdDocument(0, MARKDOWN_PROGRESSIVE_BLOCK_THRESHOLD),
      ),
    ).toBe(true);
  });

  it("accepts source text directly", () => {
    expect(
      shouldProgressivelyRender(
        "x".repeat(MARKDOWN_PROGRESSIVE_CHARACTER_THRESHOLD),
      ),
    ).toBe(true);
    expect(shouldProgressivelyRender("short document")).toBe(false);
  });
});
