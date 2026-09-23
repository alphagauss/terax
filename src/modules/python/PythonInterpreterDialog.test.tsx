/**
 * 本文件测试 Python 解释器选择对话框的失败分类。
 * 锁定手动解释器探测成功后，持久化失败不会被误报为无效解释器。
 */

// @vitest-environment happy-dom

import { act, createElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  open: vi.fn(),
  probe: vi.fn(),
  translate: (key: string) => key,
}));

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
  }: {
    children: ReactNode;
    open: boolean;
  }) => (open ? createElement("div", null, children) : null),
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
import {
  WorkbenchPageDialog,
  WorkbenchPageScope,
} from "@/modules/workbench/WorkbenchPageOverlays";

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
    expect(container.textContent).toContain("selectionFailed");
    expect(container.textContent).not.toContain("probeFailed");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    act(() => root.unmount());
  });

  it("页内解释器选择随标签隐藏保留搜索，关闭后只解除自身模态", async () => {
    const workspace = { kind: "local" as const };
    function Harness({ visible }: { visible: boolean }) {
      const [open, setOpen] = useState(true);
      return (
        <WorkbenchPageScope visible={visible} focused={visible}>
          <WorkbenchPageDialog open title="settings" onOpenChange={() => {}}>
            <PythonInterpreterDialog
              scope="page"
              open={open}
              onOpenChange={setOpen}
              root={null}
              workspace={workspace}
              onSelect={() => {}}
            />
          </WorkbenchPageDialog>
        </WorkbenchPageScope>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      const render = async (visible: boolean) =>
        act(async () => root.render(<Harness visible={visible} />));
      await render(true);
      const input = container.querySelector("input");
      if (!input) throw new Error("Picker did not mount");
      input.value = "python draft";
      const child = input.closest<HTMLElement>("[data-workbench-page-overlay]");
      const parent = [
        ...container.querySelectorAll<HTMLElement>(
          "[data-workbench-page-overlay]",
        ),
      ].find((layer) => layer !== child);
      expect(parent?.inert).toBe(true);
      expect(document.body.style.pointerEvents).toBe("");
      await render(false);
      expect(child?.inert).toBe(true);
      await render(true);
      expect(container.querySelector("input")).toBe(input);
      expect(input.value).toBe("python draft");
      expect(mocks.list).toHaveBeenCalledOnce();
      const close = [...(child?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === "close",
      );
      await act(async () => close?.click());
      expect(
        container.querySelectorAll("[data-workbench-page-overlay]"),
      ).toHaveLength(1);
      expect(parent?.inert).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("原生文件选择尚未返回时阻止重复浏览和提前关闭，取消后解除占用", async () => {
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
            <PythonInterpreterDialog
              scope="page"
              open
              onOpenChange={onOpenChange}
              root={null}
              workspace={{ kind: "local" }}
              onSelect={() => {}}
            />
          </WorkbenchPageScope>,
        ),
      );
      const browse = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "browse",
      );
      const close = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "close",
      );
      await act(async () => browse?.click());
      expect(browse?.disabled).toBe(true);
      await act(async () => {
        browse?.click();
        close?.click();
      });
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => finish(null));
      expect(browse?.disabled).toBe(false);
      await act(async () => close?.click());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
