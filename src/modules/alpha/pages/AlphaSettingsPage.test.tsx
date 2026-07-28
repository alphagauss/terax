/**
 * 本文件测试 Alpha Workbench 设置页的状态探测生命周期。
 * 重点锁定页面仅在可见时轮询，并在重新显示后立即刷新。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const mocks = vi.hoisted(() => ({
  getAlphaStatus: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("@/modules/alpha/native", () => ({
  checkAlphaPython: vi.fn(),
  getAlphaStatus: mocks.getAlphaStatus,
  restartAlpha: vi.fn(),
  setAlphaAutoStart: vi.fn(),
  setAlphaPythonPath: vi.fn(),
  startAlpha: vi.fn(),
  stopAlpha: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mocks.translate,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { AlphaSettingsPage } from "@/modules/alpha/pages/AlphaSettingsPage";

describe("AlphaSettingsPage", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.getAlphaStatus.mockReset();
    mocks.getAlphaStatus.mockResolvedValue({
      running: false,
      configured: false,
      pythonPath: null,
      autoStart: true,
      port: 8765,
      archiveHash: "archive",
      serviceArchiveHash: null,
      issue: null,
    });
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
  });

  it("仅在页面可见时刷新和轮询状态", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: false }));
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(3);

    act(() => root.unmount());
  });
});
