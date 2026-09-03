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
import type {
  GroupImperativeHandle,
  Layout,
  PanelImperativeHandle,
} from "react-resizable-panels";
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
 * 副侧边栏最大化只改变三栏呈现比例，不覆盖用户保存的侧边栏宽度和折叠状态。
 * 临时隐藏期间拒绝可见性操作且不改写持久状态，退出后按原状态恢复布局。
 * 新建临时窗口可在尚无运行时状态时折叠两侧，之后仍遵循窗口自身的持久状态。
 */
export function useSidebarLayout(
  unavailableContainerIds: readonly SidebarContainerId[] = [],
  temporarilyHidden = false,
  collapseOnInitialOpen = false,
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
  const [initialRuntime] = useState(() => {
    const storedRuntime = getWorkspaceValue<unknown>(RUNTIME_STORAGE_KEY);
    const normalized = normalizeSidebarRuntimeState(
      storedRuntime,
      initialPlacementState.placements,
      effectiveHiddenIds(initialPlacementState.activityBar.hiddenContainerIds),
    );
    if (!collapseOnInitialOpen || storedRuntime !== undefined) return normalized;
    return {
      ...normalized,
      primary: { ...normalized.primary, collapsed: true },
      secondary: { ...normalized.secondary, collapsed: true },
    };
  });
  const [runtime, setRuntime] = useState(initialRuntime);
  const workbenchGroupRef = useRef<GroupImperativeHandle | null>(null);
  const preMaximizedLayoutRef = useRef<Layout | null>(null);
  const pendingRestoreLayoutRef = useRef<Layout | null>(null);
  const primaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const secondaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const placementsRef = useRef(placementState.placements);
  const placementStateRef = useRef(placementState);
  const runtimeRef = useRef(runtime);
  const temporarilyHiddenRef = useRef(temporarilyHidden);
  const previousPresentationRef = useRef({
    temporarilyHidden: false,
    secondaryMaximized: false,
  });
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

  /** 按运行时记录恢复两侧宽度，工作区自动占据剩余空间。 */
  const restoreRuntimeLayout = useCallback(
    (nextRuntime: SidebarRuntimeState) => {
      for (const location of ["secondary", "primary"] as const) {
        if (nextRuntime[location].collapsed) {
          panelRefs[location].current?.collapse();
        } else {
          panelRefs[location].current?.resize(
            `${nextRuntime[location].width}px`,
          );
        }
      }
    },
    [panelRefs],
  );

  /** 让副侧边栏独占可调整面板组，外层活动栏不受影响。 */
  const maximizeSecondaryLayout = useCallback(() => {
    workbenchGroupRef.current?.setLayout({
      "primary-sidebar": 0,
      workspace: 0,
      "secondary-sidebar": 100,
    });
  }, []);

  const closeLocation = useCallback(
    (location: SidebarLocation) => {
      if (temporarilyHiddenRef.current) return false;
      if (location === "secondary") pendingRestoreLayoutRef.current = null;
      panelRefs[location].current?.collapse();
      replaceRuntime((current) => ({
        ...current,
        [location]: { ...current[location], collapsed: true },
        secondaryMaximized:
          location === "secondary" ? false : current.secondaryMaximized,
      }));
      return true;
    },
    [panelRefs, replaceRuntime],
  );

  const openContainer = useCallback(
    (id: SidebarContainerId) => {
      if (temporarilyHiddenRef.current) return false;
      const location = findSidebarContainerLocation(placementsRef.current, id);
      if (location === "primary") pendingRestoreLayoutRef.current = null;
      replaceRuntime((current) => ({
        ...current,
        [location]: {
          ...current[location],
          activeId: id,
          collapsed: false,
        },
        secondaryMaximized:
          location === "primary" ? false : current.secondaryMaximized,
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
      if (location === "primary" && runtimeRef.current.secondaryMaximized) {
        return openContainer(id);
      }
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
      if (location === "primary" && runtimeRef.current.secondaryMaximized) {
        const activeId =
          current.activeId ?? placementsRef.current.primary[0] ?? null;
        return activeId ? openContainer(activeId) : false;
      }
      if (!current.collapsed) {
        return closeLocation(location);
      }
      const activeId =
        current.activeId ?? placementsRef.current[location][0] ?? null;
      return activeId ? openContainer(activeId) : false;
    },
    [closeLocation, openContainer],
  );

  /** 捕获完整三栏比例，并在副侧边栏独占主区域和原布局之间切换。 */
  const toggleSecondaryMaximized = useCallback(() => {
    if (temporarilyHiddenRef.current) return false;
    const current = runtimeRef.current;
    if (current.secondary.collapsed) return false;
    const maximizing = !current.secondaryMaximized;
    if (maximizing) {
      const layout = workbenchGroupRef.current?.getLayout();
      preMaximizedLayoutRef.current = layout ? { ...layout } : null;
      pendingRestoreLayoutRef.current = null;
    } else {
      pendingRestoreLayoutRef.current = preMaximizedLayoutRef.current;
    }
    replaceRuntime((previous) => {
      if (!maximizing) {
        return { ...previous, secondaryMaximized: false };
      }
      const next: SidebarRuntimeState = {
        ...previous,
        primary: { ...previous.primary },
        secondary: { ...previous.secondary },
        secondaryMaximized: true,
      };
      for (const location of ["primary", "secondary"] as const) {
        const size = panelRefs[location].current?.getSize().inPixels ?? 0;
        if (size <= 0) continue;
        const baseMin =
          location === "primary"
            ? PRIMARY_SIDEBAR_MIN_WIDTH
            : SECONDARY_SIDEBAR_MIN_WIDTH;
        next[location].width = clampPanelWidth(size, baseMin);
      }
      return next;
    });
    return true;
  }, [panelRefs, replaceRuntime]);

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
      pendingRestoreLayoutRef.current = null;
      const movedRuntime = runtimeAfterSidebarContainerMove(
        runtimeRef.current,
        currentPlacements,
        nextPlacements,
        id,
        targetLocation,
        placementStateRef.current.activityBar.hiddenContainerIds,
      );
      const nextRuntime = movedRuntime.secondaryMaximized
        ? { ...movedRuntime, secondaryMaximized: false }
        : movedRuntime;
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
    if (temporarilyHiddenRef.current || runtimeRef.current.secondaryMaximized) {
      return;
    }
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
      return (
        (!runtime.secondaryMaximized || location === "secondary") &&
        runtime[location].activeId === id &&
        !runtime[location].collapsed
      );
    },
    [placementState.placements, runtime, temporarilyHidden],
  );

  useLayoutEffect(() => {
    const nextPresentation = {
      temporarilyHidden,
      secondaryMaximized: runtime.secondaryMaximized,
    };
    const previous = previousPresentationRef.current;
    if (
      previous.temporarilyHidden === nextPresentation.temporarilyHidden &&
      previous.secondaryMaximized === nextPresentation.secondaryMaximized
    ) {
      return;
    }
    previousPresentationRef.current = nextPresentation;
    if (temporarilyHidden) {
      if (previous.secondaryMaximized) {
        // 与解除最大化同批进入禅模式时，等待动态约束更新后再让工作区独占布局。
        const frame = requestAnimationFrame(() => {
          workbenchGroupRef.current?.setLayout({
            "primary-sidebar": 0,
            workspace: 100,
            "secondary-sidebar": 0,
          });
        });
        return () => cancelAnimationFrame(frame);
      }
      panelRefs.primary.current?.collapse();
      panelRefs.secondary.current?.collapse();
    } else if (runtime.secondaryMaximized) {
      maximizeSecondaryLayout();
    } else {
      const capturedLayout = pendingRestoreLayoutRef.current;
      pendingRestoreLayoutRef.current = null;
      preMaximizedLayoutRef.current = null;
      const restore = () => {
        if (capturedLayout) {
          workbenchGroupRef.current?.setLayout(capturedLayout);
        } else {
          restoreRuntimeLayout(runtimeRef.current);
        }
      };
      if (
        !previous.temporarilyHidden &&
        !previous.secondaryMaximized &&
        !capturedLayout
      ) {
        restore();
        return;
      }

      // 等待动态约束和原生全屏 resize 都稳定后，再按完整比例恢复三栏。
      let restoreFrame = 0;
      const settleFrame = requestAnimationFrame(() => {
        restoreFrame = requestAnimationFrame(restore);
      });
      return () => {
        cancelAnimationFrame(settleFrame);
        cancelAnimationFrame(restoreFrame);
      };
    }
  }, [
    panelRefs,
    maximizeSecondaryLayout,
    restoreRuntimeLayout,
    runtime.secondaryMaximized,
    temporarilyHidden,
  ]);

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
        if (temporarilyHiddenRef.current) return;
        if (nextRuntime.secondaryMaximized) {
          maximizeSecondaryLayout();
        } else {
          restoreRuntimeLayout(nextRuntime);
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
  }, [
    effectiveHiddenIds,
    maximizeSecondaryLayout,
    replaceRuntime,
    restoreRuntimeLayout,
  ]);

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
    workbenchGroupRef,
    panelRefs,
    openContainer,
    toggleContainer,
    toggleLocation,
    toggleSecondaryMaximized,
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
