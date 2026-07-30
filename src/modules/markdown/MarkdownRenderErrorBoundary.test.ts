/**
 * 本文件测试 Markdown 渲染错误边界的恢复状态。
 *
 * 同一份坏内容保持降级，新内容到达后必须允许重新渲染。
 */

import { MarkdownRenderErrorBoundary } from "@/modules/markdown/MarkdownRenderErrorBoundary";
import { describe, expect, it } from "vitest";

describe("MarkdownRenderErrorBoundary", () => {
  it("recovers only when document content changes", () => {
    const state = { content: "broken", failed: true };

    expect(
      MarkdownRenderErrorBoundary.getDerivedStateFromProps(
        { content: "broken", fallback: null, children: null },
        state,
      ),
    ).toBeNull();
    expect(
      MarkdownRenderErrorBoundary.getDerivedStateFromProps(
        { content: "fixed", fallback: null, children: null },
        state,
      ),
    ).toEqual({ content: "fixed", failed: false });
  });
});
