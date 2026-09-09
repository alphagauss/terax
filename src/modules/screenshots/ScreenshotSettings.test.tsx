// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sharedChanged: null as (() => Promise<void>) | null,
  status: {
    globalShortcutOwner: false,
    config: { globalShortcutEnabled: false, shortcut: "Control+Shift+X" },
    registered: false,
    error: null,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@/lib/sharedStore", () => ({
  onSharedStoreChange: vi.fn(
    async (_store: string, changed: () => Promise<void>) => {
      mocks.sharedChanged = changed;
      return vi.fn();
    },
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { ScreenshotSettings } from "@/modules/screenshots/ScreenshotSettings";
import { ScreenshotShortcutSettings } from "@/modules/screenshots/ScreenshotShortcutSettings";

function ShortcutSettingsHarness() {
  const [recording, setRecording] = useState(false);
  return (
    <ScreenshotShortcutSettings
      isRecording={recording}
      onStartRecording={() => setRecording(true)}
      onStopRecording={() => setRecording(false)}
    />
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("常规页面独立启动截图，快捷键页面同步和精确修改共享设置", async () => {
  vi.useFakeTimers();
  mocks.invoke.mockImplementation(
    async (command: string, args?: { patch: object }) => {
      if (command === "screenshot_status") return structuredClone(mocks.status);
      if (command === "screenshot_configure")
        Object.assign(mocks.status.config, args?.patch);
      return null;
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScreenshotSettings />));
    const capture = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "capture",
    );
    expect(capture).toBeDefined();
    expect(capture?.disabled).toBe(false);
    expect(container.querySelector("[role=switch]")).toBeNull();
    await act(async () => {
      capture?.click();
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_start");
    expect(mocks.invoke).not.toHaveBeenCalledWith("screenshot_status");

    await act(async () => root.render(<ShortcutSettingsHarness />));

    mocks.status.config.shortcut = "Control+Alt+S";
    await act(async () => {
      await mocks.sharedChanged?.();
    });
    expect(container.querySelector("input")).toBeNull();
    expect(
      [...container.querySelectorAll("kbd")].slice(-1)[0]?.textContent,
    ).toBe("S");

    // 跨进程通知可能交错返回，较旧的读取不能覆盖新配置。
    const staleStatus = structuredClone(mocks.status);
    let resolveStale: (value: typeof staleStatus) => void = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const staleRefresh = mocks.sharedChanged?.();
    mocks.status.config.shortcut = "Control+Alt+K";
    await act(async () => {
      await mocks.sharedChanged?.();
    });
    await act(async () => {
      resolveStale(staleStatus);
      await staleRefresh;
    });
    expect(
      [...container.querySelectorAll("kbd")].slice(-1)[0]?.textContent,
    ).toBe("K");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[role=switch]")?.click(),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_configure", {
      patch: { globalShortcutEnabled: true },
    });
    expect(mocks.status.config.shortcut).toBe("Control+Alt+K");
    expect(container.textContent).not.toContain("manualHint");

    const record = () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="recordShortcut"]')
        ?.click();
    await act(async () => record());
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Control",
          code: "ControlLeft",
          ctrlKey: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "+",
          code: "Equal",
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_configure", {
      patch: { shortcut: "Control+Shift+Equal" },
    });
    expect(
      [...container.querySelectorAll("kbd")].slice(-1)[0]?.textContent,
    ).toBe("=");

    const updates = () =>
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "screenshot_configure",
      ).length;
    const beforeCancel = updates();
    await act(async () => record());
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape" }),
      ),
    );
    expect(updates()).toBe(beforeCancel);
    expect(
      container.querySelector('[aria-label="recordShortcut"]'),
    ).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
