import {
  prepareMarkdownDocument,
  type MarkdownDocumentBlock,
} from "@/modules/markdown/lib/document";
import {
  initialMarkdownBlockCount,
  MarkdownDocumentRenderer,
} from "@/modules/markdown/MarkdownDocumentRenderer";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

it.each([false, true])(
  "renders line breaks within paragraphs and keeps blank lines as paragraphs (large=%s)",
  (large) => {
    const source = [
      "First line",
      "Second line  ",
      "Third line",
      "",
      "Next paragraph.",
      "",
      "```text",
      "first code line",
      "second code line",
      "```",
      ...(large ? ["", "Padding text. ".repeat(42_000)] : []),
    ].join(large ? "\r\n" : "\n");
    const model = prepareMarkdownDocument(source);
    const document = new Window().document;
    document.body.innerHTML = renderToStaticMarkup(
      createElement(MarkdownDocumentRenderer, {
        document: model,
        documentPath: "D:/line-breaks.md",
        mode: "dark",
        visible: false,
        scrollContainer: document.createElement(
          "div",
        ) as unknown as HTMLElement,
        onFragmentNavigate: () => {},
        onFileReferenceOpen: () => {},
        onFileReferenceOpenDirectory: () => {},
      }),
    );

    expect(model.progressive).toBe(large);
    const paragraphs = document.querySelectorAll("p");
    expect(paragraphs).toHaveLength(large ? 3 : 2);
    expect(paragraphs[0].querySelectorAll("br")).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe(
      "First line\nSecond line\nThird line",
    );
    expect(paragraphs[1].textContent).toBe("Next paragraph.");
    expect(paragraphs[1].querySelector("br")).toBeNull();
    expect(document.querySelector("pre, code")?.textContent?.trim()).toBe(
      "first code line\nsecond code line",
    );
    expect(document.querySelector("pre br, code br")).toBeNull();
  },
);

it.each([false, true])(
  "renders TeX math without changing code or source lines (large=%s)",
  (large) => {
    const source = [
      '4. **货币为 "$"（加元）**，标价 `$16.95`。',
      "",
      "Inline \\(x^2\\).",
      "",
      "\\[",
      "x +",
      "",
      "y",
      "\\]",
      "",
      "`\\(literal\\)`",
      "",
      "```text",
      "\\[literal code\\]",
      "```",
      "",
      "## After",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Terax | 1 |",
      "",
      large ? "Padding text. ".repeat(42_000) : "End.",
    ].join("\n");
    const model = prepareMarkdownDocument(source);
    const document = new Window().document;
    document.body.innerHTML = renderToStaticMarkup(
      createElement(MarkdownDocumentRenderer, {
        document: model,
        documentPath: "D:/formula.md",
        mode: "dark",
        visible: false,
        scrollContainer: document.createElement(
          "div",
        ) as unknown as HTMLElement,
        onFragmentNavigate: () => {},
        onFileReferenceOpen: () => {},
        onFileReferenceOpenDirectory: () => {},
      }),
    );
    expect(model.progressive).toBe(large);
    const tableViewport = document.querySelector(
      '[data-streamdown="table-wrapper"] > div:last-child',
    );
    expect(tableViewport).not.toBeNull();
    expect(tableViewport?.getAttribute("style") ?? "").not.toContain(
      "max-height",
    );
    expect(tableViewport?.hasAttribute("data-markdown-table-scroll")).toBe(
      false,
    );
    expect(tableViewport?.classList.contains("overflow-auto")).toBe(true);
    expect(document.querySelector("li")?.textContent?.trim()).toBe(
      '货币为 "$"（加元），标价 $16.95。',
    );
    expect(
      document.querySelector('[data-streamdown="strong"]')?.textContent,
    ).toBe('货币为 "$"（加元）');
    expect(document.querySelectorAll(".katex")).toHaveLength(2);
    expect(document.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(
      [...document.querySelectorAll("code")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(
      expect.arrayContaining(["$16.95", "\\(literal\\)", "\\[literal code\\]"]),
    );
    expect(
      document.querySelector("h2")?.getAttribute("data-markdown-source-line"),
    ).toBe(String(source.split("\n").indexOf("## After") + 1));
  },
);

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
