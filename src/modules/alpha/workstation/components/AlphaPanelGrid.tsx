/**
 * 本文件实现 Alpha 工作台固定 24 列拖拽网格。
 * 网格只在拖动或缩放结束时提交几何坐标，并通过稳定宿主挂载业务面板。
 */

import { AlphaPanelChrome } from "@/modules/alpha/workstation/components/AlphaPanelChrome";
import { AlphaPanelBody } from "@/modules/alpha/workstation/components/AlphaPanelBody";
import {
  ALPHA_WORKSTATION_GRID_COLUMNS,
  type AlphaGridItem,
  type AlphaSymbolBinding,
  type AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import GridLayout, {
  type Layout,
  type EventCallback,
  useContainerWidth,
} from "react-grid-layout";
import {
  ALPHA_GRID_ROW_HEIGHT,
  ALPHA_GRID_GAP,
  ALPHA_PANEL_HEADER_HEIGHT,
  alphaPanelBodyHeight,
} from "@/modules/alpha/workstation/panelGeometry";
import { noOverlapCompactor } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import { useCallback, useMemo, useEffect, useRef } from "react";

export const ALPHA_WORKSTATION_MIN_GRID_WIDTH = 1200;

type Props = {
  state: AlphaWorkstationState;
  registry: AlphaPanelRegistry;
  onGridItemCommit: (item: AlphaGridItem) => void;
  onBindingChange: (panelId: string, binding: AlphaSymbolBinding) => void;
  onRemovePanel: (panelId: string) => void;
  onToggleCollapsed: (panelId: string) => void;
  onRaisePanel: (panelId: string) => void;
  revealRequest: { panelId: string } | null;
};

/** 渲染固定列数的工作台网格，并把最终交互结果转换回公共布局协议。 */
export function AlphaPanelGrid({
  state,
  registry,
  onGridItemCommit,
  onBindingChange,
  onRemovePanel,
  onToggleCollapsed,
  onRaisePanel,
  revealRequest,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { width, containerRef, mounted } = useContainerWidth({
    initialWidth: ALPHA_WORKSTATION_MIN_GRID_WIDTH,
  });
  const geometryById = useMemo(
    () =>
      new Map(
        state.layout.grid.map((item, index) => [
          item.panelId,
          { zIndex: index + 1, bodyHeight: alphaPanelBodyHeight(item.h) },
        ]),
      ),
    [state.layout.grid],
  );
  const layout = useMemo<Layout>(() => {
    const panelsById = new Map(
      state.layout.panels.map((panel) => [panel.id, panel] as const),
    );
    return state.layout.grid.map((item) => {
      const panel = panelsById.get(item.panelId);
      const descriptor = registry.get(panel?.type ?? "");
      return {
        i: item.panelId,
        x: item.x,
        y: item.y,
        w: item.w,
        h: panel?.collapsed ? 1 : item.h,
        minW: descriptor?.defaultSize.minW,
        minH: panel?.collapsed ? 1 : descriptor?.defaultSize.minH,
        isResizable: !state.locked && !panel?.collapsed,
      };
    });
  }, [registry, state.layout.grid, state.layout.panels, state.locked]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // 面板内容经 portal 挂载，原生捕获才能同时覆盖标题栏与业务子树。
    const activate = (event: Event) => {
      const panel =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-alpha-workstation-panel]")
          : null;
      if (panel?.dataset.alphaWorkstationPanel)
        onRaisePanel(panel.dataset.alphaWorkstationPanel);
    };
    viewport.addEventListener("pointerdown", activate, true);
    viewport.addEventListener("focusin", activate, true);
    return () => {
      viewport.removeEventListener("pointerdown", activate, true);
      viewport.removeEventListener("focusin", activate, true);
    };
  }, [onRaisePanel]);

  useEffect(() => {
    if (!revealRequest || !mounted) return;
    const viewport = viewportRef.current;
    const panel = Array.from(
      viewport?.querySelectorAll<HTMLElement>(
        "[data-alpha-workstation-panel]",
      ) ?? [],
    ).find(
      (element) =>
        element.dataset.alphaWorkstationPanel === revealRequest.panelId,
    );
    if (!viewport || !panel) return;
    const bounds = viewport.getBoundingClientRect();
    const title = panel.getBoundingClientRect();
    // 只滚动工作台视口，保证标题栏可达，不让大面板把标题滚出屏幕。
    if (
      title.top < bounds.top ||
      title.top + ALPHA_PANEL_HEADER_HEIGHT > bounds.top + viewport.clientHeight
    )
      viewport.scrollTop += title.top - bounds.top;
    if (
      title.left < bounds.left ||
      title.right > bounds.left + viewport.clientWidth
    )
      viewport.scrollLeft += title.left - bounds.left;
  }, [revealRequest, mounted]);

  const commit = useCallback<EventCallback>(
    (_layout, _oldItem, item) => {
      if (!item) return;
      // 自由布局没有联动重排，仅提交本次操作对象，避免回写其他面板的旧坐标。
      onGridItemCommit({
        panelId: item.i,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      });
    },
    [onGridItemCommit],
  );

  return (
    <div
      ref={viewportRef}
      className="isolate min-h-0 flex-1 overflow-auto bg-muted/20"
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
            compactor={noOverlapCompactor}
            gridConfig={{
              cols: ALPHA_WORKSTATION_GRID_COLUMNS,
              rowHeight: ALPHA_GRID_ROW_HEIGHT,
              margin: [ALPHA_GRID_GAP, ALPHA_GRID_GAP],
              containerPadding: [4, 4],
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
                className="pointer-events-none min-h-0 min-w-0"
                style={{
                  zIndex: geometryById.get(panel.id)?.zIndex,
                }}
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
                  onToggleCollapsed={() => onToggleCollapsed(panel.id)}
                />
                <AlphaPanelBody
                  panelId={panel.id}
                  collapsed={!!panel.collapsed}
                  height={geometryById.get(panel.id)?.bodyHeight ?? 0}
                />
              </section>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
