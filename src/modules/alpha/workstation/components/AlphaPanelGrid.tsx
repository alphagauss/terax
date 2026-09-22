/**
 * 本文件实现 Alpha 工作台固定步长、按视口和内容扩展的拖拽画布。
 * 网格只在拖动或缩放结束时提交几何坐标，并通过稳定宿主挂载业务面板。
 */

import { AlphaPanelChrome } from "@/modules/alpha/workstation/components/AlphaPanelChrome";
import { AlphaPanelBody } from "@/modules/alpha/workstation/components/AlphaPanelBody";
import type {
  AlphaGridItem,
  AlphaSymbolBinding,
  AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import GridLayout, { type Layout, type EventCallback } from "react-grid-layout";
import {
  ALPHA_GRID_ROW_HEIGHT,
  alphaCanvasGeometry,
  ALPHA_GRID_PADDING,
  ALPHA_GRID_GAP,
  ALPHA_PANEL_HEADER_HEIGHT,
  ALPHA_PANEL_COLLAPSED_ROWS,
  alphaPanelBodyHeight,
} from "@/modules/alpha/workstation/panelGeometry";
import { noOverlapCompactor } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import {
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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

/** 保持网格像素步长稳定，只在操作结束时提交面板几何。 */
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
  const [viewportWidth, setViewportWidth] = useState(0);
  const [reservedColumns, setReservedColumns] = useState(0);
  const canvas = useMemo(
    () =>
      alphaCanvasGeometry(viewportWidth, state.layout.grid, reservedColumns),
    [viewportWidth, state.layout.grid, reservedColumns],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // 只测量视口。画布和列数一起改变，不让侧边栏动画驱动图表尺寸变化。
    const measure = () => setViewportWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const extendCanvas = useCallback<EventCallback>(
    (_layout, _oldItem, item) => {
      if (!item) return;
      // 交互期间不收窄画布，接近右边缘时再按块扩展，避免逐格重建网格配置。
      const columns =
        item.x + item.w >= canvas.columns - 2
          ? item.x + item.w + 16
          : canvas.columns;
      setReservedColumns((current) => Math.max(current, columns));
    },
    [canvas.columns],
  );
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
        h: panel?.collapsed ? ALPHA_PANEL_COLLAPSED_ROWS : item.h,
        minW: descriptor?.defaultSize.minW,
        minH: panel?.collapsed
          ? ALPHA_PANEL_COLLAPSED_ROWS
          : descriptor?.defaultSize.minH,
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
    if (!revealRequest) return;
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
  }, [revealRequest]);

  const commit = useCallback<EventCallback>(
    (_layout, _oldItem, item) => {
      setReservedColumns(0);
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
      <div className="min-h-full" style={{ width: canvas.width }}>
        <GridLayout
          className="alpha-workstation-grid"
          width={canvas.gridWidth}
          layout={layout}
          compactor={noOverlapCompactor}
          gridConfig={{
            cols: canvas.columns,
            rowHeight: ALPHA_GRID_ROW_HEIGHT,
            margin: [ALPHA_GRID_GAP, ALPHA_GRID_GAP],
            containerPadding: [ALPHA_GRID_PADDING, ALPHA_GRID_PADDING],
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
          onDragStart={extendCanvas}
          onDrag={extendCanvas}
          onResizeStart={extendCanvas}
          onResize={extendCanvas}
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
      </div>
    </div>
  );
}
