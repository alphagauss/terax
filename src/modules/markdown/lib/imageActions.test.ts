/**
 * 本文件测试 Markdown 图片复制与另存为动作。
 *
 * 锁定剪贴板只编码当前图片一次，并确保另存为复用既有资源 token。
 */

// @vitest-environment happy-dom

import {
  copyMarkdownImage,
  saveMarkdownImage,
} from "@/modules/markdown/lib/imageActions";
import type { PreparedMarkdownImage } from "@/modules/markdown/lib/imageResources";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  closeImage: vi.fn(),
  createImage: vi.fn(),
  invoke: vi.fn(),
  writeClipboard: vi.fn(),
  writeImage: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/image", () => ({
  Image: { new: native.createImage },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeImage: native.writeImage,
}));

const resource: PreparedMarkdownImage = {
  token: "image-token",
  path: "C:\\Temp\\image.png",
};

beforeEach(() => {
  native.closeImage.mockReset().mockResolvedValue(undefined);
  native.createImage.mockReset().mockResolvedValue({
    close: native.closeImage,
  });
  native.invoke.mockReset();
  native.writeClipboard.mockReset().mockResolvedValue(undefined);
  native.writeImage.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Terax test",
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write: native.writeClipboard },
  });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly items: Record<string, Blob>) {}
    },
  );
});

describe("copyMarkdownImage", () => {
  it("encodes the decoded image once and writes PNG bytes", async () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) =>
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
    } as unknown as HTMLCanvasElement;
    const createElement = vi
      .spyOn(document, "createElement")
      .mockReturnValueOnce(canvas);
    const image = {
      complete: true,
      naturalWidth: 2,
      naturalHeight: 1,
    } as HTMLImageElement;

    await copyMarkdownImage(image);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
    expect(native.writeClipboard).toHaveBeenCalledOnce();
    expect(native.writeImage).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    createElement.mockRestore();
  });

  it("writes an explicit RGBA image resource on Linux", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Terax Linux",
    });
    const rgba = new Uint8ClampedArray([255, 0, 0, 255]);
    const drawImage = vi.fn();
    const toBlob = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage,
        getImageData: () => ({ data: rgba }),
      }),
      toBlob,
    } as unknown as HTMLCanvasElement;
    const createElement = vi
      .spyOn(document, "createElement")
      .mockReturnValueOnce(canvas);
    const image = {
      complete: true,
      naturalWidth: 1,
      naturalHeight: 1,
    } as HTMLImageElement;

    await copyMarkdownImage(image);

    expect(native.createImage).toHaveBeenCalledWith(
      new Uint8Array([255, 0, 0, 255]),
      1,
      1,
    );
    expect(native.writeImage).toHaveBeenCalledWith(
      expect.objectContaining({ close: native.closeImage }),
    );
    expect(native.closeImage).toHaveBeenCalledOnce();
    expect(native.writeClipboard).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();
    createElement.mockRestore();
  });
});

describe("saveMarkdownImage", () => {
  it("delegates path selection and saving to one native command", async () => {
    native.invoke.mockResolvedValue(true);

    await expect(
      saveMarkdownImage(resource, {
        title: "图片另存为",
        imageFilter: "图片",
      }),
    ).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledWith("markdown_image_save_as", {
      token: "image-token",
      title: "图片另存为",
      imageFilter: "图片",
    });
  });

  it("returns false when the native save dialog is cancelled", async () => {
    native.invoke.mockResolvedValue(false);
    await expect(
      saveMarkdownImage(resource, {
        title: "图片另存为",
        imageFilter: "图片",
      }),
    ).resolves.toBe(false);
  });
});
