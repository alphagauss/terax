/**
 * 本文件测试 Alpha 24 列网格与 react-grid-layout 的交互边界。
 * 重点锁定网格只在 stop 回调提交坐标，布局锁定同时关闭拖动和缩放。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let latestGridProps: Record<string, unknown> | null = null;

vi.mock("react-grid-layout", () => ({
  default: (
    props: Record<string, unknown> & { children?: React.ReactNode },
  ) => {
    latestGridProps = props;
    return <div data-testid="grid">{props.children}</div>;
  },
  useContainerWidth: () => ({
    width: 1200,
    containerRef: { current: null },
    mounted: true,
  }),
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
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
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

  it("固定使用 24 列并且只在拖动或缩放结束时提交", async () => {
    const onGridCommit = vi.fn();
    const state = createDefaultAlphaWorkstationState();
    await renderGrid(state, onGridCommit);

    expect(latestGridProps?.onLayoutChange).toBeUndefined();
    expect(latestGridProps?.gridConfig).toMatchObject({ cols: 24 });
    expect(latestGridProps?.compactor).toMatchObject({
      type: null,
      allowOverlap: true,
    });
    expect(onGridCommit).not.toHaveBeenCalled();

    const panelId = state.layout.panels[0].id;
    const finalLayout = [
      { i: panelId, x: 6, y: 3, w: 18, h: 12, minW: 6, minH: 8 },
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
      w: 18,
      h: 12,
    });
  });

  it("布局锁定同时禁用拖动和缩放", async () => {
    const state = { ...createDefaultAlphaWorkstationState(), locked: true };
    await renderGrid(state, vi.fn());

    expect(latestGridProps?.dragConfig).toMatchObject({ enabled: false });
    expect(latestGridProps?.resizeConfig).toMatchObject({ enabled: false });
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
        h: 1,
        minH: 1,
        isResizable: false,
      }),
    ]);
    const content = container.querySelector("[data-host]");
    act(() =>
      content?.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(raise).toHaveBeenCalledWith(panel.id);
    expect(state.layout.grid[0].h).toBe(16);
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
