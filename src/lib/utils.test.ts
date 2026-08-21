/**
 * 本文件测试通用路径识别辅助函数。
 * 重点锁定 Markdown 扩展名的大小写和末尾边界。
 */

import { describe, expect, it } from "vitest";
import { isMarkdownPath } from "./utils";

describe("isMarkdownPath", () => {
  it("大小写不敏感地识别 Markdown 扩展名", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("notes.markdown")).toBe(true);
    expect(isMarkdownPath("doc.mdx")).toBe(true);
    expect(isMarkdownPath("a/b/c.Md")).toBe(true);
  });

  it("只匹配路径末尾的扩展名", () => {
    expect(isMarkdownPath("file.md.txt")).toBe(false);
    expect(isMarkdownPath("x.mdxx")).toBe(false);
  });

  it("拒绝非 Markdown 和无扩展名路径", () => {
    expect(isMarkdownPath("file.txt")).toBe(false);
    expect(isMarkdownPath("mdfile")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});
