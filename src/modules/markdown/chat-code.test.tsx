/**
 * 本文件测试 Markdown 代码块的语言识别和上下文行为。
 *
 * 锁定无标签围栏代码内容，以及 Shell 与其他语言共享只读代码块行为。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

import { isDiagramLanguage } from "./chat-code";
import { MarkdownCode } from "./markdown-code";

describe("isDiagramLanguage", () => {
  it("recognizes Mermaid fences case-insensitively", () => {
    expect(isDiagramLanguage("mermaid")).toBe(true);
    expect(isDiagramLanguage("MERMAID")).toBe(true);
  });

  it("does not classify regular code fences as diagrams", () => {
    expect(isDiagramLanguage("typescript")).toBe(false);
    expect(isDiagramLanguage(null)).toBe(false);
  });
});

describe("MarkdownCode", () => {
  it("marks inline code for shared styling without treating fences as inline", () => {
    const html = renderToStaticMarkup(
      <Streamdown components={{ code: MarkdownCode }} mode="static">
        {"运行 `pnpm test`。\n\n```\npnpm test\n```"}
      </Streamdown>,
    );

    expect(html).toMatch(
      /<code[^>]*data-streamdown="inline-code"[^>]*>pnpm test<\/code>/,
    );
    expect(html.match(/data-streamdown="inline-code"/g)).toHaveLength(1);
    expect(html).toContain("data-markdown-code-block");
  });

  it("preserves unlabeled fenced blocks and their line breaks", () => {
    const html = renderToStaticMarkup(
      <Streamdown components={{ code: MarkdownCode }} mode="static">
        {"```\nfirst line\nsecond line\n```"}
      </Streamdown>,
    );

    expect(html).toContain("data-markdown-code-block");
    expect(html).toContain("first line\nsecond line");
  });

  it("renders shell and regular languages with the same copy-only actions", () => {
    const shell = renderToStaticMarkup(
      <MarkdownCode className="language-bash" data-block="true">
        echo hello
      </MarkdownCode>,
    );
    const regular = renderToStaticMarkup(
      <MarkdownCode className="language-typescript" data-block="true">
        const value = 1;
      </MarkdownCode>,
    );

    expect(shell).not.toContain("Run in active terminal");
    expect(regular).not.toContain("Run in active terminal");
    expect(shell).toContain('aria-label="Copy code"');
    expect(regular).toContain('aria-label="Copy code"');
    expect(shell).toContain("data-markdown-code-block");
    expect(regular).toContain("data-markdown-code-block");
  });
});
