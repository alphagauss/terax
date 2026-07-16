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
  readActiveRenderedHeadingId,
  readRenderedViewportSourceLine,
  rehypeMarkdownSourcePositions,
  restoreRenderedSourceLine,
} from "./anchor";

function sourceElement(
  start: number,
  end: number,
  top: number,
  height: number,
) {
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

function container(elements: HTMLElement[], top = 100) {
  return {
    scrollTop: 200,
    ownerDocument: { elementsFromPoint: () => [] },
    querySelectorAll: () => elements,
    getBoundingClientRect: () => ({
      top,
      left: 0,
      right: 600,
      width: 600,
      height: 500,
    }),
  } as unknown as HTMLElement;
}

describe("rendered source lines", () => {
  it("reads and restores against the shared viewport activation line", () => {
    const outer = sourceElement(10, 30, 80, 200);
    const inner = sourceElement(15, 20, 120, 50);
    const target = container([outer, inner]);

    expect(readRenderedViewportSourceLine(target)).toBe(16);
    expect(restoreRenderedSourceLine(target, 18)).toBe(true);
    expect(target.scrollTop).toBe(218);
  });

  it("selects the last heading above the activation line", () => {
    const first = {
      dataset: { markdownHeadingId: "first" },
      getBoundingClientRect: () => ({ top: 90 }),
    } as unknown as HTMLElement;
    const second = {
      dataset: { markdownHeadingId: "second" },
      getBoundingClientRect: () => ({ top: 132 }),
    } as unknown as HTMLElement;
    const third = {
      dataset: { markdownHeadingId: "third" },
      getBoundingClientRect: () => ({ top: 180 }),
    } as unknown as HTMLElement;

    expect(readActiveRenderedHeadingId(container([first, second, third]))).toBe(
      "second",
    );
  });
});

describe("rehypeMarkdownSourcePositions", () => {
  it("adds ranges, unique heading ids and preserves an authored id", () => {
    const first = {
      type: "element",
      tagName: "h2",
      properties: { id: "authored" },
      position: { start: { line: 2 }, end: { line: 2 } },
    };
    const second = {
      type: "element",
      tagName: "h3",
      position: { start: { line: 2 }, end: { line: 3 } },
    };

    rehypeMarkdownSourcePositions({ lineOffset: 10 })({
      type: "root",
      children: [first, second],
    });

    expect(first.properties).toMatchObject({
      id: "authored",
      "data-markdown-heading-id": "markdown-heading-12",
      "data-markdown-source-line": "12",
    });
    expect(second).toMatchObject({
      properties: {
        id: "markdown-heading-12-2",
        "data-markdown-heading-id": "markdown-heading-12-2",
        "data-markdown-source-end-line": "13",
      },
    });
  });

  it("preserves source ranges through Streamdown static rendering", () => {
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
        "# Heading\n\nParagraph",
      ),
    );

    expect(html).toContain('data-streamdown="heading-1"');
    expect(html).toContain('data-markdown-heading-id="markdown-heading-1"');
    expect(html).toContain('data-markdown-source-line="3"');
  });

  it("places fenced-code source ranges on the code element", () => {
    const html = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "static",
          components: {
            code: (props) => createElement("code", props),
          },
          rehypePlugins: [
            ...Object.values(defaultRehypePlugins),
            rehypeMarkdownSourcePositions,
          ],
        },
        "```ts\nconst value = 1;\n```",
      ),
    );

    expect(html).toMatch(
      /<code[^>]*data-markdown-source-line="1"[^>]*data-markdown-source-end-line="3"/,
    );
  });

  it("maps a progressive block back to absolute source lines", () => {
    const block: MarkdownDocumentBlock = {
      index: 4,
      content: "## Deferred heading\n",
      startLine: 25,
      endLine: 25,
      estimatedHeight: 60,
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
    expect(html).toContain('data-markdown-heading-id="markdown-heading-25"');
    expect(html).toContain('data-markdown-block-index="4"');
  });
});
