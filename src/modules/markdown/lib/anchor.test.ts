import type { MarkdownDocumentBlock } from "@/modules/markdown/lib/document";
import {
  markdownBlockRenderContent,
  remarkMarkdownBlockSourcePosition,
} from "@/modules/markdown/lib/sourcePosition";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from "streamdown";
import { describe, expect, it } from "vitest";
import {
  captureRenderedAnchor,
  rehypeMarkdownSourcePositions,
  restoreRenderedAnchor,
} from "./anchor";

function block(start: number, end: number, top: number, height: number) {
  return {
    dataset: {
      markdownSourceLine: String(start),
      markdownSourceEndLine: String(end),
    },
    getBoundingClientRect: () => ({
      top,
      bottom: top + height,
      height,
    }),
  } as unknown as HTMLElement;
}

function container(blocks: HTMLElement[], top = 100) {
  return {
    scrollTop: 200,
    scrollHeight: 1_000,
    clientHeight: 500,
    querySelectorAll: () => blocks,
    getBoundingClientRect: () => ({ top }),
  } as unknown as HTMLElement;
}

describe("markdown rendered anchors", () => {
  it("maps progress through a rendered source block back to a source line", () => {
    const target = container([block(10, 20, 50, 100)]);

    expect(captureRenderedAnchor(target)).toEqual({
      sourceLine: 15,
      offset: 0,
      scrollRatio: 0.4,
    });
  });

  it("restores a source line inside the smallest matching rendered block", () => {
    const outer = block(10, 30, 80, 200);
    const inner = block(15, 20, 120, 50);
    const target = container([outer, inner]);

    restoreRenderedAnchor(target, {
      sourceLine: 18,
      offset: 0,
      scrollRatio: 0,
    });

    expect(target.scrollTop).toBe(250);
  });
});

describe("rehypeMarkdownSourcePositions", () => {
  it("adds source ranges only to rendered block elements", () => {
    const paragraph = {
      type: "element",
      tagName: "p",
      position: { start: { line: 3 }, end: { line: 5 } },
    };
    const emphasis = {
      type: "element",
      tagName: "em",
      position: { start: { line: 3 }, end: { line: 3 } },
    };
    const tree = { type: "root", children: [paragraph, emphasis] };

    rehypeMarkdownSourcePositions()(tree);

    expect(paragraph).toMatchObject({
      properties: {
        "data-markdown-source-line": "3",
        "data-markdown-source-end-line": "5",
      },
    });
    expect(emphasis).not.toHaveProperty("properties");
  });

  it("offsets block ranges and assigns stable heading ids", () => {
    const heading = {
      type: "element",
      tagName: "h2",
      position: { start: { line: 2 }, end: { line: 3 } },
    };

    rehypeMarkdownSourcePositions({ lineOffset: 10 })({
      type: "root",
      children: [heading],
    });

    expect(heading).toMatchObject({
      properties: {
        id: "markdown-heading-12",
        "data-markdown-heading-id": "markdown-heading-12",
        "data-markdown-source-line": "12",
        "data-markdown-source-end-line": "13",
      },
    });
  });

  it("preserves source ranges through the Streamdown render pipeline", () => {
    const html = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "static",
          rehypePlugins: [
            ...Object.values(defaultRehypePlugins),
            rehypeMarkdownSourcePositions,
          ],
        },
        "Paragraph text",
      ),
    );

    expect(html).toContain('data-markdown-source-line="1"');
    expect(html).toContain('data-markdown-source-end-line="1"');
  });

  it("keeps Streamdown's default heading renderer", () => {
    const html = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "static",
          rehypePlugins: [
            ...Object.values(defaultRehypePlugins),
            rehypeMarkdownSourcePositions,
          ],
        },
        "# Heading",
      ),
    );

    expect(html).toContain('data-streamdown="heading-1"');
    expect(html).toContain('id="markdown-heading-1"');
  });

  it("maps a progressively rendered block back to absolute source lines", () => {
    const block: MarkdownDocumentBlock = {
      index: 4,
      content: "## Deferred heading\n",
      startLine: 25,
      endLine: 25,
      estimatedHeight: 60,
      key: "deferred-heading",
    };
    const html = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "static",
          remarkPlugins: [
            remarkMarkdownBlockSourcePosition,
            ...Object.values(defaultRemarkPlugins),
          ],
          rehypePlugins: [
            ...Object.values(defaultRehypePlugins),
            rehypeMarkdownSourcePositions,
          ],
        },
        markdownBlockRenderContent(block),
      ),
    );

    expect(html).not.toContain("terax-markdown-block");
    expect(html).toContain('id="markdown-heading-25"');
    expect(html).toContain('data-markdown-source-line="25"');
    expect(html).toContain('data-markdown-block-index="4"');
  });
});
