import { useSyncExternalStore } from "react";

export type WorkbenchDragPayload =
  | { kind: "tab"; tabId: number }
  | { kind: "resource"; path: string };

export type WorkbenchDropTarget =
  | { kind: "tabs"; groupId: number; gap: number }
  | {
      kind: "group";
      groupId: number;
      zone: "center" | "up" | "down" | "left" | "right";
    };

export type WorkbenchDragSnapshot = {
  payload: WorkbenchDragPayload | null;
  target: WorkbenchDropTarget | null;
};

type ActiveDrag = {
  payload: WorkbenchDragPayload;
  commit: (payload: WorkbenchDragPayload, target: WorkbenchDropTarget) => void;
};

const EMPTY: WorkbenchDragSnapshot = { payload: null, target: null };
let active: ActiveDrag | null = null;
let snapshot = EMPTY;
const listeners = new Set<() => void>();

function sameTarget(
  left: WorkbenchDropTarget | null,
  right: WorkbenchDropTarget | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "tabs" && right.kind === "tabs") {
    return left.groupId === right.groupId && left.gap === right.gap;
  }
  return (
    left.kind === "group" &&
    right.kind === "group" &&
    left.groupId === right.groupId &&
    left.zone === right.zone
  );
}

function emit(next: WorkbenchDragSnapshot): void {
  if (
    snapshot.payload === next.payload &&
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

export function beginWorkbenchDrag(
  payload: WorkbenchDragPayload,
  commit: ActiveDrag["commit"],
): void {
  active = { payload, commit };
  emit({ payload, target: null });
}

export function updateWorkbenchDrag(
  clientX: number,
  clientY: number,
): WorkbenchDropTarget | null {
  if (!active) return null;
  const target = resolveTarget(clientX, clientY);
  emit({ payload: active.payload, target });
  return target;
}

export function finishWorkbenchDrag(commit: boolean): boolean {
  const session = active;
  const target = snapshot.target;
  active = null;
  emit(EMPTY);
  if (!session || !target) return false;
  if (commit) session.commit(session.payload, target);
  return commit;
}

export function useWorkbenchDragSnapshot(): WorkbenchDragSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}

export function zoneForPoint(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">,
  x: number,
  y: number,
): "center" | "up" | "down" | "left" | "right" {
  if (rect.width <= 0 || rect.height <= 0) return "center";

  const localX = x - rect.left;
  const localY = y - rect.top;
  const edgeX = rect.width * 0.1;
  const edgeY = rect.height * 0.1;
  const insideCenter =
    localX > edgeX &&
    localX < rect.width - edgeX &&
    localY > edgeY &&
    localY < rect.height - edgeY;
  if (insideCenter) return "center";

  if (localX < rect.width / 3) return "left";
  if (localX > (rect.width * 2) / 3) return "right";
  return localY < rect.height / 2 ? "up" : "down";
}

function resolveTarget(x: number, y: number): WorkbenchDropTarget | null {
  const hit = document.elementFromPoint(x, y);
  const group = hit?.closest<HTMLElement>("[data-workbench-group]");
  const groupId = Number(group?.dataset.workbenchGroup);
  if (!group || !Number.isFinite(groupId)) return null;

  const tabBar = hit?.closest<HTMLElement>("[data-workbench-tabbar]");
  if (tabBar && group.contains(tabBar)) {
    const tabs = Array.from(
      tabBar.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    const gap = tabs.findIndex((tab) => {
      const rect = tab.getBoundingClientRect();
      return x < rect.left + rect.width / 2;
    });
    return {
      kind: "tabs",
      groupId,
      gap: gap < 0 ? tabs.length : gap,
    };
  }

  const surface = hit?.closest<HTMLElement>("[data-workbench-drop-surface]");
  if (!surface || !group.contains(surface)) return null;

  return {
    kind: "group",
    groupId,
    zone: zoneForPoint(surface.getBoundingClientRect(), x, y),
  };
}
