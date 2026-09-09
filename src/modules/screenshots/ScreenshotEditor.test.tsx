// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as (() => void) | null,
  editor: null as Record<string, unknown> | null,
  frame: { token: "first", width: 200, height: 100, language: "en" },
  active: true,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/screenshots/appearance", () => ({
  applyScreenshotTheme: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, callback: () => void) => {
    mocks.listener = callback;
    return vi.fn();
  }),
}));
vi.mock("react-screenshots", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.editor = props;
    return <div data-editor="true" />;
  },
}));
vi.mock("@/components/controls/tooltip", () => ({
  TooltipProvider: ({ children }: ComponentProps<"div">) => children,
  Hint: ({ children }: ComponentProps<"div">) => children,
}));

import { ScreenshotEditor } from "@/modules/screenshots/ScreenshotEditor";

let root: Root;
let container: HTMLDivElement;
let revoke: ReturnType<typeof vi.fn>;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("截图编辑器会话", () => {
  beforeEach(() => {
    mocks.active = true;
    mocks.frame.token = "first";
    mocks.editor = null;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "screenshot_frame")
        return mocks.active ? { ...mocks.frame } : null;
      if (command === "screenshot_image") return new ArrayBuffer(8);
      return null;
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal("innerWidth", 1920);
    vi.stubGlobal("innerHeight", 1080);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("重复事件只读取一次图片，结束会话释放图片并卸载编辑器", async () => {
    await act(async () => root.render(<ScreenshotEditor />));
    await flush();
    mocks.listener?.();
    mocks.listener?.();
    await flush();
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "screenshot_image",
      ),
    ).toHaveLength(1);
    expect(container.querySelector("[data-editor]")).not.toBeNull();
    mocks.active = false;
    mocks.listener?.();
    await flush();
    expect(revoke).toHaveBeenCalledWith("blob:test");
    expect(container.querySelector("[data-editor]")).toBeNull();
  });

  it("保存取消或失败时保留编辑器，重复导出和取消不能越过进行中的保存", async () => {
    await act(async () => root.render(<ScreenshotEditor />));
    await flush();
    let resolveExport: (value: boolean) => void = () => {};
    const exporting = new Promise<boolean>((resolve) => {
      resolveExport = resolve;
    });
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "screenshot_export" ? exporting : null,
    );
    const save = mocks.editor?.onSave as (blob: Blob) => void;
    const cancel = mocks.editor?.onCancel as () => void;
    const blob = new Blob(["image"]);
    await act(async () => {
      save(blob);
      save(blob);
      cancel();
    });
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "screenshot_export",
      ),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "screenshot_cancel",
      ),
    ).toHaveLength(0);
    await act(async () => resolveExport(false));
    expect(container.querySelector("[data-editor]")).not.toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    mocks.invoke.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await act(async () => save(blob));
    await flush();
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.querySelector("[data-editor]")).not.toBeNull();
  });
});
