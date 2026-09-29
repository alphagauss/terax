// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ writeText: vi.fn(), writeHtml: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => native);

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/platform");
});

async function setup(platform: string) {
  vi.resetModules();
  vi.doMock("@/lib/platform", () => ({
    IS_WINDOWS: platform === "windows",
    IS_LINUX: platform === "linux",
  }));
  const web = { writeText: vi.fn(), write: vi.fn() };
  vi.stubGlobal("navigator", { clipboard: web });
  return { web, ...(await import("@/lib/clipboard")) };
}

describe("项目剪贴板写入", () => {
  it.each(["windows", "linux"])(
    "%s 保留原生文本和 HTML 双格式，不因失败回退网页",
    async (platform) => {
      const { web, writeClipboardText, writeClipboardHtml } =
        await setup(platform);
      await writeClipboardText("文本");
      await writeClipboardHtml("<b>文本</b>", "文本");
      expect(native.writeText).toHaveBeenCalledWith("文本");
      expect(native.writeHtml).toHaveBeenCalledWith("<b>文本</b>", "文本");
      native.writeText.mockRejectedValueOnce(new Error("busy"));
      native.writeHtml.mockRejectedValueOnce(new Error("busy"));
      await expect(writeClipboardText("文本")).rejects.toThrow("busy");
      await expect(writeClipboardHtml("<b>文本</b>", "文本")).rejects.toThrow(
        "busy",
      );
      expect(web.writeText).not.toHaveBeenCalled();
      expect(web.write).not.toHaveBeenCalled();
    },
  );

  it.each(["macos", "unknown"])(
    "%s 保留网页复制及 HTML 内容",
    async (platform) => {
      const { web, writeClipboardText, writeClipboardHtml } =
        await setup(platform);
      vi.stubGlobal(
        "ClipboardItem",
        class {
          constructor(readonly data: Record<string, Blob>) {}
        },
      );
      await writeClipboardText("文本");
      await writeClipboardHtml("<b>文本</b>", "文本");
      expect(web.writeText).toHaveBeenCalledWith("文本");
      const item = web.write.mock.calls[0][0][0];
      expect(await item.data["text/html"].text()).toBe("<b>文本</b>");
      expect(await item.data["text/plain"].text()).toBe("文本");
      expect(native.writeText).not.toHaveBeenCalled();
      expect(native.writeHtml).not.toHaveBeenCalled();
    },
  );
});
