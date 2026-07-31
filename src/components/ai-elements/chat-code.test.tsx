/**
 * 本文件测试 Markdown 代码块的语言识别和上下文行为。
 *
 * 锁定无标签围栏代码内容，以及 Shell 执行仅属于聊天上下文的不变量。
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
    const document = renderToStaticMarkup(
      <MarkdownCode
        className="language-bash"
        data-block="true"
        variant="document"
      >
        echo hello
      </MarkdownCode>,
    );
    const chat = renderToStaticMarkup(
      <MarkdownCode className="language-bash" data-block="true" onRun={() => true}>
        echo hello
      </MarkdownCode>,
    );

    expect(document).not.toContain("Run in active terminal");
    expect(chat).toContain("Run in active terminal");
    expect(document).toContain("data-markdown-code-block");
    expect(chat).toContain("data-markdown-code-block");
  });
});
