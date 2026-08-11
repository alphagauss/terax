/**
 * 本文件提供统一的主副侧边栏布局控制器。
 * 容器位置和顺序跨进程共享，激活项、折叠状态与宽度仅属于当前 Workspace 窗口。
 */

import {
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { getSidebarContainer, SIDEBAR_CONTAINERS } from "./containers";
import {
  clampPanelWidth,
  PRIMARY_SIDEBAR_MIN_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
} from "./layout";
import {
  findSidebarContainerLocation,
  moveSidebarContainer,
  normalizeSidebarRuntimeState,
  runtimeAfterSidebarContainerMove,
} from "./model";
import {
  getInitialSidebarPlacementState,
  persistSidebarPlacementState,
  subscribeSidebarPlacementState,
} from "./persistence";
import type {
  ActivityBarPosition,
  ActivityBarSize,
  SidebarContainerId,
  SidebarLocation,
  SidebarPlacementState,
  SidebarRuntimeState,
} from "./types";

const RUNTIME_STORAGE_KEY = "sidebar-layout:runtime";

type RuntimeUpdater = (current: SidebarRuntimeState) => SidebarRuntimeState;

/**
 * 控制容器激活、位置移动、区域折叠和最终尺寸持久化。
 * 临时隐藏期间拒绝可见性操作且不改写持久状态，退出后按原状态恢复布局。
 */
export function useSidebarLayout(
  unavailableContainerIds: readonly SidebarContainerId[] = [],
  temporarilyHidden = false,
) {
  const unavailable = useMemo(
    () => new Set(unavailableContainerIds),
    [unavailableContainerIds],
  );
  const effectiveHiddenIds = useCallback(
    (hidden: readonly SidebarContainerId[]) => [
      ...new Set([...hidden, ...unavailable]),
    ],
    [unavailable],
  );
  const [initialPlacementState] = useState(getInitialSidebarPlacementState);
  const [placementState, setPlacementState] = useState(initialPlacementState);
  const [initialRuntime] = useState(() =>
    normalizeSidebarRuntimeState(
      getWorkspaceValue<unknown>(RUNTIME_STORAGE_KEY),
      initialPlacementState.placements,
      effectiveHiddenIds(initialPlacementState.activityBar.hiddenContainerIds),
    ),
  );
  const [runtime, setRuntime] = useState(initialRuntime);
  const primaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const secondaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const placementsRef = useRef(placementState.placements);
  const placementStateRef = useRef(placementState);
  const runtimeRef = useRef(runtime);
  const temporarilyHiddenRef = useRef(temporarilyHidden);
  const previousTemporarilyHiddenRef = useRef(false);
  placementsRef.current = placementState.placements;
  placementStateRef.current = placementState;
  runtimeRef.current = runtime;
  temporarilyHiddenRef.current = temporarilyHidden;

  const panelRefs = useMemo(
    () =>
      ({
        primary: primaryPanelRef,
        secondary: secondaryPanelRef,
      }) as const,
    [],
  );

  const replaceRuntime = useCallback((updater: RuntimeUpdater) => {
    const current = runtimeRef.current;
    const next = updater(current);
    if (next === current) return;
    runtimeRef.current = next;
    setRuntime(next);
    void setWorkspaceValue(RUNTIME_STORAGE_KEY, next);
  }, []);

  const revealLocation = useCallback(
    (location: SidebarLocation, activeId?: SidebarContainerId) => {
      if (temporarilyHiddenRef.current) return;
      const current = runtimeRef.current[location];
      const nextActiveId =
        activeId ??
        current.activeId ??
        placementsRef.current[location][0] ??
        null;
      if (!nextActiveId) return;
      const width = Math.max(
        current.width,
        getSidebarContainer(nextActiveId).minimumWidth,
      );
      panelRefs[location].current?.resize(`${width}px`);
    },
    [panelRefs],
  );

  const closeLocation = useCallback(
    (location: SidebarLocation) => {
      if (temporarilyHiddenRef.current) return false;
      panelRefs[location].current?.collapse();
      replaceRuntime((current) => ({
        ...current,
        [location]: { ...current[location], collapsed: true },
      }));
      return true;
    },
    [panelRefs, replaceRuntime],
  );

  const openContainer = useCallback(
    (id: SidebarContainerId) => {
      if (temporarilyHiddenRef.current) return false;
      const location = findSidebarContainerLocation(placementsRef.current, id);
      replaceRuntime((current) => ({
        ...current,
        [location]: {
          ...current[location],
          activeId: id,
          collapsed: false,
        },
      }));
      revealLocation(location, id);
      return true;
    },
    [replaceRuntime, revealLocation],
  );

  const toggleContainer = useCallback(
    (id: SidebarContainerId) => {
      if (temporarilyHiddenRef.current) return false;
      const location = findSidebarContainerLocation(placementsRef.current, id);
      const current = runtimeRef.current[location];
      if (current.activeId === id && !current.collapsed) {
        return closeLocation(location);
      }
      return openContainer(id);
    },
    [closeLocation, openContainer],
  );

  const toggleLocation = useCallback(
    (location: SidebarLocation) => {
      if (temporarilyHiddenRef.current) return false;
      const current = runtimeRef.current[location];
      if (!current.collapsed) {
        return closeLocation(location);
      }
      const activeId =
        current.activeId ?? placementsRef.current[location][0] ?? null;
      return activeId ? openContainer(activeId) : false;
    },
    [closeLocation, openContainer],
  );

  const commitPlacementState = useCallback((next: SidebarPlacementState) => {
    placementStateRef.current = next;
    placementsRef.current = next.placements;
    setPlacementState(next);
    void persistSidebarPlacementState(next).catch((error) => {
      console.error("[terax] sidebar layout persistence failed:", error);
    });
  }, []);

  const moveContainer = useCallback(
    (
      id: SidebarContainerId,
      targetLocation: SidebarLocation,
      targetIndex: number,
    ) => {
      const currentPlacements = placementsRef.current;
      const sourceLocation = findSidebarContainerLocation(
        currentPlacements,
        id,
      );
      const nextPlacements = moveSidebarContainer(
        currentPlacements,
        id,
        targetLocation,
        targetIndex,
      );
      if (nextPlacements === currentPlacements) return;
      commitPlacementState({
        ...placementStateRef.current,
        placements: nextPlacements,
      });

      if (sourceLocation === targetLocation) return;
      const nextRuntime = runtimeAfterSidebarContainerMove(
        runtimeRef.current,
        currentPlacements,
        nextPlacements,
        id,
        targetLocation,
        placementStateRef.current.activityBar.hiddenContainerIds,
      );
      replaceRuntime(() => nextRuntime);

      if (nextRuntime[sourceLocation].collapsed) {
        panelRefs[sourceLocation].current?.collapse();
      }
      revealLocation(targetLocation, id);
    },
    [commitPlacementState, panelRefs, replaceRuntime, revealLocation],
  );

  const resetContainerLocation = useCallback(
    (id: SidebarContainerId) => {
      const definition = getSidebarContainer(id);
      const targetIds = placementsRef.current[
        definition.defaultLocation
      ].filter((candidate) => candidate !== id);
      const targetIndex = targetIds.findIndex(
        (candidate) =>
          getSidebarContainer(candidate).defaultOrder > definition.defaultOrder,
      );
      moveContainer(
        id,
        definition.defaultLocation,
        targetIndex < 0 ? targetIds.length : targetIndex,
      );
    },
    [moveContainer],
  );

  const toggleContainerVisibility = useCallback(
    (id: SidebarContainerId) => {
      const current = placementStateRef.current;
      const hidden = current.activityBar.hiddenContainerIds;
      const hiddenContainerIds = hidden.includes(id)
        ? hidden.filter((candidate) => candidate !== id)
        : [...hidden, id];
      commitPlacementState({
        ...current,
        activityBar: {
          ...current.activityBar,
          hiddenContainerIds,
        },
      });
      if (hidden.includes(id)) return;

      const location = findSidebarContainerLocation(current.placements, id);
      if (runtimeRef.current[location].activeId !== id) return;
      const nextRuntime = normalizeSidebarRuntimeState(
        runtimeRef.current,
        current.placements,
        effectiveHiddenIds(hiddenContainerIds),
      );
      replaceRuntime(() => nextRuntime);
      if (nextRuntime[location].collapsed) {
        panelRefs[location].current?.collapse();
      } else {
        revealLocation(location, nextRuntime[location].activeId ?? undefined);
      }
    },
    [
      commitPlacementState,
      effectiveHiddenIds,
      panelRefs,
      replaceRuntime,
      revealLocation,
    ],
  );

  const setActivityBarPosition = useCallback(
    (position: ActivityBarPosition) => {
      const current = placementStateRef.current;
      commitPlacementState({
        ...current,
        activityBar: { ...current.activityBar, position },
      });
    },
    [commitPlacementState],
  );

  const setActivityBarSize = useCallback(
    (size: ActivityBarSize) => {
      const current = placementStateRef.current;
      commitPlacementState({
        ...current,
        activityBar: { ...current.activityBar, size },
      });
    },
    [commitPlacementState],
  );

  const commitLayout = useCallback(() => {
    if (temporarilyHiddenRef.current) return;
    replaceRuntime((current) => {
      const next: SidebarRuntimeState = {
        ...current,
        primary: { ...current.primary },
        secondary: { ...current.secondary },
      };
      for (const location of ["primary", "secondary"] as const) {
        const size = panelRefs[location].current?.getSize().inPixels ?? 0;
        next[location].collapsed = size <= 0;
        if (size > 0) {
          const baseMin =
            location === "primary"
              ? PRIMARY_SIDEBAR_MIN_WIDTH
              : SECONDARY_SIDEBAR_MIN_WIDTH;
          next[location].width = clampPanelWidth(size, baseMin);
        }
      }
      return next;
    });
  }, [panelRefs, replaceRuntime]);

  const minimumWidth = useCallback(
    (location: SidebarLocation) => {
      const activeId = runtime[location].activeId;
      const base =
        location === "primary"
          ? PRIMARY_SIDEBAR_MIN_WIDTH
          : SECONDARY_SIDEBAR_MIN_WIDTH;
      return activeId
        ? Math.max(base, getSidebarContainer(activeId).minimumWidth)
        : base;
    },
    [runtime],
  );

  const isVisible = useCallback(
    (id: SidebarContainerId) => {
      if (temporarilyHidden) return false;
      const location = findSidebarContainerLocation(
        placementState.placements,
        id,
      );
      return runtime[location].activeId === id && !runtime[location].collapsed;
    },
    [placementState.placements, runtime, temporarilyHidden],
  );

  useLayoutEffect(() => {
    if (previousTemporarilyHiddenRef.current === temporarilyHidden) return;
    previousTemporarilyHiddenRef.current = temporarilyHidden;
    for (const location of ["primary", "secondary"] as const) {
      if (temporarilyHidden || runtimeRef.current[location].collapsed) {
        panelRefs[location].current?.collapse();
      } else {
        revealLocation(
          location,
          runtimeRef.current[location].activeId ?? undefined,
        );
      }
    }
  }, [panelRefs, revealLocation, temporarilyHidden]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeSidebarPlacementState((next) => {
      if (cancelled) return;
      placementStateRef.current = next;
      placementsRef.current = next.placements;
      setPlacementState(next);
      const nextRuntime = normalizeSidebarRuntimeState(
        runtimeRef.current,
        next.placements,
        effectiveHiddenIds(next.activityBar.hiddenContainerIds),
      );
      replaceRuntime(() => nextRuntime);
      requestAnimationFrame(() => {
        for (const location of ["primary", "secondary"] as const) {
          if (nextRuntime[location].collapsed) {
            panelRefs[location].current?.collapse();
          } else {
            revealLocation(
              location,
              nextRuntime[location].activeId ?? undefined,
            );
          }
        }
      });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else dispose = unlisten;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [effectiveHiddenIds, panelRefs, replaceRuntime, revealLocation]);

  useEffect(() => {
    const nextRuntime = normalizeSidebarRuntimeState(
      runtimeRef.current,
      placementStateRef.current.placements,
      effectiveHiddenIds(
        placementStateRef.current.activityBar.hiddenContainerIds,
      ),
    );
    replaceRuntime(() => nextRuntime);
  }, [effectiveHiddenIds, replaceRuntime]);

  const availableContainers = useMemo(
    () =>
      SIDEBAR_CONTAINERS.filter((container) => !unavailable.has(container.id)),
    [unavailable],
  );
  const availablePlacements = useMemo(
    () => ({
      primary: placementState.placements.primary.filter(
        (id) => !unavailable.has(id),
      ),
      secondary: placementState.placements.secondary.filter(
        (id) => !unavailable.has(id),
      ),
    }),
    [placementState.placements, unavailable],
  );

  return {
    containers: availableContainers,
    placements: availablePlacements,
    activityBar: placementState.activityBar,
    runtime,
    initialRuntime,
    panelRefs,
    openContainer,
    toggleContainer,
    toggleLocation,
    closeLocation,
    moveContainer,
    resetContainerLocation,
    toggleContainerVisibility,
    setActivityBarPosition,
    setActivityBarSize,
    commitLayout,
    minimumWidth,
    isVisible,
  };
}
