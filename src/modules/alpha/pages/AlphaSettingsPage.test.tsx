/**
 * 本文件测试 Alpha Workbench 设置页的状态探测和数据目录保存流程。
 * 重点锁定可见性轮询以及保存配置后自动重启共享服务。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const mocks = vi.hoisted(() => ({
  getAlphaSettings: vi.fn(),
  getAlphaStatus: vi.fn(),
  open: vi.fn(),
  restartAlpha: vi.fn(),
  translate: (key: string) => key,
  updateAlphaSettings: vi.fn(),
}));

vi.mock("@/modules/alpha/api", () => ({
  getAlphaSettings: mocks.getAlphaSettings,
  updateAlphaSettings: mocks.updateAlphaSettings,
}));

vi.mock("@/modules/alpha/native", () => ({
  checkAlphaPython: vi.fn(),
  getAlphaStatus: mocks.getAlphaStatus,
  restartAlpha: mocks.restartAlpha,
  setAlphaAutoStart: vi.fn(),
  setAlphaPythonPath: vi.fn(),
  startAlpha: vi.fn(),
  stopAlpha: vi.fn(),
}));

vi.mock("@/modules/alpha/preferences", () => ({
  setAlphaShowInRemote: vi.fn(),
  useAlphaShowInRemote: () => false,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
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
    mocks.getAlphaSettings.mockReset();
    mocks.getAlphaSettings.mockResolvedValue({ dataDir: "D:/alpha-data" });
    mocks.open.mockReset();
    mocks.restartAlpha.mockReset();
    mocks.updateAlphaSettings.mockReset();
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
    expect(mocks.getAlphaSettings).toHaveBeenCalledTimes(1);

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
    expect(mocks.getAlphaSettings).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
  });

  it("保存数据目录后不依赖陈旧状态直接重启共享服务", async () => {
    mocks.open.mockResolvedValue("D:/synced-alpha");
    mocks.updateAlphaSettings.mockResolvedValue({
      dataDir: "D:/synced-alpha",
    });
    mocks.restartAlpha.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      archiveHash: "archive",
      serviceArchiveHash: "archive",
      issue: null,
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    const choose = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "storage.select",
    );
    await act(async () => choose?.click());
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "storage.save",
    );
    await act(async () => save?.click());

    expect(mocks.updateAlphaSettings).toHaveBeenCalledWith({
      dataDir: "D:/synced-alpha",
    });
    expect(mocks.restartAlpha).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
