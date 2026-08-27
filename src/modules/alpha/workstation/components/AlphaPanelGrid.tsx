/**
 * 本文件实现 Alpha 工作台固定 24 列拖拽网格。
 * 网格只在拖动或缩放结束时提交几何坐标，并通过稳定宿主挂载业务面板。
 */

import { AlphaPanelChrome } from "@/modules/alpha/workstation/components/AlphaPanelChrome";
import { AlphaPanelHost } from "@/modules/alpha/workstation/components/AlphaPanelPool";
import {
  ALPHA_WORKSTATION_GRID_COLUMNS,
  type AlphaGridItem,
  type AlphaSymbolBinding,
  type AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import GridLayout, {
  type Layout,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useCallback, useMemo } from "react";

export const ALPHA_WORKSTATION_MIN_GRID_WIDTH = 1200;

type Props = {
  state: AlphaWorkstationState;
  registry: AlphaPanelRegistry;
  onGridCommit: (grid: AlphaGridItem[]) => void;
  onBindingChange: (panelId: string, binding: AlphaSymbolBinding) => void;
  onRemovePanel: (panelId: string) => void;
};

/** 渲染固定列数的工作台网格，并把最终交互结果转换回公共布局协议。 */
export function AlphaPanelGrid({
  state,
  registry,
  onGridCommit,
  onBindingChange,
  onRemovePanel,
}: Props) {
  const { width, containerRef, mounted } = useContainerWidth({
    initialWidth: ALPHA_WORKSTATION_MIN_GRID_WIDTH,
  });
  const layout = useMemo<Layout>(() => {
    const panelsById = new Map(
      state.layout.panels.map((panel) => [panel.id, panel] as const),
    );
    return state.layout.grid.map((item) => {
      const descriptor = registry.get(panelsById.get(item.panelId)?.type ?? "");
      return {
        i: item.panelId,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        minW: descriptor?.defaultSize.minW,
        minH: descriptor?.defaultSize.minH,
      };
    });
  }, [registry, state.layout.grid, state.layout.panels]);

  const commit = useCallback(
    (next: Layout) => {
      onGridCommit(
        next.map((item) => ({
          panelId: item.i,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        })),
      );
    },
    [onGridCommit],
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-muted/20"
      data-alpha-workstation-grid-viewport
    >
      <div
        ref={containerRef}
        className="min-h-full"
        style={{ minWidth: ALPHA_WORKSTATION_MIN_GRID_WIDTH }}
      >
        {mounted ? (
          <GridLayout
            className="alpha-workstation-grid"
            width={Math.max(width, ALPHA_WORKSTATION_MIN_GRID_WIDTH)}
            layout={layout}
            compactor={verticalCompactor}
            gridConfig={{
              cols: ALPHA_WORKSTATION_GRID_COLUMNS,
              rowHeight: 30,
              margin: [6, 6],
              containerPadding: [8, 8],
              maxRows: Number.POSITIVE_INFINITY,
            }}
            dragConfig={{
              enabled: !state.locked,
              bounded: false,
              handle: ".alpha-panel-drag-handle",
              cancel: "button,input,select,[role='button']",
              threshold: 3,
            }}
            resizeConfig={{ enabled: !state.locked, handles: ["se"] }}
            onDragStop={commit}
            onResizeStop={commit}
          >
            {state.layout.panels.map((panel) => (
              <section
                key={panel.id}
                className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-sm"
                data-alpha-workstation-panel={panel.id}
              >
                <AlphaPanelChrome
                  panel={panel}
                  registry={registry}
                  mainSymbol={state.mainSymbol}
                  onBindingChange={(binding) =>
                    onBindingChange(panel.id, binding)
                  }
                  onRemove={() => onRemovePanel(panel.id)}
                />
                <AlphaPanelHost panelId={panel.id} className="min-h-0 flex-1" />
              </section>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
