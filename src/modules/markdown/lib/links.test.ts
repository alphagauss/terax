/**
 * 本文件测试 Markdown 预览链接策略。
 *
 * 只有当前文档片段和明确允许的外部协议可以执行导航。
 */

import {
  classifyMarkdownLink,
  isMarkdownExternalOpenGesture,
} from "@/modules/markdown/lib/links";
import { describe, expect, it } from "vitest";

describe("classifyMarkdownLink", () => {
  it("allows fragments and approved external schemes", () => {
    expect(classifyMarkdownLink("#install")).toEqual({
      kind: "fragment",
      fragment: "install",
    });
    expect(classifyMarkdownLink("HTTPS://example.com")).toEqual({
      kind: "external",
      url: "HTTPS://example.com",
    });
    expect(classifyMarkdownLink("mailto:user@example.com")).toEqual({
      kind: "external",
      url: "mailto:user@example.com",
    });
  });

  it("blocks privileged and unresolved relative destinations", () => {
    for (const href of [
      undefined,
      "javascript:alert(1)",
      "file:///tmp/a",
      "docs/guide.md",
    ]) {
      expect(classifyMarkdownLink(href)).toEqual({ kind: "blocked" });
    }
  });
});

describe("isMarkdownExternalOpenGesture", () => {
  it("requires Ctrl or Cmd with the primary mouse button", () => {
    expect(
      isMarkdownExternalOpenGesture({
        button: 0,
        ctrlKey: true,
        metaKey: false,
      }),
    ).toBe(true);
    expect(
      isMarkdownExternalOpenGesture({
        button: 0,
        ctrlKey: false,
        metaKey: true,
      }),
    ).toBe(true);
    expect(
      isMarkdownExternalOpenGesture({
        button: 0,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBe(false);
    expect(
      isMarkdownExternalOpenGesture({
        button: 1,
        ctrlKey: true,
        metaKey: false,
      }),
    ).toBe(false);
  });
});
