/**
 * 本文件验证 AI 推理与工具详情的默认折叠和按需渲染行为。
 * 测试锁定完成态关闭时不生成详情 DOM、显式展开时才挂载内容的不变量。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./reasoning";
import { Tool } from "./tool";

describe("AI collapsible details", () => {
  it("does not render completed reasoning content while closed", () => {
    const closed = renderToStaticMarkup(
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>private-reasoning-detail</ReasoningContent>
      </Reasoning>,
    );
    const open = renderToStaticMarkup(
      <Reasoning defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>private-reasoning-detail</ReasoningContent>
      </Reasoning>,
    );

    expect(closed).not.toContain("private-reasoning-detail");
    expect(open).toContain("private-reasoning-detail");
    expect(open).toContain("terax-collapsible-content");
  });

  it("keeps completed tool output unmounted until explicitly opened", () => {
    const props = {
      toolName: "list_directory",
      state: "output-available" as const,
      input: { path: "/workspace" },
      output: {
        entries: [{ name: "lazy-detail.txt", kind: "file" }],
      },
    };

    const closed = renderToStaticMarkup(<Tool {...props} />);
    const open = renderToStaticMarkup(<Tool {...props} defaultOpen />);

    expect(closed).toContain("List");
    expect(closed).not.toContain("lazy-detail.txt");
    expect(open).toContain("lazy-detail.txt");
  });

  it("keeps error details folded by default", () => {
    const closed = renderToStaticMarkup(
      <Tool
        toolName="bash_run"
        state="output-error"
        errorText="private-error-detail"
      />,
    );

    expect(closed).toContain("failed");
    expect(closed).not.toContain("private-error-detail");
  });
});
