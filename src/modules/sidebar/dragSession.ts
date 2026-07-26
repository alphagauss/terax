/**
 * 本文件管理侧边栏容器的跨导航栏拖放会话。
 * 指针移动只更新临时落点，容器布局仅在释放指针时提交一次。
 */

import { useSyncExternalStore } from "react";
import type { SidebarContainerId, SidebarLocation } from "./types";

export type SidebarDropTarget = {
  location: SidebarLocation;
  index: number;
};

type SidebarRect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

type SidebarDropRegion = {
  location: SidebarLocation;
  barRect: SidebarRect;
  zoneRect?: SidebarRect;
};

type SidebarDragSnapshot = {
  draggedId: SidebarContainerId | null;
  target: SidebarDropTarget | null;
};

type ActiveDrag = {
  id: SidebarContainerId;
  sourceLocation: SidebarLocation;
  allowedLocations: readonly SidebarLocation[];
  bars: SidebarDragBar[];
  commit: (
    id: SidebarContainerId,
    location: SidebarLocation,
    index: number,
  ) => void;
};

type SidebarDragBar = SidebarDropRegion & {
  orientation: "horizontal" | "vertical";
  items: Array<{
    id: string;
    rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  }>;
};

const EMPTY: SidebarDragSnapshot = { draggedId: null, target: null };
let active: ActiveDrag | null = null;
let snapshot = EMPTY;
let dragPreview: HTMLElement | null = null;
let previousCursor: string | null = null;
let previousDraggingAttribute: string | null = null;
const listeners = new Set<() => void>();

function sameTarget(
  left: SidebarDropTarget | null,
  right: SidebarDropTarget | null,
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.location === right.location &&
      left.index === right.index)
  );
}

