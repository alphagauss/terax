/**
 * 本文件测试 Python 解释器选择对话框的失败分类。
 * 锁定手动解释器探测成功后，持久化失败不会被误报为无效解释器。
 */

// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  probe: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("@/lib/errors", () => ({ reportError: mocks.reportError }));

vi.mock("@/components/controls/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) =>
    createElement("button", { type: "button", ...props }, children),
}));

vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open
      ? createElement(
          "div",
          null,
          createElement(
            "button",
            { type: "button", onClick: () => onOpenChange(false) },
            "close",
          ),
          children,
        )
      : null,
  CommandEmpty: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandGroup: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandInput: () => createElement("input"),
  CommandItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandList: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandSeparator: () => createElement("hr"),
}));

vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => createElement("span"),
}));

vi.mock("@/modules/python/native", () => ({
  listPythonInterpreters: mocks.list,
  probePythonInterpreter: mocks.probe,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

import { PythonInterpreterDialog } from "@/modules/python/PythonInterpreterDialog";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("PythonInterpreterDialog", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.open.mockReset().mockResolvedValue("C:/Python/python.exe");
    mocks.probe.mockReset().mockResolvedValue({
      path: "C:/Python/python.exe",
      environmentRoot: "C:/Python",
      version: "3.13.4",
      name: "Python 3.13",
      kind: "system",
      source: "manual",
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  it("reports persistence failure separately from probe failure", async () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn().mockRejectedValue(new Error("store failed"));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(PythonInterpreterDialog, {
          open: true,
          onOpenChange,
          root: null,
          workspace: { kind: "local" },
          onSelect,
        }),
      );
    });
    const browse = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "browse",
    );

    await act(async () => browse?.click());

    expect(mocks.probe).toHaveBeenCalledWith("C:/Python/python.exe", {
      kind: "local",
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(mocks.reportError).toHaveBeenCalledWith("selectionFailed", {
      error: expect.objectContaining({ message: "store failed" }),
    });
    expect(container.textContent).not.toContain("probeFailed");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    act(() => root.unmount());
  });

  it("文件选择器等待期间阻止重复浏览与关闭，取消后恢复操作", async () => {
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
          createElement(PythonInterpreterDialog, {
            open: true,
            onOpenChange,
            root: null,
            workspace: { kind: "local" },
            onSelect: () => {},
          }),
        ),
      );
      const button = (text: string) =>
        [...container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent === text,
        );
      const browse = button("browse");
      await act(async () => browse?.click());
      expect(browse?.disabled).toBe(true);
      await act(async () => {
        browse?.click();
        button("close")?.click();
      });
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => finish(null));
      expect(browse?.disabled).toBe(false);
      await act(async () => button("close")?.click());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
