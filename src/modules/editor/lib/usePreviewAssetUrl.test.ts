import { describe, expect, it } from "vitest";
import { previewMediaKind } from "./usePreviewAssetUrl";

describe("previewMediaKind", () => {
  it.each([
    ["photo.PNG", "image"],
    ["diagram.svg", "image"],
    ["clip.webm", "video"],
    ["recording.m4a", "audio"],
    ["manual.pdf", "pdf"],
    ["source.ts", null],
    ["README.md", null],
  ] as const)("routes %s to %s", (path, expected) => {
    expect(previewMediaKind(path)).toBe(expected);
  });
});
