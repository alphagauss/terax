/**
 * 本文件测试侧边栏布局 Hook 的临时隐藏、副侧栏展示模式和窗口初始折叠行为。
 * 重点锁定呈现模式恢复，并确保新建临时窗口默认关闭两侧面板。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type {
  GroupImperativeHandle,
  PanelImperativeHandle,
} from "react-resizable-panels";
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
    persistSidebarPlacementState: vi.fn(async () => {}),
    subscribeSidebarPlacementState: vi.fn(async () => () => {}),
  };
});

type Controls = ReturnType<typeof useSidebarLayout>;

/** 向测试暴露侧边栏控制器。 */
function Harness({
  temporarilyHidden,
  collapseOnInitialOpen = false,
  onReady,
}: {
  temporarilyHidden: boolean;
  collapseOnInitialOpen?: boolean;
  onReady: (controls: Controls) => void;
}) {
  onReady(useSidebarLayout([], temporarilyHidden, collapseOnInitialOpen));
  return null;
}

describe("useSidebarLayout temporary hiding", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    vi.clearAllMocks();
  });

  it("工作页入口不激活侧栏，收起后仍可恢复原侧栏内容", async () => {
    workspaceStorage.get.mockReturnValue(undefined);
    workspaceStorage.set.mockResolvedValue();
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    let controls: Controls | undefined;
    await act(async () =>
      root.render(
        createElement(Harness, {
          temporarilyHidden: false,
          onReady: (next) => {
            controls = next;
          },
        }),
      ),
    );
    const current = () => {
      if (!controls) throw new Error("sidebar controls are unavailable");
      return controls;
    };
    expect(current().openContainer("alpha")).toBe(false);
    expect(current().toggleContainer("alpha")).toBe(false);
    await act(async () => current().closeLocation("primary"));
    await act(async () => current().closeLocation("primary"));
    expect(current().runtime.primary).toMatchObject({
      activeId: "explorer",
      collapsed: true,
    });
    await act(async () => current().toggleLocation("primary"));
    expect(current().runtime.primary).toMatchObject({
      activeId: "explorer",
      collapsed: false,
    });
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
    await act(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(primary.resize).toHaveBeenLastCalledWith(
      `${current().runtime.primary.width}px`,
    );
    expect(secondary.collapse).toHaveBeenCalledTimes(2);
    expect(current().isVisible("explorer")).toBe(true);
  });

  it("starts both sidebars collapsed only for a new temporary window", async () => {
    workspaceStorage.get.mockReturnValue(undefined);
    workspaceStorage.set.mockResolvedValue();
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    let controls: Controls | undefined;

    await act(async () => {
      root.render(
        createElement(Harness, {
          temporarilyHidden: false,
          collapseOnInitialOpen: true,
          onReady: (next) => {
            controls = next;
          },
        }),
      );
    });

    expect(controls?.initialRuntime.primary.collapsed).toBe(true);
    expect(controls?.initialRuntime.secondary.collapsed).toBe(true);
    expect(controls?.initialRuntime.primary.activeId).toBe("explorer");
    expect(controls?.initialRuntime.secondary.activeId).toBe("ai");
    expect(workspaceStorage.set).toHaveBeenLastCalledWith(
      "sidebar-layout:runtime",
      expect.objectContaining({
        primary: expect.objectContaining({ collapsed: true }),
        secondary: expect.objectContaining({ collapsed: true }),
      }),
    );
  });

  it("shares layout capture and restoration across secondary sidebar modes", async () => {
    workspaceStorage.get.mockReturnValue(undefined);
    workspaceStorage.set.mockResolvedValue();
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    let controls: Controls | undefined;

    await act(async () => {
      root.render(
        createElement(Harness, {
          temporarilyHidden: false,
          onReady: (next) => {
            controls = next;
          },
        }),
      );
    });
    const current = () => {
      if (!controls) throw new Error("sidebar controls are unavailable");
      return controls;
    };
    const primaryResize = vi.fn();
    const secondaryResize = vi.fn();
    const setLayout = vi.fn((layout) => layout);
    const previousLayout = {
      "primary-sidebar": 20,
      workspace: 50,
      "secondary-sidebar": 30,
    };
    const primary = {
      collapse: vi.fn(),
      resize: primaryResize,
      getSize: vi.fn(() => ({ inPixels: 280 })),
    } as unknown as PanelImperativeHandle;
    const secondary = {
      collapse: vi.fn(),
      resize: secondaryResize,
      getSize: vi.fn(() => ({ inPixels: 360 })),
    } as unknown as PanelImperativeHandle;
    const group = {
      getLayout: vi.fn(() => previousLayout),
      setLayout,
    } as unknown as GroupImperativeHandle;
    current().panelRefs.primary.current = primary;
    current().panelRefs.secondary.current = secondary;
    current().workbenchGroupRef.current = group;

    await act(async () => current().openContainer("ai"));
    secondaryResize.mockClear();
    await act(async () => current().toggleSecondaryMode("expanded"));

    expect(current().runtime.secondaryMode).toBe("expanded");
    expect(current().runtime.primary.width).toBe(280);
    expect(current().runtime.secondary.width).toBe(360);
    expect(current().isVisible("explorer")).toBe(true);
    expect(current().isVisible("ai")).toBe(true);
    expect(setLayout).toHaveBeenLastCalledWith({
      "primary-sidebar": 20,
      workspace: 0,
      "secondary-sidebar": 80,
    });

    await act(async () => current().toggleLocation("primary"));
    expect(current().runtime.primary.collapsed).toBe(true);
    expect(current().runtime.secondaryMode).toBe("expanded");
    expect(setLayout).toHaveBeenLastCalledWith({
      "primary-sidebar": 0,
      workspace: 0,
      "secondary-sidebar": 100,
    });
    await act(async () => current().toggleLocation("primary"));
    expect(current().runtime.primary.collapsed).toBe(false);
    expect(current().runtime.secondaryMode).toBe("expanded");
    expect(setLayout).toHaveBeenLastCalledWith({
      "primary-sidebar": 20,
      workspace: 0,
      "secondary-sidebar": 80,
    });

    setLayout.mockClear();
    await act(async () => {
      current().restoreSecondaryModeForContainer("explorer");
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(current().runtime.secondaryMode).toBe("normal");
    expect(current().restoringSecondaryMode).toBeNull();
    expect(current().runtime.secondary.collapsed).toBe(false);
    expect(setLayout).toHaveBeenCalledWith(previousLayout);

    await act(async () => current().toggleSecondaryMode("expanded"));
    await act(async () => current().toggleLocation("primary"));
    await act(async () => current().toggleSecondaryMode("expanded"));
    await act(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(current().runtime.primary.collapsed).toBe(true);
    expect(primary.collapse).toHaveBeenCalled();

    setLayout.mockClear();
    await act(async () => current().toggleSecondaryMode("expanded"));
    expect(setLayout).toHaveBeenLastCalledWith({
      "primary-sidebar": 0,
      workspace: 0,
      "secondary-sidebar": 100,
    });
    await act(async () => current().toggleSecondaryMode("expanded"));
    await act(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });

    await act(async () => current().openContainer("explorer"));
    await act(async () => current().toggleSecondaryMode("expanded"));
    expect(current().restoreSecondaryModeForContainer("ai")).toBe(false);
    expect(current().runtime.secondaryMode).toBe("expanded");

    await act(async () => current().toggleSecondaryMode("maximized"));

    expect(current().runtime.secondaryMode).toBe("maximized");
    expect(current().runtime.primary.width).toBe(280);
    expect(current().runtime.secondary.width).toBe(360);
    expect(current().isVisible("explorer")).toBe(false);
    expect(current().isVisible("ai")).toBe(true);
    expect(setLayout).toHaveBeenLastCalledWith({
      "primary-sidebar": 0,
      workspace: 0,
      "secondary-sidebar": 100,
    });

    setLayout.mockClear();
    await act(async () => {
      current().toggleSecondaryMode("maximized");
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(current().runtime.secondaryMode).toBe("normal");
    expect(current().restoringSecondaryMode).toBeNull();
    expect(setLayout).toHaveBeenCalledOnce();
    expect(setLayout).toHaveBeenCalledWith(previousLayout);

    await act(async () => current().toggleSecondaryMode("maximized"));
    setLayout.mockClear();
    await act(async () => {
      current().setSecondaryMode("normal");
      root.render(
        createElement(Harness, {
          temporarilyHidden: true,
          onReady: (next) => {
            controls = next;
          },
        }),
      );
    });
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    expect(setLayout).toHaveBeenLastCalledWith({
      "primary-sidebar": 0,
      workspace: 100,
      "secondary-sidebar": 0,
    });

    await act(async () => {
      root.render(
        createElement(Harness, {
          temporarilyHidden: false,
          onReady: (next) => {
            controls = next;
          },
        }),
      );
    });
    await act(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(setLayout).toHaveBeenLastCalledWith(previousLayout);

    await act(async () => current().toggleSecondaryMode("expanded"));
    await act(async () => current().toggleContainerVisibility("ai"));
    expect(current().runtime.secondaryMode).toBe("expanded");
    await act(async () => {
      current().toggleContainerVisibility("channels");
      await new Promise(requestAnimationFrame);
    });
    expect(current().runtime.secondaryMode).toBe("normal");
    expect(current().restoringSecondaryMode).toBeNull();
    expect(current().runtime.secondary.collapsed).toBe(true);
    expect(secondary.collapse).toHaveBeenCalled();
  });
});
