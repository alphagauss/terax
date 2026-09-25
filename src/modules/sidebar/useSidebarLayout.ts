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
import {
  PRIMARY_SIDEBAR_MIN_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
  clampPanelWidth,
} from "./layout";
import type {
  ActivityBarPosition,
  ActivityBarSize,
  SidebarContainerId,
  SidebarLocation,
  SidebarPlacementState,
  SidebarRuntimeState,
  SecondarySidebarMode,
} from "./types";

const RUNTIME_STORAGE_KEY = "sidebar-layout:runtime";
const NO_UNAVAILABLE_CONTAINERS: readonly SidebarContainerId[] = [];

type RuntimeUpdater = (current: SidebarRuntimeState) => SidebarRuntimeState;
type FocusedSecondaryMode = Exclude<SecondarySidebarMode, "normal">;

/**
 * 控制容器激活、位置移动、区域折叠和最终尺寸持久化。
 * 副侧边栏放大和最大化只改变三栏呈现比例，不覆盖用户保存的侧边栏宽度和折叠状态。
 * 临时隐藏期间拒绝可见性操作且不改写持久状态，退出后按原状态恢复布局。
 * 新建临时窗口可在尚无运行时状态时折叠两侧，之后仍遵循窗口自身的持久状态。
 */
export function useSidebarLayout(
  unavailableContainerIds: readonly SidebarContainerId[] = NO_UNAVAILABLE_CONTAINERS,
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
  const [restoringSecondaryMode, setRestoringSecondaryMode] =
    useState<FocusedSecondaryMode | null>(null);
  const workbenchGroupRef = useRef<GroupImperativeHandle | null>(null);
  const preSecondaryModeLayoutRef = useRef<Layout | null>(null);
  const pendingRestoreLayoutRef = useRef<Layout | null>(null);
  const secondaryModeLayoutVersionRef = useRef(0);
  const primaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const secondaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const placementsRef = useRef(placementState.placements);
  const placementStateRef = useRef(placementState);
  const runtimeRef = useRef(runtime);
  const restoringSecondaryModeRef = useRef(restoringSecondaryMode);
  const temporarilyHiddenRef = useRef(temporarilyHidden);
  const previousPresentationRef = useRef({
    temporarilyHidden: false,
    secondaryMode: "normal" as SecondarySidebarMode,
    expandedPrimaryCollapsed: null as boolean | null,
  });
  placementsRef.current = placementState.placements;
  placementStateRef.current = placementState;
  runtimeRef.current = runtime;
  restoringSecondaryModeRef.current = restoringSecondaryMode;
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

  useEffect(() => {
    if (!collapseOnInitialOpen) return;
    if (getWorkspaceValue<unknown>(RUNTIME_STORAGE_KEY) !== undefined) return;
    // 首次折叠需要落盘，避免临时窗口后续启动时重复覆盖自己的布局。
    void setWorkspaceValue(RUNTIME_STORAGE_KEY, initialRuntime);
  }, [collapseOnInitialOpen, initialRuntime]);

  const updateRestoringSecondaryMode = useCallback(
    (mode: FocusedSecondaryMode | null) => {
      restoringSecondaryModeRef.current = mode;
      setRestoringSecondaryMode(mode);
    },
    [],
  );

  /** 标记聚焦模式退出，并指定约束更新后要恢复的布局。 */
  const stageSecondaryModeRestore = useCallback(
    (mode: FocusedSecondaryMode, layout: Layout | null = null) => {
      pendingRestoreLayoutRef.current = layout;
      updateRestoringSecondaryMode(mode);
    },
    [updateRestoringSecondaryMode],
  );

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

  /** 隐藏工作区，并按展示模式决定是否保留主侧边栏。 */
  const applySecondaryModeLayout = useCallback(
    (mode: FocusedSecondaryMode) => {
      const layoutVersion = ++secondaryModeLayoutVersionRef.current;
      const group = workbenchGroupRef.current;
      const primaryCollapsed = runtimeRef.current.primary.collapsed;
      const referenceLayout =
        preSecondaryModeLayoutRef.current ?? group?.getLayout();
      const primarySize =
        mode === "expanded" && !primaryCollapsed
          ? Math.max(
              0,
              Math.min(
                100,
                referenceLayout?.["primary-sidebar"] ??
                  panelRefs.primary.current?.getSize().asPercentage ??
                  0,
              ),
            )
          : 0;
      group?.setLayout({
        "primary-sidebar": primarySize,
        workspace: 0,
        "secondary-sidebar": 100 - primarySize,
      });
      if (mode === "expanded") {
        // 面板库会在本次提交中刷新动态约束；微任务在首帧绘制前应用最终主侧栏尺寸。
        queueMicrotask(() => {
          if (
            secondaryModeLayoutVersionRef.current !== layoutVersion ||
            runtimeRef.current.secondaryMode !== "expanded"
          ) {
            return;
          }
          if (runtimeRef.current.primary.collapsed) {
            panelRefs.primary.current?.collapse();
          } else {
            revealLocation("primary");
          }
        });
      }
    },
    [panelRefs, revealLocation],
  );

  /** 在普通布局与两种副侧边栏聚焦模式之间共享捕获和恢复流程。 */
  const setSecondaryMode = useCallback(
    (mode: SecondarySidebarMode) => {
      if (temporarilyHiddenRef.current) return false;
      const current = runtimeRef.current;
      if (current.secondaryMode === mode) return false;
      if (mode !== "normal" && current.secondary.collapsed) return false;

      const enteringFocusedMode =
        current.secondaryMode === "normal" && mode !== "normal";
      let captureWidths = false;
      if (enteringFocusedMode) {
        updateRestoringSecondaryMode(null);
        if (!preSecondaryModeLayoutRef.current) {
          const layout = workbenchGroupRef.current?.getLayout();
          preSecondaryModeLayoutRef.current = layout ? { ...layout } : null;
          captureWidths = true;
        }
        pendingRestoreLayoutRef.current = null;
      } else if (
        mode === "normal" &&
        current.secondaryMode !== "normal"
      ) {
        stageSecondaryModeRestore(
          current.secondaryMode,
          preSecondaryModeLayoutRef.current,
        );
      }

      replaceRuntime((previous) => {
        const next: SidebarRuntimeState = {
          ...previous,
          primary: { ...previous.primary },
          secondary: { ...previous.secondary },
          secondaryMode: mode,
        };
        if (!captureWidths) return next;
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
    },
    [
      panelRefs,
      replaceRuntime,
      stageSecondaryModeRestore,
      updateRestoringSecondaryMode,
    ],
  );

  const toggleSecondaryMode = useCallback(
    (mode: FocusedSecondaryMode) =>
      setSecondaryMode(
        runtimeRef.current.secondaryMode === mode ? "normal" : mode,
      ),
    [setSecondaryMode],
  );

  /** 主侧边栏内容打开工作区页面前，复用普通布局恢复动作。 */
  const restoreSecondaryModeForContainer = useCallback(
    (id: SidebarContainerId) => {
      if (runtimeRef.current.secondaryMode !== "expanded") return false;
      if (
        findSidebarContainerLocation(placementsRef.current, id) !== "primary"
      ) {
        return false;
      }
      return setSecondaryMode("normal");
    },
    [setSecondaryMode],
  );

  const closeLocation = useCallback(
    (location: SidebarLocation) => {
      if (temporarilyHiddenRef.current) return false;
      if (
        location === "secondary" &&
        runtimeRef.current.secondaryMode !== "normal"
      ) {
        stageSecondaryModeRestore(runtimeRef.current.secondaryMode);
      } else if (location === "secondary") {
        pendingRestoreLayoutRef.current = null;
      }
      const deferExpandedPrimaryLayout =
        location === "primary" &&
        runtimeRef.current.secondaryMode === "expanded";
      if (!deferExpandedPrimaryLayout) {
        panelRefs[location].current?.collapse();
      }
      replaceRuntime((current) => ({
        ...current,
        [location]: { ...current[location], collapsed: true },
        secondaryMode:
          location === "secondary" ? "normal" : current.secondaryMode,
      }));
      return true;
    },
    [panelRefs, replaceRuntime, stageSecondaryModeRestore],
  );

  const openContainer = useCallback(
    (id: SidebarContainerId) => {
      if (temporarilyHiddenRef.current || getSidebarContainer(id).opensPage)
        return false;
      const location = findSidebarContainerLocation(placementsRef.current, id);
      if (
        location === "primary" &&
        runtimeRef.current.secondaryMode === "maximized"
      ) {
        stageSecondaryModeRestore("maximized");
      }
      const deferExpandedPrimaryLayout =
        location === "primary" &&
        runtimeRef.current.secondaryMode === "expanded";
      replaceRuntime((current) => ({
        ...current,
        [location]: {
          ...current[location],
          activeId: id,
          collapsed: false,
        },
        secondaryMode:
          location === "primary" && current.secondaryMode === "maximized"
            ? "normal"
            : current.secondaryMode,
      }));
      if (!deferExpandedPrimaryLayout) revealLocation(location, id);
      return true;
    },
    [replaceRuntime, revealLocation, stageSecondaryModeRestore],
  );

  const toggleContainer = useCallback(
    (id: SidebarContainerId) => {
      if (temporarilyHiddenRef.current || getSidebarContainer(id).opensPage)
        return false;
      const location = findSidebarContainerLocation(placementsRef.current, id);
      const current = runtimeRef.current[location];
      if (
        location === "primary" &&
        runtimeRef.current.secondaryMode === "maximized"
      ) {
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
      if (
        location === "primary" &&
        runtimeRef.current.secondaryMode === "maximized"
      ) {
        const activeId =
          current.activeId ??
          placementsRef.current.primary.find(
            (id) => !getSidebarContainer(id).opensPage,
          ) ??
          null;
        return activeId ? openContainer(activeId) : false;
      }
      if (!current.collapsed) {
        return closeLocation(location);
      }
      const activeId =
        current.activeId ??
        placementsRef.current[location].find(
          (id) => !getSidebarContainer(id).opensPage,
        ) ??
        null;
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
      pendingRestoreLayoutRef.current = null;
      const movedRuntime = runtimeAfterSidebarContainerMove(
        runtimeRef.current,
        currentPlacements,
        nextPlacements,
        id,
        targetLocation,
        placementStateRef.current.activityBar.hiddenContainerIds,
      );
      if (movedRuntime.secondaryMode !== "normal") {
        stageSecondaryModeRestore(movedRuntime.secondaryMode);
      }
      const nextRuntime =
        movedRuntime.secondaryMode !== "normal"
          ? { ...movedRuntime, secondaryMode: "normal" as const }
          : movedRuntime;
      replaceRuntime(() => nextRuntime);

      if (nextRuntime[sourceLocation].collapsed) {
        panelRefs[sourceLocation].current?.collapse();
      }
      revealLocation(targetLocation, id);
    },
    [
      commitPlacementState,
      panelRefs,
      replaceRuntime,
      revealLocation,
      stageSecondaryModeRestore,
    ],
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
      if (
        runtimeRef.current.secondaryMode !== "normal" &&
        nextRuntime.secondaryMode === "normal"
      ) {
        stageSecondaryModeRestore(runtimeRef.current.secondaryMode);
      }
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
      stageSecondaryModeRestore,
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
    if (
      temporarilyHiddenRef.current ||
      runtimeRef.current.secondaryMode !== "normal"
    ) {
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
        (runtime.secondaryMode !== "maximized" || location === "secondary") &&
        runtime[location].activeId === id &&
        !runtime[location].collapsed
      );
    },
    [placementState.placements, runtime, temporarilyHidden],
  );

  useLayoutEffect(() => {
    const nextPresentation = {
      temporarilyHidden,
      secondaryMode: runtime.secondaryMode,
      expandedPrimaryCollapsed:
        runtime.secondaryMode === "expanded"
          ? runtime.primary.collapsed
          : null,
    };
    const previous = previousPresentationRef.current;
    if (
      previous.temporarilyHidden === nextPresentation.temporarilyHidden &&
      previous.secondaryMode === nextPresentation.secondaryMode &&
      previous.expandedPrimaryCollapsed ===
        nextPresentation.expandedPrimaryCollapsed
    ) {
      return;
    }
    previousPresentationRef.current = nextPresentation;
    if (temporarilyHidden) {
      secondaryModeLayoutVersionRef.current += 1;
      if (previous.secondaryMode !== "normal") {
        // 与退出聚焦模式同批进入禅模式时，等待动态约束更新后再让工作区独占布局。
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
    } else if (runtime.secondaryMode !== "normal") {
      applySecondaryModeLayout(runtime.secondaryMode);
    } else {
      const restoreVersion = ++secondaryModeLayoutVersionRef.current;
      const capturedLayout = pendingRestoreLayoutRef.current;
      pendingRestoreLayoutRef.current = null;
      const restore = () => {
        if (capturedLayout) {
          workbenchGroupRef.current?.setLayout(capturedLayout);
          if (runtimeRef.current.primary.collapsed) {
            panelRefs.primary.current?.collapse();
          } else if ((capturedLayout["primary-sidebar"] ?? 0) <= 0) {
            revealLocation("primary");
          }
        } else {
          restoreRuntimeLayout(runtimeRef.current);
        }
        preSecondaryModeLayoutRef.current = null;
        if (restoringSecondaryModeRef.current !== null) {
          queueMicrotask(() => {
            if (runtimeRef.current.secondaryMode === "normal") {
              updateRestoringSecondaryMode(null);
            }
          });
        }
      };
      if (
        !previous.temporarilyHidden &&
        previous.secondaryMode === "normal" &&
        !capturedLayout
      ) {
        restore();
        return;
      }

      if (
        !previous.temporarilyHidden &&
        restoringSecondaryModeRef.current !== null
      ) {
        queueMicrotask(() => {
          if (
            secondaryModeLayoutVersionRef.current === restoreVersion &&
            runtimeRef.current.secondaryMode === "normal" &&
            !temporarilyHiddenRef.current
          ) {
            restore();
          }
        });
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
    applySecondaryModeLayout,
    panelRefs,
    revealLocation,
    restoreRuntimeLayout,
    runtime.primary.collapsed,
    runtime.secondaryMode,
    temporarilyHidden,
    updateRestoringSecondaryMode,
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
      if (
        runtimeRef.current.secondaryMode !== "normal" &&
        nextRuntime.secondaryMode === "normal"
      ) {
        stageSecondaryModeRestore(runtimeRef.current.secondaryMode);
      }
      replaceRuntime(() => nextRuntime);
      requestAnimationFrame(() => {
        if (
          temporarilyHiddenRef.current ||
          runtimeRef.current !== nextRuntime
        ) {
          return;
        }
        if (nextRuntime.secondaryMode !== "normal") {
          applySecondaryModeLayout(nextRuntime.secondaryMode);
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
    applySecondaryModeLayout,
    effectiveHiddenIds,
    replaceRuntime,
    restoreRuntimeLayout,
    stageSecondaryModeRestore,
  ]);

  useEffect(() => {
    const nextRuntime = normalizeSidebarRuntimeState(
      runtimeRef.current,
      placementStateRef.current.placements,
      effectiveHiddenIds(
        placementStateRef.current.activityBar.hiddenContainerIds,
      ),
    );
    if (
      runtimeRef.current.secondaryMode !== "normal" &&
      nextRuntime.secondaryMode === "normal"
    ) {
      stageSecondaryModeRestore(runtimeRef.current.secondaryMode);
    }
    replaceRuntime(() => nextRuntime);
  }, [effectiveHiddenIds, replaceRuntime, stageSecondaryModeRestore]);

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
    restoringSecondaryMode,
    initialRuntime,
    workbenchGroupRef,
    panelRefs,
    openContainer,
    toggleContainer,
    toggleLocation,
    setSecondaryMode,
    toggleSecondaryMode,
    restoreSecondaryModeForContainer,
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
