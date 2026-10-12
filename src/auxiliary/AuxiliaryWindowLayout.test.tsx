/**
 * 本文件锁定 macOS 辅助窗口首次显示与原生标题栏同步的顺序。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: "light" as "light" | "dark" | "system",
  invoke: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
  setTitle: vi.fn(),
}));

vi.mock("@/components/ToastDismissOnClick", () => ({
  ToastDismissOnClick: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/WindowControls", () => ({
  WindowControls: () => null,
}));
vi.mock("@/lib/platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
  IS_LINUX: false,
  USE_CUSTOM_WINDOW_CONTROLS: false,
}));
vi.mock("@/modules/theme", () => ({
  useTheme: () => ({ mode: mocks.mode }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) =>
    command === "show_auxiliary_window"
      ? mocks.show()
      : mocks.invoke(command, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: mocks.show,
    setFocus: mocks.setFocus,
    setTitle: mocks.setTitle,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/auxiliary/AuxiliaryWindowContext", () => ({
  useAuxiliaryWindowCapabilities: () => ({
    minimizable: false,
    maximizable: false,
  }),
}));

import { AuxiliaryWindowLayout } from "@/auxiliary/AuxiliaryWindowLayout";

describe("macOS 辅助窗口标题栏", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  const frames: FrameRequestCallback[] = [];

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("--card");
    document.documentElement.style.removeProperty(
      "--appearance-test-unrelated",
    );
    mocks.mode = "light";
    frames.length = 0;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("隐藏窗口不执行动画帧也能先同步外观再显示，并持续更新主题", async () => {
    let sampledColor = 24;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      getImageData: () => ({
        data: new Uint8ClampedArray([
          sampledColor,
          sampledColor,
          sampledColor,
          255,
        ]),
      }),
    } as unknown as CanvasRenderingContext2D);
    let finishFirstSync: (() => void) | undefined;
    let finishShow: (() => void) | undefined;
    mocks.invoke
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    mocks.show.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishShow = resolve;
        }),
    );
    mocks.setFocus.mockResolvedValue(undefined);
    mocks.setTitle.mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AuxiliaryWindowLayout title="Settings">
          <div />
        </AuxiliaryWindowLayout>,
      );
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_auxiliary_window_appearance",
      {
        mode: "light",
        background: [24, 24, 24],
      },
    );
    expect(mocks.show).not.toHaveBeenCalled();

    await act(async () => finishFirstSync?.());
    expect(mocks.show).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.mode = "dark";
      document.documentElement.classList.add("dark");
      root?.render(
        <AuxiliaryWindowLayout title="Settings">
          <div />
        </AuxiliaryWindowLayout>,
      );
    });
    await act(async () => frames.shift()?.(0));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    await act(async () => finishShow?.());
    await act(async () => frames.shift()?.(0));
    expect(mocks.setFocus).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_auxiliary_window_appearance",
      { mode: "dark", background: [24, 24, 24] },
    );

    await act(async () => {
      sampledColor = 32;
      document.documentElement.style.setProperty("--card", "#202020");
    });
    await act(async () => frames.shift()?.(0));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_auxiliary_window_appearance",
      { mode: "dark", background: [32, 32, 32] },
    );

    await act(async () => {
      mocks.mode = "system";
      root?.render(
        <AuxiliaryWindowLayout title="Settings">
          <div />
        </AuxiliaryWindowLayout>,
      );
    });
    await act(async () => frames.shift()?.(0));
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_auxiliary_window_appearance",
      { mode: "system", background: [32, 32, 32] },
    );

    await act(async () => {
      sampledColor = 248;
      document.documentElement.classList.remove("dark");
    });
    await act(async () => frames.shift()?.(0));
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_auxiliary_window_appearance",
      { mode: "system", background: [248, 248, 248] },
    );

    await act(async () => {
      document.documentElement.style.setProperty(
        "--appearance-test-unrelated",
        "1",
      );
    });
    await act(async () => frames.shift()?.(0));
    expect(mocks.invoke).toHaveBeenCalledTimes(5);
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });
});
