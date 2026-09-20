/**
 * 本文件测试 Markdown 预览安全管线。
 *
 * 锁定 GFM Alerts 的受控结构，并确保新增类名许可不会放开脚本和任意属性。
 */

import { buildMarkdownRehypePlugins } from "@/modules/markdown/lib/rehype";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

function render(
  markdown: string,
  headingSlugById: Record<string, string> = {},
): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        components: {
          a: ({ node: _node, ...props }) => createElement("a", props),
        },
        mode: "static",
        parseIncompleteMarkdown: false,
        rehypePlugins: buildMarkdownRehypePlugins(
          headingSlugById,
          "D:/project/docs/current.md",
        ),
      },
      markdown,
    ),
  );
}

describe("Markdown rehype pipeline", () => {
  it("renders the five supported alert types and leaves unknown markers quoted", () => {
    const html = render(
      [
        "> [!NOTE]",
        "> Note body",
        "",
        "> [!TIP]",
        "> Tip body",
        "",
        "> [!IMPORTANT]",
        "> Important body",
        "",
        "> [!WARNING]",
        "> Warning body",
        "",
        "> [!CAUTION]",
        "> Caution body",
        "",
        "> [!UNKNOWN]",
        "> Ordinary quote",
      ].join("\n"),
    );

    for (const type of ["note", "tip", "important", "warning", "caution"]) {
      expect(html).toContain(`markdown-alert-${type}`);
    }
    expect(html).toContain("[!UNKNOWN]");
    expect(html).toContain('data-streamdown="blockquote"');
  });

  it("keeps scripts, event handlers and arbitrary classes inert", () => {
    const html = render(
      [
        '<script>alert("x")</script>',
        "<style>body { display: none }</style>",
        '<iframe src="https://example.com"></iframe>',
        '<object data="https://example.com"></object>',
        '<div class="markdown-alert evil" onclick="alert(1)">unsafe</div>',
        "[unsafe](JaVaScRiPt:alert(1))",
        "",
        "> [!WARNING]",
        "> Safe",
      ].join("\n"),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("onclick");
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toContain("evil");
    expect(html).toContain("markdown-alert-warning");
  });

  it("preserves common GitHub document structures for focused styling", () => {
    const html = render(
      [
        "- [x] Done",
        "- [ ] Pending",
        "",
        "Press <kbd>Ctrl</kbd> + <kbd>K</kbd>.",
        "",
        "<details>",
        "<summary>More</summary>",
        "Body",
        "</details>",
        "",
        "H<sub>2</sub>O and x<sup>2</sup>.",
        "",
        "Footnote[^note].",
        "",
        "[^note]: Definition",
        "",
        "![Alt](https://example.com/image.png)",
        "",
        "![Relative](./assets/local.png)",
      ].join("\n"),
    );

    expect(html).toContain("contains-task-list");
    expect(html).toContain("task-list-item");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>More</summary>");
    expect(html).toContain('data-streamdown="subscript"');
    expect(html).toContain('data-streamdown="superscript"');
    expect(html).toContain("data-footnotes");
    expect(html).toContain("data-footnote-ref");
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/image\.png"/);
    expect(html).toContain('src="terax-relative-image:.%2Fassets%2Flocal.png"');
  });

  it("emits a GitHub-compatible public heading id for fragment links", () => {
    const html = render("[Jump](#hello-world)\n\n# Hello World", {
      "markdown-heading-3": "hello-world",
    });

    expect(html).toContain('href="#hello-world"');
    expect(html).toContain('id="user-content-hello-world"');
    expect(html).toContain('data-markdown-heading-id="markdown-heading-3"');
  });

  it("preserves absolute file references through the security pipeline", () => {
    const html = render(
      "[win](D:/project/config.ts:12) [unix](</workspace/my project/config.ts:5>)",
    );

    expect(html).toContain('href="terax-file:D%3A%2Fproject%2Fconfig.ts%3A12"');
    expect(html).toContain(
      'href="terax-file:%2Fworkspace%2Fmy%20project%2Fconfig.ts%3A5"',
    );
  });

  it("resolves relative document links before link hardening", () => {
    const html = render(
      "[readme](../README.md) [source](./guide/config.ts:8#details)",
    );

    expect(html).toContain('href="terax-file:D%3A%2Fproject%2FREADME.md"');
    expect(html).toContain(
      'href="terax-file:D%3A%2Fproject%2Fdocs%2Fguide%2Fconfig.ts%3A8"',
    );
    expect(html).not.toContain("[blocked]");
  });
});
