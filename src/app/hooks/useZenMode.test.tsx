/**
 * 本文件测试禅模式与原生全屏状态的协调。
 * 重点锁定重复切换、原全屏恢复、焦点转移和失败路径的状态收敛。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useZenMode } from "./useZenMode";

const nativeWindow = vi.hoisted(() => ({
  isFullscreen: vi.fn<() => Promise<boolean>>(),
  onResized:
    vi.fn<(listener: () => void | Promise<void>) => Promise<() => void>>(),
  resizeListener: undefined as (() => void | Promise<void>) | undefined,
}));

const nativeCore = vi.hoisted(() => ({
  invoke:
    vi.fn<(command: string, args: { fullscreen: boolean }) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => nativeCore);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => nativeWindow,
}));

type Controls = ReturnType<typeof useZenMode>;

/** 向测试暴露 Hook 返回的状态与切换入口。 */
function Harness({
  onReady,
  onFullscreenError,
  focusWorkbench,
}: {
  onReady: (controls: Controls) => void;
  onFullscreenError: (error: unknown) => void;
  focusWorkbench: () => void;
}) {
  onReady(useZenMode({ onFullscreenError, focusWorkbench }));
  return null;
}

describe("useZenMode", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    nativeWindow.resizeListener = undefined;
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  async function renderHarness({
    onFullscreenError = vi.fn(),
    focusWorkbench = vi.fn(),
    resizeRegistrationError,
  }: {
    onFullscreenError?: (error: unknown) => void;
    focusWorkbench?: () => void;
    resizeRegistrationError?: unknown;
  } = {}) {
    nativeCore.invoke.mockResolvedValue();
    if (resizeRegistrationError) {
      nativeWindow.onResized.mockRejectedValue(resizeRegistrationError);
    } else {
      nativeWindow.onResized.mockImplementation(async (listener) => {
        nativeWindow.resizeListener = listener;
        return () => {};
      });
    }
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    let controls: Controls | undefined;
    await act(async () => {
      root.render(
        createElement(Harness, {
          onReady: (next) => {
            controls = next;
          },
          onFullscreenError,
          focusWorkbench,
        }),
      );
    });
    return () => {
      if (!controls) throw new Error("zen mode controls are unavailable");
      return controls;
    };
  }

  async function flushAnimationFrame() {
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
  }

  it("enters fullscreen and restores a window that was not fullscreen", async () => {
    nativeWindow.isFullscreen.mockResolvedValue(false);
    const controls = await renderHarness();

    await act(async () => controls().toggle());
    expect(controls().enabled).toBe(true);
    expect(nativeCore.invoke).toHaveBeenLastCalledWith("set_fullscreen", {
      fullscreen: true,
    });

    await act(async () => controls().toggle());
    expect(controls().enabled).toBe(false);
    expect(nativeCore.invoke.mock.calls).toEqual([
      ["set_fullscreen", { fullscreen: true }],
      ["set_fullscreen", { fullscreen: false }],
    ]);
  });

  it("keeps an originally fullscreen window fullscreen after exit", async () => {
    nativeWindow.isFullscreen.mockResolvedValue(true);
    const controls = await renderHarness();

    await act(async () => controls().toggle());
    await act(async () => controls().toggle());

    expect(controls().enabled).toBe(false);
    expect(nativeCore.invoke).not.toHaveBeenCalled();
  });

  it("serializes rapid toggles and settles on the latest request", async () => {
    let resolveFullscreen: ((fullscreen: boolean) => void) | undefined;
    nativeWindow.isFullscreen.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFullscreen = resolve;
        }),
    );
    const controls = await renderHarness();

    act(() => {
      controls().toggle();
      controls().toggle();
    });
    await act(async () => resolveFullscreen?.(false));

    expect(controls().enabled).toBe(false);
    expect(nativeCore.invoke.mock.calls).toEqual([
      ["set_fullscreen", { fullscreen: true }],
      ["set_fullscreen", { fullscreen: false }],
    ]);
  });

  it("exits zen mode when the system leaves fullscreen", async () => {
    nativeWindow.isFullscreen
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const controls = await renderHarness();

    await act(async () => controls().toggle());
    await act(async () => nativeWindow.resizeListener?.());

    expect(controls().enabled).toBe(false);
    expect(nativeCore.invoke.mock.calls).toEqual([
      ["set_fullscreen", { fullscreen: true }],
    ]);
  });

  it("keeps focus in the workbench after hiding focused chrome", async () => {
    nativeWindow.isFullscreen.mockResolvedValue(true);
    const sidebar = document.createElement("div");
    sidebar.dataset.sidebarDropZone = "primary";
    const button = document.createElement("button");
    sidebar.append(button);
    document.body.append(sidebar);
    const workbench = document.createElement("button");
    document.body.append(workbench);
    button.focus();
    const focusWorkbench = vi.fn(() => workbench.focus());
    const controls = await renderHarness({ focusWorkbench });

    await act(async () => controls().toggle());
    await flushAnimationFrame();
    expect(focusWorkbench).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(workbench);

    await act(async () => controls().toggle());
    await flushAnimationFrame();
    expect(focusWorkbench).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(workbench);
  });

  it("reports resize listener registration failures", async () => {
    const error = new Error("listen failed");
    const onFullscreenError = vi.fn();

    await renderHarness({ onFullscreenError, resizeRegistrationError: error });

    expect(onFullscreenError).toHaveBeenCalledWith(error);
  });

  it("keeps UI zen mode available when entering fullscreen fails", async () => {
    nativeWindow.isFullscreen.mockResolvedValue(false);
    const error = new Error("fullscreen failed");
    const onFullscreenError = vi.fn();
    const controls = await renderHarness({ onFullscreenError });
    nativeCore.invoke.mockRejectedValue(error);

    await act(async () => controls().toggle());

    expect(controls().enabled).toBe(true);
    expect(onFullscreenError).toHaveBeenCalledWith(error);
  });
});
