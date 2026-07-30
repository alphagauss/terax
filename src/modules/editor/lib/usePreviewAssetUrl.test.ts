/**
 * 本文件测试媒体预览类型识别。
 *
 * 确保编辑器只加载明确支持的媒体扩展。
 */

import { describe, expect, it } from "vitest";
import { previewMediaKind } from "./usePreviewAssetUrl";

describe("previewMediaKind", () => {
  it.each([
    ["photo.PNG", "image"],
    ["diagram.svg", "image"],
    ["photo.avif", "image"],
    ["clip.webm", "video"],
    ["recording.m4a", "audio"],
    ["manual.pdf", "pdf"],
    ["source.ts", null],
    ["README.md", null],
  ] as const)("routes %s to %s", (path, expected) => {
    expect(previewMediaKind(path)).toBe(expected);
  });
});
