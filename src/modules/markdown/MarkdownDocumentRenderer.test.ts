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
      large ? "Padding text. ".repeat(42_000) : "End.",
    ].join("\n");
    const model = prepareMarkdownDocument(source);
    const document = new Window().document;
    document.body.innerHTML = renderToStaticMarkup(
      createElement(MarkdownDocumentRenderer, {
        document: model,
        documentPath: "D:/formula.md",
        visible: false,
        scrollContainer: document.createElement(
          "div",
        ) as unknown as HTMLElement,
        onFragmentNavigate: () => {},
      }),
    );
    expect(model.progressive).toBe(large);
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
