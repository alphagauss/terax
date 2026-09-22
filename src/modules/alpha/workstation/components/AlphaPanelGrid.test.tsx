/**
 * 本文件测试 Alpha 固定步长网格与 react-grid-layout 的交互边界。
 * 重点锁定网格只在 stop 回调提交坐标，布局锁定同时关闭拖动和缩放。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let latestGridProps: Record<string, unknown> | null = null;
let measureViewport: () => void;

vi.mock("react-grid-layout", () => ({
  default: (
    props: Record<string, unknown> & { children?: React.ReactNode },
  ) => {
    latestGridProps = props;
    return <div data-testid="grid">{props.children}</div>;
  },
}));

vi.mock("@/modules/alpha/workstation/components/AlphaPanelPool", () => ({
  AlphaPanelHost: ({ panelId }: { panelId: string }) => (
    <div data-host={panelId} />
  ),
}));

vi.mock("@/modules/alpha/workstation/components/AlphaPanelChrome", () => ({
  AlphaPanelChrome: ({ panel }: { panel: { id: string } }) => (
    <div data-chrome={panel.id} />
  ),
}));

import { AlphaPanelGrid } from "@/modules/alpha/workstation/components/AlphaPanelGrid";
import type {
  AlphaGridItem,
  AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
import { createDefaultAlphaWorkstationState } from "@/modules/alpha/workstation/templates";

describe("AlphaPanelGrid", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    latestGridProps = null;
    container = document.createElement("div");
    root = createRoot(container);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measureViewport = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderGrid(
    state: AlphaWorkstationState,
    onGridCommit: (item: AlphaGridItem) => void,
    onRaisePanel = (_panelId: string) => undefined,
    revealRequest: { panelId: string } | null = null,
  ) {
    await act(async () => {
      root?.render(
        <AlphaPanelGrid
          state={state}
          registry={alphaPanelRegistry}
          onGridItemCommit={onGridCommit}
          onBindingChange={() => undefined}
          onRemovePanel={() => undefined}
          onToggleCollapsed={() => undefined}
          onRaisePanel={onRaisePanel}
          revealRequest={revealRequest}
        />,
      );
    });
  }

  it("按内容边界提供列数并且只在拖动或缩放结束时提交", async () => {
    const onGridCommit = vi.fn();
    const state = createDefaultAlphaWorkstationState();
    await renderGrid(state, onGridCommit);

    expect(latestGridProps?.onLayoutChange).toBeUndefined();
    expect(latestGridProps?.gridConfig).toMatchObject({
      cols: 80,
      rowHeight: 14,
      margin: [1, 1],
      containerPadding: [1, 1],
    });
    expect(latestGridProps?.compactor).toMatchObject({
      type: null,
      allowOverlap: true,
    });
    expect(onGridCommit).not.toHaveBeenCalled();

    const panelId = state.layout.panels[0].id;
    const finalLayout = [
      { i: panelId, x: 6, y: 3, w: 30, h: 24, minW: 20, minH: 19 },
      { i: "other", x: 0, y: 0, w: 6, h: 8, minW: 6, minH: 8 },
    ];
    if (!latestGridProps) throw new Error("grid props were not captured");
    const onDragStop = latestGridProps.onDragStop as (
      layout: typeof finalLayout,
      oldItem: null,
      item: (typeof finalLayout)[number],
    ) => void;
    const onResizeStop = latestGridProps.onResizeStop as (
      layout: typeof finalLayout,
      oldItem: null,
      item: (typeof finalLayout)[number],
    ) => void;
    act(() => {
      onDragStop(finalLayout, null, finalLayout[0]);
      onResizeStop(finalLayout, null, finalLayout[0]);
    });

    expect(onGridCommit).toHaveBeenCalledTimes(2);
    expect(onGridCommit).toHaveBeenLastCalledWith({
      panelId,
      x: 6,
      y: 3,
      w: 30,
      h: 24,
    });
  });

  it("布局锁定同时禁用拖动和缩放", async () => {
    const state = { ...createDefaultAlphaWorkstationState(), locked: true };
    await renderGrid(state, vi.fn());

    expect(latestGridProps?.dragConfig).toMatchObject({ enabled: false });
    expect(latestGridProps?.resizeConfig).toMatchObject({ enabled: false });
  });

  it("侧边栏或窗口改变可用宽度时保留面板尺寸、身份和有效滚动位置", async () => {
    const state = createDefaultAlphaWorkstationState();
    const commit = vi.fn();
    await renderGrid(state, commit);
    const viewport = container.querySelector<HTMLElement>(
      "[data-alpha-workstation-grid-viewport]",
    );
    const canvas = viewport?.firstElementChild as HTMLElement;
    const panel = container.querySelector("[data-alpha-workstation-panel]");
    const layout = latestGridProps?.layout;
    if (!viewport || !canvas) throw new Error("缺少工作台画布");
    viewport.scrollLeft = 50;
    viewport.scrollTop = 80;
    for (const width of [900, 700, 1100, 800]) {
      viewport.style.width = `${width}px`;
      Object.defineProperty(viewport, "clientWidth", {
        configurable: true,
        value: width,
      });
      act(() => measureViewport());
      await renderGrid(state, commit);
      expect(canvas.style.width).toBe("1201px");
      expect(latestGridProps?.width).toBe(1201);
      expect(latestGridProps?.layout).toBe(layout);
      expect(container.querySelector("[data-alpha-workstation-panel]")).toBe(
        panel,
      );
      expect(viewport.scrollLeft).toBe(50);
      expect(viewport.scrollTop).toBe(80);
    }
    viewport.style.width = "1800px";
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      value: 1800,
    });
    act(() => measureViewport());
    await renderGrid(state, commit);
    expect(canvas.style.width).toBe("1800px");
    expect(latestGridProps?.width).toBe(1786);
    expect(latestGridProps?.gridConfig).toMatchObject({ cols: 119 });
    expect(latestGridProps?.layout).toBe(layout);
    expect(commit).not.toHaveBeenCalled();
  });

  it("拖动到右边界时继续扩展列数，仅结束时保存目标几何", async () => {
    const state = createDefaultAlphaWorkstationState();
    const commit = vi.fn();
    await renderGrid(state, commit);
    const item = { i: state.layout.panels[0].id, x: 0, y: 0, w: 80, h: 38 };
    const trigger = (name: string) =>
      act(() => {
        const callback = latestGridProps?.[name] as (
          _layout: unknown[],
          _old: null,
          nextItem: typeof item,
        ) => void;
        callback([], null, item);
      });
    trigger("onDragStart");
    expect(latestGridProps?.gridConfig).toMatchObject({ cols: 96 });
    item.x = 15;
    trigger("onDrag");
    expect(latestGridProps?.gridConfig).toMatchObject({ cols: 111 });
    expect(commit).not.toHaveBeenCalled();
    trigger("onDragStop");
    expect(commit).toHaveBeenCalledWith({
      panelId: item.i,
      x: 15,
      y: 0,
      w: 80,
      h: 38,
    });
  });

  it("从宽视口开始拖动后，视口收窄不能收回交互中的列数", async () => {
    const state = createDefaultAlphaWorkstationState();
    await renderGrid(state, vi.fn());
    const viewport = container.querySelector<HTMLElement>(
      "[data-alpha-workstation-grid-viewport]",
    );
    if (!viewport) throw new Error("缺少视口");
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      value: 1800,
    });
    act(() => measureViewport());
    const item = { i: state.layout.panels[0].id, x: 0, y: 0, w: 80, h: 38 };
    const start = latestGridProps?.onDragStart as (
      _layout: unknown[],
      _old: null,
      next: typeof item,
    ) => void;
    act(() => start([], null, item));
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      value: 900,
    });
    act(() => measureViewport());
    expect(latestGridProps?.gridConfig).toMatchObject({ cols: 119 });
    const stop = latestGridProps?.onDragStop as typeof start;
    act(() => stop([], null, item));
    expect(latestGridProps?.gridConfig).toMatchObject({ cols: 80 });
  });

  it("收起仅改变自身占位并禁止缩放，内容原生事件可以置顶", async () => {
    const state = createDefaultAlphaWorkstationState();
    const panel = state.layout.panels[0];
    panel.collapsed = true;
    const raise = vi.fn();
    await renderGrid(state, vi.fn(), raise);
    expect(latestGridProps?.layout).toEqual([
      expect.objectContaining({
        i: panel.id,
        h: 2,
        minH: 2,
        isResizable: false,
      }),
    ]);
    const content = container.querySelector("[data-host]");
    act(() =>
      content?.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(raise).toHaveBeenCalledWith(panel.id);
    expect(state.layout.grid[0].h).toBe(38);
  });

  it("找回面板时把标题定位到可用视口，不把滚动条区域当成可见内容", async () => {
    const state = createDefaultAlphaWorkstationState();
    const commit = vi.fn();
    await renderGrid(state, commit);
    const viewport = container.querySelector<HTMLElement>(
      "[data-alpha-workstation-grid-viewport]",
    );
    const panel = container.querySelector<HTMLElement>(
      "[data-alpha-workstation-panel]",
    );
    if (!viewport || !panel) throw new Error("缺少网格宿主");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1000, 600),
    );
    Object.defineProperties(viewport, {
      clientWidth: { value: 984 },
      clientHeight: { value: 584 },
    });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      new DOMRect(500, 560, 500, 400),
    );
    await renderGrid(state, commit, vi.fn(), {
      panelId: state.layout.panels[0].id,
    });
    expect(viewport.scrollTop).toBe(560);
    expect(viewport.scrollLeft).toBe(500);
    expect(commit).not.toHaveBeenCalled();
  });
});