function emit(next: SidebarDragSnapshot): void {
  if (
    snapshot.draggedId === next.draggedId &&
    sameTarget(snapshot.target, next.target)
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function createDragPreview(source: HTMLElement): void {
  const preview = document.createElement("div");
  preview.className =
    "pointer-events-none fixed top-0 left-0 z-[100] flex size-9 items-center justify-center rounded-lg border border-border/70 bg-popover/95 text-foreground opacity-0 shadow-lg";
  preview.setAttribute("aria-hidden", "true");
  const icon = source.querySelector("svg")?.cloneNode(true);
  if (icon instanceof SVGElement) {
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    preview.append(icon);
  }
  document.body.append(preview);
  dragPreview = preview;
  previousCursor = document.documentElement.style.cursor;
  previousDraggingAttribute = document.documentElement.getAttribute(
    "data-sidebar-dragging",
  );
  document.documentElement.dataset.sidebarDragging = "true";
  document.documentElement.style.cursor = "default";
}

function moveDragPreview(clientX: number, clientY: number): void {
  if (!dragPreview) return;
  dragPreview.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0)`;
  dragPreview.style.opacity = "1";
}

function removeDragPreview(): void {
  dragPreview?.remove();
  dragPreview = null;
  if (previousCursor) {
    document.documentElement.style.cursor = previousCursor;
  } else {
    document.documentElement.style.removeProperty("cursor");
  }
  if (previousDraggingAttribute === null) {
    delete document.documentElement.dataset.sidebarDragging;
  } else {
    document.documentElement.dataset.sidebarDragging =
      previousDraggingAttribute;
  }
  previousCursor = null;
  previousDraggingAttribute = null;
}

/** 根据导航方向和指针位置计算原始插入间隙。 */
export function sidebarGapForPoint(
  rects: readonly Pick<DOMRect, "left" | "top" | "width" | "height">[],
  orientation: "horizontal" | "vertical",
  clientX: number,
  clientY: number,
): number {
  const coordinate = orientation === "vertical" ? clientY : clientX;
  const index = rects.findIndex((rect) => {
    const start = orientation === "vertical" ? rect.top : rect.left;
    const size = orientation === "vertical" ? rect.height : rect.width;
    return coordinate < start + size / 2;
  });
  return index < 0 ? rects.length : index;
}

function containsPoint(
  rect: SidebarRect,
  clientX: number,
  clientY: number,
): boolean {
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

/**
 * 解析拖放位置。
 *
 * 导航栏精确命中始终优先；只有跨侧栏移动时才扩展到整个目标侧栏，
 * 避免同栏排序在内容区产生意外落点。
 */
export function sidebarDropLocationForPoint(
  regions: readonly SidebarDropRegion[],
  sourceLocation: SidebarLocation,
  clientX: number,
  clientY: number,
): SidebarLocation | null {
  const barLocation = regions.find(({ barRect }) =>
    containsPoint(barRect, clientX, clientY),
  )?.location;
  if (barLocation) return barLocation;
  return (
    regions.find(
      ({ location, zoneRect }) =>
        location !== sourceLocation &&
        zoneRect &&
        containsPoint(zoneRect, clientX, clientY),
    )?.location ?? null
  );
}

/** 将原始 DOM 间隙转换为移除源图标后的模型插入索引。 */
export function sidebarInsertionIndexForDrop(
  target: SidebarDropTarget,
  sourceLocation: SidebarLocation,
  sourceIndex: number,
): number {
  return target.location === sourceLocation &&
    sourceIndex >= 0 &&
    target.index > sourceIndex
    ? target.index - 1
    : target.index;
}

function collectDragGeometry(): SidebarDragBar[] {
  const bars: SidebarDragBar[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-sidebar-drop-location]",
  )) {
    const location = element.dataset.sidebarDropLocation;
    if (location !== "primary" && location !== "secondary") continue;
    const zone = document.querySelector<HTMLElement>(
      `[data-sidebar-drop-zone="${location}"]`,
    );
    bars.push({
      location,
      barRect: element.getBoundingClientRect(),
      zoneRect: zone?.getBoundingClientRect(),
      orientation:
        element.dataset.sidebarOrientation === "vertical"
          ? "vertical"
          : "horizontal",
      items: Array.from(
        element.querySelectorAll<HTMLElement>("[data-sidebar-container-id]"),
        (item) => ({
          id: item.dataset.sidebarContainerId ?? "",
          rect: item.getBoundingClientRect(),
        }),
      ),
    });
  }
  return bars;
}

function resolveTarget(
  clientX: number,
  clientY: number,
): SidebarDropTarget | null {
  const session = active;
  if (!session) return null;
  const allowedBars = session.bars.filter((bar) =>
    session.allowedLocations.includes(bar.location),
  );
  const location = sidebarDropLocationForPoint(
    allowedBars,
    session.sourceLocation,
    clientX,
    clientY,
  );
  if (!location) return null;
  const bar = allowedBars.find((candidate) => candidate.location === location);
  if (!bar) return null;
  const index = sidebarGapForPoint(
    bar.items.map((item) => item.rect),
    bar.orientation,
    clientX,
    clientY,
  );

  return { location, index };
}

/** 开始一个容器拖动事务。 */
export function beginSidebarDrag(
  id: SidebarContainerId,
  sourceLocation: SidebarLocation,
  allowedLocations: readonly SidebarLocation[],
  commit: ActiveDrag["commit"],
  previewSource: HTMLElement,
): void {
  removeDragPreview();
  active = {
    id,
    sourceLocation,
    allowedLocations,
    commit,
    bars: collectDragGeometry(),
  };
  createDragPreview(previewSource);
  emit({ draggedId: id, target: null });
}

/** 根据当前指针命中元素更新临时插入位置。 */
export function updateSidebarDrag(
  clientX: number,
  clientY: number,
): SidebarDropTarget | null {
  moveDragPreview(clientX, clientY);
  const target = resolveTarget(clientX, clientY);
  emit({ draggedId: active?.id ?? null, target });
  return target;
}

/** 结束拖放，并按需提交唯一一次布局变更。 */
export function finishSidebarDrag(commit: boolean): boolean {
  const session = active;
  const target = snapshot.target;
  active = null;
  removeDragPreview();
  emit(EMPTY);
  if (!commit || !session || !target) return false;
  const sourceBar = session.bars.find(
    (bar) => bar.location === session.sourceLocation,
  );
  const sourceIndex =
    sourceBar?.items.findIndex((item) => item.id === session.id) ?? -1;
  const insertionIndex = sidebarInsertionIndexForDrop(
    target,
    session.sourceLocation,
    sourceIndex,
  );
  session.commit(session.id, target.location, insertionIndex);
  return true;
}

/** 订阅拖放预览，用于渲染插入指示器。 */
export function useSidebarDragSnapshot(): SidebarDragSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}
