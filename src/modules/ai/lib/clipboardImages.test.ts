/**
 * 本文件测试 Agent 输入框的剪贴板图片提取。
 *
 * 锁定图片筛选和 files 优先规则，避免一次粘贴生成重复附件。
 */

import { clipboardImageFiles } from "@/modules/ai/lib/clipboardImages";
import { describe, expect, it, vi } from "vitest";

describe("clipboardImageFiles", () => {
  it("keeps only image files from the primary file list", () => {
    const image = { type: "image/png" } as File;
    const text = { type: "text/plain" } as File;
    const data = {
      files: [image, text],
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: vi.fn(() => image),
        },
      ],
    } as unknown as DataTransfer;

    expect(clipboardImageFiles(data)).toEqual([image]);
    expect(data.items[0]?.getAsFile).not.toHaveBeenCalled();
  });

  it("falls back to image items when files is empty", () => {
    const image = { type: "image/webp" } as File;
    const data = {
      files: [],
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/webp", getAsFile: () => image },
      ],
    } as unknown as DataTransfer;

    expect(clipboardImageFiles(data)).toEqual([image]);
  });
});
