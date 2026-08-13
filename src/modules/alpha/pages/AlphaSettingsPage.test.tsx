/**
 * 本文件测试 Alpha Workbench 设置页的状态探测、数据目录和 Python 选择流程。
 * 重点锁定可见性轮询、保存配置后自动重启共享服务以及解释器路径持久化。
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
  pythonDialogProps: null as unknown,
  restartAlpha: vi.fn(),
  setAlphaPythonPath: vi.fn(),
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
  setAlphaPythonPath: mocks.setAlphaPythonPath,
  startAlpha: vi.fn(),
  stopAlpha: vi.fn(),
}));

vi.mock("@/modules/alpha/preferences", () => ({
  setAlphaShowInRemote: vi.fn(),
  useAlphaShowInRemote: () => false,
}));

vi.mock("@/modules/python", () => ({
  PythonInterpreterDialog: (props: unknown) => {
    mocks.pythonDialogProps = props;
    return null;
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: mocks.translate,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { AlphaSettingsPage } from "@/modules/alpha/pages/AlphaSettingsPage";
import { clearAlphaQueryCache } from "@/modules/alpha/query";

describe("AlphaSettingsPage", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    clearAlphaQueryCache();
    mocks.getAlphaStatus.mockReset();
    mocks.getAlphaSettings.mockReset();
    mocks.getAlphaSettings.mockResolvedValue({ dataDir: "D:/alpha-data" });
    mocks.open.mockReset();
    mocks.pythonDialogProps = null;
    mocks.restartAlpha.mockReset();
    mocks.setAlphaPythonPath.mockReset().mockResolvedValue(undefined);
    mocks.updateAlphaSettings.mockReset();
    mocks.getAlphaStatus.mockResolvedValue({
      running: false,
      configured: false,
      pythonPath: null,
      autoStart: true,
      port: 8765,
      issue: null,
      runtimeRevision: null,
      startedAt: null,
    });
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
  });

  it("仅在页面可见时轮询状态，停服时不请求业务设置", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(1);
    expect(mocks.getAlphaSettings).not.toHaveBeenCalled();

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
    expect(mocks.getAlphaSettings).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("服务运行时展示启动时间和缩短的运行版本", async () => {
    mocks.getAlphaStatus.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
      runtimeRevision: "release:0123456789abcdef",
      startedAt: "2026-08-13T09:20:31Z",
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(container.textContent).toContain("service.startedAtTitle");
    expect(container.textContent).toContain("service.runtimeRevisionTitle");
    expect(container.textContent).toContain("release:0123456789ab");
    expect(
      container.querySelector('[title="release:0123456789abcdef"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it("保存数据目录后不依赖陈旧状态直接重启共享服务", async () => {
    mocks.getAlphaStatus.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
      runtimeRevision: "release:0123456789abcdef",
      startedAt: "2026-08-13T09:20:31Z",
    });
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
      issue: null,
      runtimeRevision: "release:0123456789abcdef",
      startedAt: "2026-08-13T09:20:31Z",
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    });
    expect(mocks.getAlphaSettings).toHaveBeenCalledTimes(1);
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

  it("设置接口失败时展示错误并允许重试", async () => {
    mocks.getAlphaStatus.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
      runtimeRevision: "release:0123456789abcdef",
      startedAt: "2026-08-13T09:20:31Z",
    });
    mocks.getAlphaSettings.mockRejectedValue(new Error("settings failed"));
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });

    expect(container.textContent).toContain("errors.setting");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "common.retry",
    );
    await act(async () => retry?.click());
    expect(mocks.getAlphaSettings).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
  });

  it("从解释器对话框选择后保存 Alpha Python 路径", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(AlphaSettingsPage, { visible: true }));
    });
    const select = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "python.select",
    );

    await act(async () => select?.click());
    const dialog = mocks.pythonDialogProps as {
      open: boolean;
      onSelect: (interpreter: { path: string }) => Promise<void>;
    };
    expect(dialog.open).toBe(true);
    await act(async () => {
      await dialog.onSelect({ path: "C:/Python/python.exe" });
    });

    expect(mocks.setAlphaPythonPath).toHaveBeenCalledWith(
      "C:/Python/python.exe",
    );
    act(() => root.unmount());
  });
});
