/**
 * 本文件测试自绘窗口控制按钮与原生窗口状态的同步。
 * 重点锁定全屏时显示还原操作，并通过统一命令退出全屏。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "@/components/WindowControls";

const nativeCore = vi.hoisted(() => ({
  invoke: vi.fn<() => Promise<void>>(),
}));

const nativeWindow = vi.hoisted(() => ({
  isMaximized: vi.fn<() => Promise<boolean>>(),
  isFullscreen: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<(listener: () => void) => Promise<() => void>>(),
  resizeListener: undefined as (() => void) | undefined,
  toggleMaximize: vi.fn<() => Promise<void>>(),
  minimize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/platform", () => ({ USE_CUSTOM_WINDOW_CONTROLS: true }));
vi.mock("@tauri-apps/api/core", () => nativeCore);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => nativeWindow,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("WindowControls", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    nativeWindow.resizeListener = undefined;
    vi.clearAllMocks();
  });

  async function renderControls({
    maximized,
    fullscreen,
  }: {
    maximized: boolean;
    fullscreen: boolean;
  }) {
    nativeWindow.isMaximized.mockResolvedValue(maximized);
    nativeWindow.isFullscreen.mockResolvedValue(fullscreen);
    nativeWindow.onResized.mockImplementation(async (listener) => {
      nativeWindow.resizeListener = listener;
      return () => {};
    });
    nativeWindow.toggleMaximize.mockResolvedValue();
    nativeCore.invoke.mockResolvedValue();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<WindowControls />));
  }

  it("exits fullscreen from the restore button", async () => {
    await renderControls({ maximized: false, fullscreen: true });

    const restore = container?.querySelector<HTMLButtonElement>(
      '[aria-label="windowControls.restore"]',
    );
    await act(async () => restore?.click());

    expect(nativeCore.invoke).toHaveBeenCalledWith("set_fullscreen", {
      fullscreen: false,
    });
    expect(nativeWindow.toggleMaximize).not.toHaveBeenCalled();
  });

  it("maximizes a restored window", async () => {
    await renderControls({ maximized: false, fullscreen: false });

    const maximize = container?.querySelector<HTMLButtonElement>(
      '[aria-label="windowControls.maximize"]',
    );
    await act(async () => maximize?.click());

    expect(nativeWindow.toggleMaximize).toHaveBeenCalledOnce();
    expect(nativeCore.invoke).not.toHaveBeenCalled();
  });

  it("releases pointer focus without hiding keyboard focus", async () => {
    await renderControls({ maximized: false, fullscreen: false });
    const maximize = container?.querySelector<HTMLButtonElement>(
      '[aria-label="windowControls.maximize"]',
    );
    if (!maximize) throw new Error("maximize button is unavailable");

    maximize.focus();
    maximize.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    expect(document.activeElement).not.toBe(maximize);

    maximize.focus();
    maximize.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.activeElement).toBe(maximize);
  });

  it("ignores an older resize query that resolves last", async () => {
    await renderControls({ maximized: false, fullscreen: false });
    let resolveOlder: ((value: boolean) => void) | undefined;
    nativeWindow.isFullscreen
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(true);

    nativeWindow.resizeListener?.();
    nativeWindow.resizeListener?.();
    await act(async () => {});

    expect(
      container?.querySelector('[aria-label="windowControls.restore"]'),
    ).not.toBeNull();

    await act(async () => resolveOlder?.(false));
    expect(
      container?.querySelector('[aria-label="windowControls.restore"]'),
    ).not.toBeNull();
  });
});
