import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  read: vi.fn().mockResolvedValue([]),
  kind: "local",
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/modules/file-actions/clipboard", () => ({
  readClipboardFiles: files.read,
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: files.kind }),
}));
vi.mock("sonner", () => ({ toast: { info: files.info } }));
vi.mock("@/lib/errors", () => ({ reportError: files.error }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
const native = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(t: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => native);

vi.mock("@/lib/platform", () => ({
  get IS_LINUX() {
    return /Linux/.test(navigator.userAgent);
  },
  get IS_WINDOWS() {
    return /Windows/.test(navigator.userAgent);
  },
}));

const web = {
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(t: string) => Promise<void>>(),
};

const original = globalThis.navigator;
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

function platform(userAgent: string) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent, clipboard: web },
  });
}

async function load() {
  vi.resetModules();
  return import("./terminalClipboard");
}

describe("terminalClipboard", () => {
  beforeEach(() => {
    files.kind = "local";
    files.read.mockReset().mockResolvedValue([]);
    files.info.mockClear();
    files.error.mockClear();
    native.readText.mockReset();
    native.writeText.mockReset();
    web.readText.mockReset();
    web.writeText.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: original,
    });
  });

  it("reads the native clipboard first on Linux", async () => {
    platform(LINUX);
    native.readText.mockResolvedValue("native");
    web.readText.mockResolvedValue("web");
    const { readTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("native");
    expect(web.readText).not.toHaveBeenCalled();
  });

  it("falls back to the web clipboard when the native read fails", async () => {
    platform(LINUX);
    native.readText.mockRejectedValue(new Error("no ipc"));
    web.readText.mockResolvedValue("web");
    const { readTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("web");
  });

  it("keeps the web clipboard on macOS", async () => {
    platform(MAC);
    web.readText.mockResolvedValue("web");
    const { readTerminalClipboard, writeTerminalClipboard } = await load();
    await expect(readTerminalClipboard()).resolves.toBe("web");
    await writeTerminalClipboard("x");
    expect(native.readText).not.toHaveBeenCalled();
    expect(native.writeText).not.toHaveBeenCalled();
    expect(web.writeText).toHaveBeenCalledWith("x");
  });

  it.each(["local", "wsl", "ssh"])(
    "文件路径优先，远端拒绝且不能降级为文本：%s",
    async (kind) => {
      platform(LINUX);
      files.kind = kind;
      files.read.mockResolvedValue(["/tmp/a b.png", "/tmp/code.ts"]);
      web.readText.mockResolvedValue("must not paste");
      const { readTerminalClipboard } = await load();
      expect(await readTerminalClipboard()).toBe(
        kind === "local" ? "'/tmp/a b.png' /tmp/code.ts " : "",
      );
      expect(web.readText).not.toHaveBeenCalled();
      expect(native.readText).not.toHaveBeenCalled();
      if (kind !== "local")
        expect(files.info).toHaveBeenCalledWith(
          "common:fileActions.remoteFileInputRejected",
        );
    },
  );

  it("纯内存图片无路径也无文本，终端不生成文件；读取错误不得降级", async () => {
    platform(MAC);
    web.readText.mockResolvedValue("");
    const { readTerminalClipboard } = await load();
    expect(await readTerminalClipboard()).toBe("");
    files.read.mockRejectedValueOnce(new Error("occupied"));
    web.readText.mockClear().mockResolvedValue("must not paste");
    expect(await readTerminalClipboard()).toBe("");
    expect(web.readText).not.toHaveBeenCalled();
    expect(files.error).toHaveBeenCalledWith(
      "common:fileActions.clipboardReadFailed",
      { error: expect.objectContaining({ message: "occupied" }) },
    );
  });

  it.each([LINUX, "Windows"])("writes natively on %s", async (userAgent) => {
    platform(userAgent);
    native.writeText.mockResolvedValue();
    const { writeTerminalClipboard } = await load();
    await writeTerminalClipboard("copied");
    expect(native.writeText).toHaveBeenCalledWith("copied");
    expect(web.writeText).not.toHaveBeenCalled();
  });
});
