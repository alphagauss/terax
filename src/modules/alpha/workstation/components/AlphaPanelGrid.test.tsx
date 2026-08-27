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
  verticalCompactor: { type: "vertical", allowOverlap: false },
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
import type { AlphaWorkstationState } from "@/modules/alpha/workstation/model";
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
  });

  async function renderGrid(
    state: AlphaWorkstationState,
    onGridCommit: (grid: Array<Record<string, unknown>>) => void,
  ) {
    await act(async () => {
      root?.render(
        <AlphaPanelGrid
          state={state}
          registry={alphaPanelRegistry}
          onGridCommit={onGridCommit}
          onBindingChange={() => undefined}
          onRemovePanel={() => undefined}
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
    expect(latestGridProps?.compactor).toMatchObject({ type: "vertical" });
    expect(onGridCommit).not.toHaveBeenCalled();

    const panelId = state.layout.panels[0].id;
    const finalLayout = [
      { i: panelId, x: 6, y: 3, w: 18, h: 12, minW: 6, minH: 8 },
    ];
    if (!latestGridProps) throw new Error("grid props were not captured");
    const onDragStop = latestGridProps.onDragStop as (
      layout: typeof finalLayout,
    ) => void;
    const onResizeStop = latestGridProps.onResizeStop as (
      layout: typeof finalLayout,
    ) => void;
    act(() => {
      onDragStop(finalLayout);
      onResizeStop(finalLayout);
    });

    expect(onGridCommit).toHaveBeenCalledTimes(2);
    expect(onGridCommit).toHaveBeenLastCalledWith([
      { panelId, x: 6, y: 3, w: 18, h: 12 },
    ]);
  });

  it("布局锁定同时禁用拖动和缩放", async () => {
    const state = { ...createDefaultAlphaWorkstationState(), locked: true };
    await renderGrid(state, vi.fn());

    expect(latestGridProps?.dragConfig).toMatchObject({ enabled: false });
    expect(latestGridProps?.resizeConfig).toMatchObject({ enabled: false });
  });
});
