import type { MarkdownDocumentBlock } from "@/modules/markdown/lib/document";
import {
  MARKDOWN_BLOCK_INDEX_DATA_KEY,
  MARKDOWN_LINE_OFFSET_DATA_KEY,
  markdownBlockRenderContent,
  remarkMarkdownBlockSourcePosition,
} from "@/modules/markdown/lib/sourcePosition";
import { describe, expect, it } from "vitest";

describe("markdown block source positions", () => {
  it("adds an internal block marker without changing the block metadata", () => {
    const block: MarkdownDocumentBlock = {
      index: 7,
      content: "## Heading\n",
      startLine: 42,
      endLine: 42,
      estimatedHeight: 60,
    };

    expect(markdownBlockRenderContent(block)).toBe(
      "<!--terax-markdown-block:7:42-->\n## Heading\n",
    );
  });

  it("removes the marker and records the absolute source offset", () => {
    const marker = {
      type: "html",
      value: "<!--terax-markdown-block:7:42-->\n",
    };
    const paragraph = { type: "paragraph" };
    const tree = { children: [marker, paragraph] };
    const file = { data: {} };

    remarkMarkdownBlockSourcePosition()(tree, file);

    expect(tree.children).toEqual([paragraph]);
    expect(file.data).toEqual({
      [MARKDOWN_BLOCK_INDEX_DATA_KEY]: 7,
      [MARKDOWN_LINE_OFFSET_DATA_KEY]: 40,
    });
  });

  it("leaves user-authored HTML comments untouched", () => {
    const comment = { type: "html", value: "<!-- user comment -->\n" };
    const tree = { children: [comment] };
    const file = { data: {} };

    remarkMarkdownBlockSourcePosition()(tree, file);

    expect(tree.children).toEqual([comment]);
    expect(file.data).toEqual({});
  });
});
