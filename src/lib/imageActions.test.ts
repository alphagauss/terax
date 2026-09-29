/**
 * 本文件测试 页面图片复制与另存为动作。
 *
 * 锁定剪贴板只编码当前图片一次，并确保另存为复用既有资源 token。
 */

// @vitest-environment happy-dom

import {
  saveImageAs,
  savePreparedImage,
  writeClipboardImage,
} from "@/lib/imageActions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  linux: false,
  windows: false,
  closeImage: vi.fn(),
  createImage: vi.fn(),
  invoke: vi.fn(),
  writeClipboard: vi.fn(),
  writeImage: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  get IS_LINUX() {
    return native.linux;
  },
  get IS_WINDOWS() {
    return native.windows;
  },
}));
vi.mock("@/lib/clipboard", () => ({
  get USE_NATIVE_CLIPBOARD() {
    return native.linux || native.windows;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/image", () => ({
  Image: { new: native.createImage },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeImage: native.writeImage,
}));

const resource = {
  token: "image-token",
  path: "C:\\Temp\\image.png",
};

beforeEach(() => {
  native.linux = false;
  native.windows = false;
  native.closeImage.mockReset().mockResolvedValue(undefined);
  native.createImage.mockReset().mockResolvedValue({
    close: native.closeImage,
  });
  native.invoke.mockReset();
  native.writeClipboard.mockReset().mockResolvedValue(undefined);
  native.writeImage.mockReset().mockResolvedValue(undefined);
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

describe("writeClipboardImage", () => {
  it("图片来源在异步加载期间变化时，仍复制已经绘制的尺寸与像素", async () => {
    native.windows = true;
    const getImageData = vi.fn(() => ({
      data: new Uint8ClampedArray([255, 0, 0, 255]),
    }));
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn(), getImageData }),
    } as unknown as HTMLCanvasElement;
    const createElement = vi
      .spyOn(document, "createElement")
      .mockReturnValueOnce(canvas);
    const image = { complete: true, naturalWidth: 1, naturalHeight: 1 };
    try {
      const copying = writeClipboardImage(image as HTMLImageElement);
      image.naturalWidth = 0;
      image.naturalHeight = 0;
      await copying;
      expect(getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
      expect(native.createImage).toHaveBeenCalledWith(
        new Uint8Array([255, 0, 0, 255]),
        1,
        1,
      );
    } finally {
      createElement.mockRestore();
    }
  });

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

    await writeClipboardImage(image);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
    expect(native.writeClipboard).toHaveBeenCalledOnce();
    expect(native.writeImage).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    createElement.mockRestore();
  });

  it.each(["linux", "windows"] as const)(
    "writes RGBA and releases resources on %s",
    async (platform) => {
      native[platform] = true;
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

      await writeClipboardImage(image);

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
      native.writeImage.mockRejectedValueOnce(new Error("clipboard busy"));
      createElement.mockReturnValueOnce(canvas);
      await expect(writeClipboardImage(image)).rejects.toThrow(
        "clipboard busy",
      );
      expect(native.closeImage).toHaveBeenCalledTimes(2);
      expect(native.writeClipboard).not.toHaveBeenCalled();
      expect(canvas.width).toBe(0);
      createElement.mockRestore();
    },
  );
});

describe("savePreparedImage", () => {
  it("delegates path selection and saving to one native command", async () => {
    native.invoke.mockResolvedValue(true);

    await expect(
      savePreparedImage(resource, {
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
      savePreparedImage(resource, {
        title: "图片另存为",
        imageFilter: "图片",
      }),
    ).resolves.toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("saveImageAs", () => {
  it.each([true, false, "failed"])(
    "原始字节复用现有保存命令，成功、取消或失败均释放资源：%s",
    async (result) => {
      const bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));
      native.invoke.mockImplementation(async (command: string) => {
        if (command === "markdown_image_prepare")
          return { token: "memory-image" };
        if (command === "markdown_image_save_as") {
          if (result === "failed") throw new Error("save failed");
          return result;
        }
      });
      const save = saveImageAs("blob:original", {
        title: "另存为",
        imageFilter: "图片",
      });
      if (result === "failed")
        await expect(save).rejects.toThrow("save failed");
      else await expect(save).resolves.toBe(result);
      expect(native.invoke).toHaveBeenNthCalledWith(
        1,
        "markdown_image_prepare",
        { source: { kind: "bytes", bytes: [...bytes] } },
      );
      expect(native.invoke).toHaveBeenNthCalledWith(
        2,
        "markdown_image_save_as",
        { token: "memory-image", title: "另存为", imageFilter: "图片" },
      );
      expect(native.invoke).toHaveBeenNthCalledWith(
        3,
        "markdown_image_release",
        { token: "memory-image" },
      );
    },
  );

  it("来源读取失败时不打开另存为或释放不存在的资源", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    await expect(
      saveImageAs("blob:missing", { title: "另存为", imageFilter: "图片" }),
    ).rejects.toThrow("unavailable");
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
