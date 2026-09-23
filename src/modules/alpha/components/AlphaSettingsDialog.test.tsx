/**
 * 本文件测试 Alpha 页内设置的状态探测、数据目录草稿和 Python 选择流程。
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
  stopAlpha: vi.fn(),
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
  stopAlpha: mocks.stopAlpha,
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

import { AlphaSettingsDialog } from "@/modules/alpha/components/AlphaSettingsDialog";
import { clearAlphaQueryCache } from "@/modules/alpha/query";
import { WorkbenchPageScope } from "@/modules/workbench/WorkbenchPageOverlays";

function SettingsHarness({ visible }: { visible: boolean }) {
  return (
    <WorkbenchPageScope visible={visible} focused={visible}>
      <AlphaSettingsDialog open visible={visible} onOpenChange={() => {}} />
    </WorkbenchPageScope>
  );
}

describe("AlphaSettingsDialog", () => {
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
    mocks.stopAlpha.mockReset();
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
      root.render(createElement(SettingsHarness, { visible: true }));
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(1);
    expect(mocks.getAlphaSettings).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(createElement(SettingsHarness, { visible: false }));
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(createElement(SettingsHarness, { visible: true }));
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
      root.render(createElement(SettingsHarness, { visible: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(container.textContent).toContain("service.startedAtTitle");
    expect(container.textContent).toContain("service.runtimeRevisionTitle");
    expect(container.textContent).toContain("release:0123456789ab");
    expect(container.querySelector("[title]")).toBeNull();
    const revision = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "release:0123456789ab",
    );
    expect(revision).toBeDefined();
    act(() =>
      revision?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "release:0123456789abcdef",
    );
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
      root.render(createElement(SettingsHarness, { visible: true }));
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
      root.render(createElement(SettingsHarness, { visible: true }));
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
      root.render(createElement(SettingsHarness, { visible: true }));
    });
    const select = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "python.select",
    );

    await act(async () => select?.click());
    const dialog = mocks.pythonDialogProps as {
      open: boolean;
      scope: string;
      onSelect: (interpreter: { path: string }) => Promise<void>;
    };
    expect(dialog.open).toBe(true);
    expect(dialog.scope).toBe("page");
    await act(async () => {
      await dialog.onSelect({ path: "C:/Python/python.exe" });
    });

    expect(mocks.setAlphaPythonPath).toHaveBeenCalledWith(
      "C:/Python/python.exe",
    );
    act(() => root.unmount());
  });

  it("切页后的权威目录刷新不覆盖未保存选择", async () => {
    mocks.getAlphaStatus.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
    });
    mocks.open.mockResolvedValue("D:/draft-alpha");
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const render = async (visible: boolean) =>
        act(async () => {
          root.render(<SettingsHarness visible={visible} />);
          await vi.advanceTimersByTimeAsync(100);
        });
      await render(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const choose = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "storage.select",
      );
      expect(choose?.disabled).toBe(false);
      await act(async () => choose?.click());
      expect(container.textContent).toContain("D:/draft-alpha");
      await render(false);
      mocks.getAlphaSettings.mockResolvedValue({
        dataDir: "D:/external-change",
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await render(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mocks.getAlphaSettings).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("D:/draft-alpha");
      expect(container.textContent).not.toContain("D:/external-change");
    } finally {
      act(() => root.unmount());
    }
  });

  it("停止服务途中切页仍完成操作，并保留设置供重新启动", async () => {
    const status = {
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
    };
    mocks.getAlphaStatus.mockResolvedValue(status);
    let finish: (value: unknown) => void = () => {};
    mocks.stopAlpha.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const render = async (visible: boolean) =>
        act(async () =>
          root.render(
            <WorkbenchPageScope visible={visible} focused={visible}>
              <AlphaSettingsDialog
                open
                visible={visible}
                onOpenChange={onOpenChange}
              />
            </WorkbenchPageScope>,
          ),
        );
      await render(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const stop = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "actions.stop",
      );
      expect(stop).toBeDefined();
      await act(async () => stop?.click());
      expect(mocks.stopAlpha).toHaveBeenCalledOnce();
      const dialog = container.querySelector(
        '[data-workbench-page-overlay="dialog"]',
      );
      const close = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "close",
      );
      await act(async () => close?.click());
      expect(onOpenChange).not.toHaveBeenCalled();
      await render(false);
      const stopped = { ...status, running: false };
      mocks.getAlphaStatus.mockResolvedValue(stopped);
      await act(async () => {
        finish(stopped);
        await vi.advanceTimersByTimeAsync(100);
      });
      await render(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(
        container.querySelector('[data-workbench-page-overlay="dialog"]'),
      ).toBe(dialog);
      expect(container.textContent).toContain("actions.start");
      await act(async () => close?.click());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("停服前发起的状态轮询不能覆盖停服结果", async () => {
    const running = {
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
    };
    let finish: (value: unknown) => void = () => {};
    mocks.getAlphaStatus.mockResolvedValueOnce(running).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.stopAlpha.mockResolvedValue({ ...running, running: false });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SettingsHarness visible />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_600);
      });
      expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(2);
      const stop = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "actions.stop",
      );
      await act(async () => {
        stop?.click();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mocks.stopAlpha).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("actions.start");
      await act(async () => {
        finish(running);
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(container.textContent).toContain("actions.start");
      expect(container.textContent).not.toContain("actions.stop");
    } finally {
      act(() => root.unmount());
    }
  });

  it("目录选择等待期间保持设置占用，取消后恢复关闭能力", async () => {
    mocks.getAlphaStatus.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 8765,
      issue: null,
    });
    let finish: (value: null) => void = () => {};
    mocks.open.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <WorkbenchPageScope visible focused>
            <AlphaSettingsDialog open visible onOpenChange={onOpenChange} />
          </WorkbenchPageScope>,
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const choose = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "storage.select",
      );
      const close = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "close",
      );
      await act(async () => choose?.click());
      expect(choose?.disabled).toBe(true);
      await act(async () => {
        choose?.click();
        close?.click();
      });
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => finish(null));
      expect(choose?.disabled).toBe(false);
      await act(async () => close?.click());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
