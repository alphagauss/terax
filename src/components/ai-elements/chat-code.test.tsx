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
  it("preserves unlabeled fenced blocks and their line breaks", () => {
    const html = renderToStaticMarkup(
      <Streamdown components={{ code: MarkdownCode }} mode="static">
        {"```\nfirst line\nsecond line\n```"}
      </Streamdown>,
    );

    expect(html).toContain("data-markdown-code-block");
    expect(html).toContain("first line\nsecond line");
  });

  it("keeps shell execution exclusive to chat code blocks", () => {
    const preview = renderToStaticMarkup(
      <MarkdownCode className="language-bash" data-block="true" variant="preview">
        echo hello
      </MarkdownCode>,
    );
    const chat = renderToStaticMarkup(
      <MarkdownCode className="language-bash" data-block="true" onRun={() => true}>
        echo hello
      </MarkdownCode>,
    );

    expect(preview).not.toContain("Run in active terminal");
    expect(chat).toContain("Run in active terminal");
  });
});
