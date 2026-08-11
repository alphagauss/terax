/**
 * 本文件测试侧边栏布局 Hook 的临时隐藏行为。
 * 重点锁定禅模式期间不改写运行时状态，并在退出后恢复原面板布局。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarLayout } from "./useSidebarLayout";

const workspaceStorage = vi.hoisted(() => ({
  get: vi.fn<() => unknown>(),
  set: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceValue: workspaceStorage.get,
  setWorkspaceValue: workspaceStorage.set,
}));

vi.mock("./persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./persistence")>();
  return {
    ...actual,
    persistSidebarPlacementState: vi.fn<() => Promise<void>>(),
    subscribeSidebarPlacementState: vi.fn(async () => () => {}),
  };
});

type Controls = ReturnType<typeof useSidebarLayout>;

/** 向测试暴露侧边栏控制器。 */
function Harness({
  temporarilyHidden,
  onReady,
}: {
  temporarilyHidden: boolean;
  onReady: (controls: Controls) => void;
}) {
  onReady(useSidebarLayout([], temporarilyHidden));
  return null;
}

describe("useSidebarLayout temporary hiding", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    vi.clearAllMocks();
  });

  it("blocks visibility changes and restores the runtime layout", async () => {
    workspaceStorage.get.mockReturnValue(undefined);
    workspaceStorage.set.mockResolvedValue();
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    let controls: Controls | undefined;
    const render = async (temporarilyHidden: boolean) => {
      await act(async () => {
        root.render(
          createElement(Harness, {
            temporarilyHidden,
            onReady: (next) => {
              controls = next;
            },
          }),
        );
      });
    };
    const current = () => {
      if (!controls) throw new Error("sidebar controls are unavailable");
      return controls;
    };

    await render(false);
    const getPrimarySize = vi.fn(() => ({ inPixels: 280 }));
    const primary = {
      collapse: vi.fn(),
      resize: vi.fn(),
      getSize: getPrimarySize,
    } as unknown as PanelImperativeHandle;
    const secondary = {
      collapse: vi.fn(),
      resize: vi.fn(),
      getSize: vi.fn(() => ({ inPixels: 360 })),
    } as unknown as PanelImperativeHandle;
    current().panelRefs.primary.current = primary;
    current().panelRefs.secondary.current = secondary;

    await render(true);
    expect(primary.collapse).toHaveBeenCalledOnce();
    expect(secondary.collapse).toHaveBeenCalledOnce();
    expect(current().isVisible("explorer")).toBe(false);
    expect(current().openContainer("source-control")).toBe(false);
    expect(current().toggleLocation("primary")).toBe(false);
    expect(current().runtime.primary).toMatchObject({
      activeId: "explorer",
      collapsed: false,
    });

    getPrimarySize.mockClear();
    workspaceStorage.set.mockClear();
    current().commitLayout();
    expect(getPrimarySize).not.toHaveBeenCalled();
    expect(workspaceStorage.set).not.toHaveBeenCalled();

    await render(false);
    expect(primary.resize).toHaveBeenLastCalledWith(
      `${current().runtime.primary.width}px`,
    );
    expect(secondary.collapse).toHaveBeenCalledTimes(2);
    expect(current().isVisible("explorer")).toBe(true);
  });
});
